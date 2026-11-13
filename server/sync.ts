import type { FastifyInstance } from 'fastify';
import { all, get, run, now, tx, camelAll, camel } from './db.ts';
import { cfg, onConfigChange } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, intParam, ok } from './http.ts';
import { fetchForumPage, fetchThreadPage, ThreadGoneError, type ListedThread, type ParsedPost } from './source/xenforo.ts';
import { requireSudo } from './auth.ts';
import { telegram } from './notify.ts';
import { sleep } from './net.ts';
import { normalizeText, reconcileDeletions, type ReconcileSkip } from './archive.ts';

type SyncType = 'posts' | 'comments';

/* ---------------- persistence helpers ---------------- */

export function ensureForum(id: number, name?: string) {
  const fname = name ?? cfg().source.forums.find((f) => f.id === id)?.name ?? `Forum ${id}`;
  run('INSERT INTO forum(id, name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name', id, fname);
}

/** Returns 'new' | 'updated' | null (unchanged) and the reply delta. */
export function upsertThread(t: ListedThread, forumId: number): { action: 'new' | 'updated' | null; delta: number } {
  const ex = get<{ title: string; comment_count: number; last_post_at: string | null; is_deleted: number }>(
    'SELECT title, comment_count, last_post_at, is_deleted FROM thread WHERE id=?',
    t.id,
  );
  if (!ex) {
    run(
      `INSERT INTO thread(id, forum_id, title, title_lc, author, url, created_at, last_post_at, comment_count, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      t.id,
      forumId,
      t.title,
      t.title.toLowerCase(),
      t.author,
      t.url,
      t.createdAt,
      t.lastPostAt,
      t.replies,
      now(),
    );
    return { action: 'new', delta: t.replies };
  }
  if (ex.title === t.title && ex.comment_count === t.replies && ex.last_post_at === t.lastPostAt && !ex.is_deleted) {
    return { action: null, delta: 0 };
  }
  run(
    `UPDATE thread SET title=?, title_lc=?, forum_id=?, url=?, last_post_at=?, comment_count=?, is_deleted=0, updated_at=? WHERE id=?`,
    t.title,
    t.title.toLowerCase(),
    forumId,
    t.url,
    t.lastPostAt,
    t.replies,
    now(),
    t.id,
  );
  return { action: 'updated', delta: t.replies - ex.comment_count };
}

/**
 * Upserts posts of a thread page into the comment store. A changed text keeps the earlier version
 * in comment_revision (whitespace-only changes do not count); a post seen again loses any
 * "deleted on the forum" mark.
 */
export function upsertComments(threadId: number, page: number, posts: ParsedPost[]): { added: number; edited: number } {
  let added = 0;
  let edited = 0;
  for (const p of posts) {
    const id = p.postId || threadId * 100000 + p.postNo;
    const at = now();
    const ex = get<{ content: string; updated_at: string }>('SELECT content, updated_at FROM comment WHERE id=?', id);
    if (!ex) {
      run(
        `INSERT INTO comment(id, thread_id, post_no, page, author, content, content_lc, created_at, url, updated_at, edited_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        threadId,
        p.postNo,
        page,
        p.author,
        p.text,
        p.text.toLowerCase(),
        p.createdAt,
        p.url,
        at,
        p.editedAt,
      );
      added++;
      continue;
    }
    if (ex.content !== p.text) {
      const isEdit = normalizeText(ex.content) !== normalizeText(p.text);
      if (isEdit) {
        run('INSERT INTO comment_revision(comment_id, content, captured_at, replaced_at) VALUES(?,?,?,?)', id, ex.content, ex.updated_at, at);
        edited++;
      }
      run(
        'UPDATE comment SET content=?, content_lc=?, edit_count=edit_count+?, updated_at=? WHERE id=?',
        p.text,
        p.text.toLowerCase(),
        isEdit ? 1 : 0,
        at,
        id,
      );
    }
    run(
      `UPDATE comment SET page=?, deleted_at=NULL, edited_at=COALESCE(?, edited_at)
       WHERE id=? AND (page<>? OR deleted_at IS NOT NULL OR (? IS NOT NULL AND edited_at IS NOT ?))`,
      page,
      p.editedAt,
      id,
      page,
      p.editedAt,
      p.editedAt,
    );
  }
  run('UPDATE thread SET synced_comment_count=(SELECT COUNT(*) FROM comment WHERE thread_id=?) WHERE id=?', threadId, threadId);
  return { added, edited };
}

function startHistory(type: SyncType, trigger: string, forum: number, forumName: string) {
  return Number(
    run('INSERT INTO sync_history(type, trigger, forum, forum_name, sync_started_at) VALUES(?,?,?,?,?)', type, trigger, forum, forumName, now())
      .lastInsertRowid,
  );
}
function finishHistory(id: number, count: number, error?: string) {
  run('UPDATE sync_history SET sync_count=?, sync_finished_at=?, error=? WHERE id=?', count, now(), error ?? null, id);
}
function addItem(historyId: number, threadId: number, title: string, author: string, action: string, delta: number) {
  run(
    'INSERT INTO sync_history_item(history_id, thread_id, title, author, action, comment_delta) VALUES(?,?,?,?,?,?)',
    historyId,
    threadId,
    title,
    author,
    action,
    delta,
  );
}

/* ---------------- core runners ---------------- */

export interface RunCtx {
  trigger: 'auto' | 'manual';
  shouldStop: () => boolean;
  onPage?: (info: { forum: number; forumName: string; page: number; totalPages: number; synced: number }) => void;
  onSaving?: (n: number) => void;
  log?: (line: string) => void;
  batchSize?: number;
  /** Page reader; defaults to the live forum (tests pass a fake). */
  fetchPage?: typeof fetchThreadPage;
}

async function syncPostsForum(forum: { id: number; name: string }, from: number, to: number | 'all', ctx: RunCtx) {
  ensureForum(forum.id, forum.name);
  const hid = startHistory('posts', ctx.trigger, forum.id, forum.name);
  let count = 0;
  const buffer: ListedThread[] = [];
  const flush = () => {
    if (!buffer.length) return;
    ctx.onSaving?.(buffer.length);
    tx(() => {
      for (const t of buffer) {
        const r = upsertThread(t, forum.id);
        if (r.action) {
          addItem(hid, t.id, t.title, t.author, r.action, r.delta);
          count++;
        }
      }
    });
    buffer.length = 0;
  };
  try {
    let page = from;
    let total = to === 'all' ? Infinity : to;
    while (page <= total && !ctx.shouldStop()) {
      const r = await fetchForumPage(forum.id, page);
      if (to === 'all') total = r.totalPages;
      else total = Math.min(to, r.totalPages);
      buffer.push(...r.threads);
      if (buffer.length >= (ctx.batchSize ?? 1)) flush();
      ctx.onPage?.({ forum: forum.id, forumName: forum.name, page, totalPages: total, synced: count + buffer.length });
      ctx.log?.(`[${forum.name}] trang ${page}/${total}: ${r.threads.length} bài`);
      page++;
      if (cfg().scraper.batchDelayMs) await sleep(cfg().scraper.batchDelayMs);
    }
    flush();
    finishHistory(hid, count);
    return count;
  } catch (e) {
    flush();
    finishHistory(hid, count, (e as Error).message);
    throw e;
  }
}

/**
 * First comment page to read for a thread: where the local copy ends, moved back by
 * `recheckPages` stored pages so recent edits and deletions are seen.
 */
export function commentSyncStartPage(o: { syncedCount: number; perPage: number; storedMaxPage: number; recheckPages: number }) {
  const forward = Math.floor(o.syncedCount / o.perPage) + 1;
  if (o.recheckPages <= 0 || o.storedMaxPage <= 0) return forward;
  return Math.max(1, Math.min(forward, o.storedMaxPage - o.recheckPages + 1));
}

const SKIP_REASON: Record<Exclude<ReconcileSkip, null>, string> = {
  'empty-page': 'có trang trả về không có bài nào',
  'missing-id': 'có bài không đọc được ID',
  'too-many': 'quá nhiều bình luận cùng biến mất, có thể do lỗi đọc trang',
};

/**
 * Re-reads the last stored pages of a thread, then fetches up to `maxPages` new ones.
 * Stored pages do not count toward `maxPages`.
 */
export async function syncThreadComments(threadId: number, maxPages: number, ctx: RunCtx) {
  const out: { added: number; edited: number; deleted: number; skipped: ReconcileSkip } = { added: 0, edited: 0, deleted: 0, skipped: null };
  const t = get<{ comment_count: number; synced_comment_count: number }>('SELECT comment_count, synced_comment_count FROM thread WHERE id=?', threadId);
  if (!t) return out;
  const fetchPage = ctx.fetchPage ?? fetchThreadPage;
  const per = cfg().source.postsPerPage;
  const storedMaxPage = get<{ p: number | null }>('SELECT MAX(page) p FROM comment WHERE thread_id=?', threadId)!.p ?? 0;
  const start = commentSyncStartPage({
    syncedCount: t.synced_comment_count,
    perPage: per,
    storedMaxPage,
    recheckPages: cfg().sync.comments.recheckPages,
  });
  let page = start;
  let newPages = 0;
  let totalPages = Math.max(1, Math.ceil((t.comment_count + 1) / per), storedMaxPage);
  const read: ParsedPost[][] = [];
  while (page <= totalPages && !ctx.shouldStop()) {
    const isNew = page > storedMaxPage;
    if (isNew && newPages >= maxPages) break;
    try {
      const r = await fetchPage(threadId, page);
      totalPages = r.totalPages;
      const n = tx(() => upsertComments(threadId, page, r.posts));
      out.added += n.added;
      out.edited += n.edited;
      read.push(r.posts);
      ctx.onSaving?.(r.posts.length);
    } catch (e) {
      if (e instanceof ThreadGoneError) {
        run('UPDATE thread SET is_deleted=1, updated_at=? WHERE id=?', now(), threadId);
        ctx.log?.(`Bài ${threadId} không còn trên diễn đàn (HTTP ${e.status}) — giữ bản lưu trữ.`);
        return out;
      }
      throw e;
    }
    if (isNew) newPages++;
    page++;
    if (cfg().scraper.batchDelayMs) await sleep(cfg().scraper.batchDelayMs);
  }
  if (read.length) {
    const lastRead = start + read.length - 1;
    const r = tx(() => reconcileDeletions(threadId, read, { startsAtFirstPage: start === 1, endsAtLastPage: lastRead >= totalPages }));
    out.deleted = r.deleted;
    out.skipped = r.skipped;
    if (r.skipped) ctx.log?.(`Bài ${threadId}: bỏ qua kiểm tra bình luận bị xóa (${SKIP_REASON[r.skipped]}).`);
  }
  return out;
}

export async function syncCommentsForum(
  forum: { id: number; name: string },
  threadIds: number[],
  pagesPerThread: number,
  ctx: RunCtx,
) {
  ensureForum(forum.id, forum.name);
  const hid = startHistory('comments', ctx.trigger, forum.id, forum.name);
  let count = 0;
  try {
    let i = 0;
    for (const id of threadIds) {
      if (ctx.shouldStop()) break;
      i++;
      const n = await syncThreadComments(id, pagesPerThread, ctx);
      if (n.added || n.edited || n.deleted || n.skipped) {
        const t = get<{ title: string; author: string }>('SELECT title, author FROM thread WHERE id=?', id)!;
        if (n.added) addItem(hid, id, t.title, t.author, 'comments', n.added);
        if (n.edited) addItem(hid, id, t.title, t.author, 'edited', n.edited);
        if (n.deleted) addItem(hid, id, t.title, t.author, 'deleted', n.deleted);
        // The deletion check could not run safely: say so, so a quiet log does not read as "nothing deleted".
        if (n.skipped) addItem(hid, id, t.title, t.author, 'check-skipped', 0);
        count += n.added;
      }
      ctx.onPage?.({ forum: forum.id, forumName: forum.name, page: i, totalPages: threadIds.length, synced: count });
      ctx.log?.(
        `[${forum.name}] bài ${id}: +${n.added} bình luận${n.edited ? `, ~${n.edited} sửa` : ''}${n.deleted ? `, −${n.deleted} xóa` : ''} (${i}/${threadIds.length})`,
      );
    }
    finishHistory(hid, count);
    return count;
  } catch (e) {
    finishHistory(hid, count, (e as Error).message);
    throw e;
  }
}

/** Threads with comments still to fetch, plus recently active ones whose last pages get re-read. */
export function threadsNeedingComments(forumId: number, limit: number, at = new Date()) {
  const c = cfg().sync.comments;
  const since = new Date(at.getTime() - c.recheckWithinHours * 3600_000).toISOString();
  return all<{ id: number }>(
    `SELECT id FROM thread WHERE forum_id=? AND is_deleted=0
       AND (synced_comment_count < comment_count + 1 OR (? > 0 AND last_post_at >= ?))
     ORDER BY (synced_comment_count < comment_count + 1) DESC, last_post_at DESC LIMIT ?`,
    forumId,
    c.recheckPages,
    since,
    limit,
  ).map((r) => r.id);
}

/* ---------------- auto sync scheduler ---------------- */

const autoRunning: Record<SyncType, boolean> = { posts: false, comments: false };
const timers: Partial<Record<SyncType, NodeJS.Timeout>> = {};
const lastAuto: Record<SyncType, { at: string | null; error: string | null }> = {
  posts: { at: null, error: null },
  comments: { at: null, error: null },
};

export async function runAutoSync(type: SyncType) {
  if (autoRunning[type] || (manual.running && manual.type === type)) return;
  autoRunning[type] = true;
  const ctx: RunCtx = { trigger: 'auto', shouldStop: () => false, batchSize: 50 };
  let total = 0;
  try {
    for (const f of cfg().source.forums) {
      if (type === 'posts') total += await syncPostsForum(f, 1, cfg().sync.posts.pagesPerRun, ctx);
      else
        total += await syncCommentsForum(
          f,
          threadsNeedingComments(f.id, cfg().sync.comments.maxThreadsPerRun),
          cfg().sync.comments.pagesPerRun,
          ctx,
        );
    }
    lastAuto[type] = { at: now(), error: null };
    emit(Ev.AutoSyncFinished, { type, count: total, finishedAt: lastAuto[type].at });
  } catch (e) {
    lastAuto[type] = { at: now(), error: (e as Error).message };
    if (cfg().telegram.notifySyncFailed) void telegram(`Glean: đồng bộ tự động (${type}) lỗi — ${(e as Error).message}`);
  } finally {
    autoRunning[type] = false;
  }
}

function schedule(type: SyncType) {
  clearTimeout(timers[type]);
  const c = cfg().sync[type];
  if (!c.enabled) return;
  timers[type] = setTimeout(async () => {
    await runAutoSync(type);
    schedule(type);
  }, Math.max(15_000, c.intervalMs));
  timers[type]!.unref?.();
}

export function initAutoSync() {
  // first pass shortly after boot so a fresh install has data to search
  setTimeout(async () => {
    if (cfg().sync.posts.enabled) await runAutoSync('posts');
    if (cfg().sync.comments.enabled) await runAutoSync('comments');
  }, 1500).unref();
  schedule('posts');
  schedule('comments');
  onConfigChange((c, prev) => {
    if (JSON.stringify(c.sync.posts) !== JSON.stringify(prev.sync.posts)) schedule('posts');
    if (JSON.stringify(c.sync.comments) !== JSON.stringify(prev.sync.comments)) schedule('comments');
  });
}

/* ---------------- manual sync ---------------- */

interface ManualOptions {
  type: SyncType;
  allPages: boolean;
  pageFrom: number;
  pageTo: number;
  batchSize: number;
  forums: number[];
}

const manual = {
  running: false,
  stopRequested: false,
  type: 'posts' as SyncType,
  options: null as ManualOptions | null,
  forum: null as number | null,
  forumName: '',
  currentPage: 0,
  totalPages: 0,
  totalSynced: 0,
  saving: 0,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  result: null as null | 'completed' | 'stopped' | 'failed',
  error: null as string | null,
  logs: [] as { at: string; line: string }[],
};

function manualStatus() {
  const { stopRequested, ...rest } = manual;
  const elapsedSeconds = manual.startedAt
    ? Math.round(((manual.finishedAt ? Date.parse(manual.finishedAt) : Date.now()) - Date.parse(manual.startedAt)) / 1000)
    : 0;
  return { ...rest, stopRequested, elapsedSeconds };
}

function mlog(line: string) {
  manual.logs.push({ at: now(), line });
  if (manual.logs.length > 300) manual.logs.splice(0, manual.logs.length - 300);
}

let lastEmit = 0;
function progress(force = false) {
  if (!force && Date.now() - lastEmit < 250) return;
  lastEmit = Date.now();
  emit(Ev.ManualSyncProgress, { ...manualStatus(), logs: manual.logs.slice(-12) }, undefined, 'manual-sync');
}

async function runManual(o: ManualOptions) {
  const forums = o.forums.length ? cfg().source.forums.filter((f) => o.forums.includes(f.id)) : cfg().source.forums;
  const ctx: RunCtx = {
    trigger: 'manual',
    shouldStop: () => manual.stopRequested,
    batchSize: o.batchSize,
    onPage: (p) => {
      manual.forum = p.forum;
      manual.forumName = p.forumName;
      manual.currentPage = p.page;
      manual.totalPages = p.totalPages;
      manual.saving = 0;
      progress();
    },
    onSaving: (n) => {
      manual.saving = n;
      progress();
    },
    log: (l) => mlog(l),
  };
  try {
    for (const f of forums) {
      if (manual.stopRequested) break;
      manual.forum = f.id;
      manual.forumName = f.name;
      mlog(`Bắt đầu ${o.type === 'posts' ? 'bài viết' : 'bình luận'} — ${f.name}`);
      if (o.type === 'posts') {
        const n = await syncPostsForum(f, o.allPages ? 1 : o.pageFrom, o.allPages ? 'all' : o.pageTo, ctx);
        manual.totalSynced += n;
      } else {
        let ids: number[];
        if (o.allPages) {
          ids = all<{ id: number }>('SELECT id FROM thread WHERE forum_id=? AND is_deleted=0 ORDER BY last_post_at DESC', f.id).map((r) => r.id);
        } else {
          const seen = new Set<number>();
          for (let p = o.pageFrom; p <= o.pageTo && !manual.stopRequested; p++) {
            const r = await fetchForumPage(f.id, p);
            tx(() => r.threads.forEach((t) => upsertThread(t, f.id)));
            r.threads.forEach((t) => seen.add(t.id));
            if (p >= r.totalPages) break;
          }
          ids = [...seen];
        }
        const n = await syncCommentsForum(f, ids, Number.MAX_SAFE_INTEGER, ctx);
        manual.totalSynced += n;
      }
      progress(true);
    }
    manual.result = manual.stopRequested ? 'stopped' : 'completed';
    mlog(manual.stopRequested ? 'Đã dừng theo yêu cầu.' : `Hoàn tất: ${manual.totalSynced} bản ghi.`);
    manual.finishedAt = now();
    emit(Ev.ManualSyncComplete, manualStatus(), undefined, 'manual-sync');
  } catch (e) {
    manual.result = 'failed';
    manual.error = (e as Error).message;
    manual.finishedAt = now();
    mlog(`Lỗi: ${manual.error}`);
    emit(Ev.ManualSyncFailed, manualStatus(), manual.error, 'manual-sync');
    if (cfg().telegram.notifySyncFailed) void telegram(`Glean: đồng bộ thủ công lỗi — ${manual.error}`);
  } finally {
    manual.running = false;
    manual.stopRequested = false;
  }
}

/* ---------------- routes ---------------- */

export function registerSync(app: FastifyInstance) {
  const list = (type: SyncType) => async (req: any) => {
    const page = intParam(req.query.page, 1);
    const size = intParam(req.query.size, 20, 1, 100);
    const rows = all(
      `SELECT id, type, trigger, forum, forum_name, sync_count, sync_started_at, sync_finished_at, error
       FROM sync_history WHERE type=? ORDER BY id DESC LIMIT ? OFFSET ?`,
      type,
      size,
      (page - 1) * size,
    );
    const total = get<{ n: number }>('SELECT COUNT(*) n FROM sync_history WHERE type=?', type)!.n;
    return ok(camelAll(rows), { total, page, pageSize: size });
  };
  app.get('/api/sync-histories/posts', list('posts'));
  app.get('/api/sync-histories/comments', list('comments'));
  app.get('/api/sync-histories/posts/count', async () => ok(get<{ n: number }>("SELECT COUNT(*) n FROM sync_history WHERE type='posts'")!.n));
  app.get('/api/sync-histories/comments/count', async () =>
    ok(get<{ n: number }>("SELECT COUNT(*) n FROM sync_history WHERE type='comments'")!.n),
  );

  const items = async (req: any) => {
    const id = Number(req.params.id);
    const h = get('SELECT * FROM sync_history WHERE id=?', id);
    if (!h) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lần đồng bộ này.');
    const page = intParam(req.query.page, 1);
    const size = intParam(req.query.size, 50, 1, 200);
    const rows = all(
      `SELECT i.id, i.thread_id, i.title, i.author, i.action, i.comment_delta, t.url, t.is_deleted
       FROM sync_history_item i LEFT JOIN thread t ON t.id=i.thread_id WHERE i.history_id=? ORDER BY i.id LIMIT ? OFFSET ?`,
      id,
      size,
      (page - 1) * size,
    );
    const total = get<{ n: number }>('SELECT COUNT(*) n FROM sync_history_item WHERE history_id=?', id)!.n;
    return ok({ history: camel(h), items: camelAll(rows) }, { total, page, pageSize: size });
  };
  app.get('/api/sync-histories/posts/:id/items', items);
  app.get('/api/sync-histories/comments/:id/items', items);

  app.get('/api/sync/auto-status', async () =>
    ok({
      posts: { ...lastAuto.posts, running: autoRunning.posts, enabled: cfg().sync.posts.enabled, intervalMs: cfg().sync.posts.intervalMs },
      comments: { ...lastAuto.comments, running: autoRunning.comments, enabled: cfg().sync.comments.enabled, intervalMs: cfg().sync.comments.intervalMs },
    }),
  );
  app.post<{ Params: { type: SyncType } }>('/api/sync/auto/:type/run-now', async (req) => {
    const type = req.params.type === 'comments' ? 'comments' : 'posts';
    void runAutoSync(type);
    return ok(true);
  });

  app.get('/api/manual-syncs/status', async () => ok(manualStatus()));

  app.post<{ Body: Partial<ManualOptions> }>('/api/manual-syncs/start', async (req) => {
    requireSudo(req);
    if (manual.running) throw new ApiError(409, 'ALREADY_RUNNING', 'Đang có một lượt đồng bộ thủ công chạy.', 'inline');
    const b = req.body ?? {};
    const o: ManualOptions = {
      type: b.type === 'comments' ? 'comments' : 'posts',
      allPages: !!b.allPages,
      pageFrom: intParam(b.pageFrom, 1),
      pageTo: intParam(b.pageTo, 1),
      batchSize: intParam(b.batchSize, 100, 1, 5000),
      forums: Array.isArray(b.forums) ? b.forums.map(Number).filter(Boolean) : [],
    };
    if (!o.allPages && o.pageTo < o.pageFrom) throw new ApiError(400, 'INVALID_RANGE', 'Trang kết thúc phải lớn hơn hoặc bằng trang bắt đầu.', 'inline');
    Object.assign(manual, {
      running: true,
      stopRequested: false,
      type: o.type,
      options: o,
      forum: null,
      forumName: '',
      currentPage: 0,
      totalPages: 0,
      totalSynced: 0,
      saving: 0,
      startedAt: now(),
      finishedAt: null,
      result: null,
      error: null,
      logs: [],
    });
    void runManual(o);
    progress(true);
    return ok(manualStatus());
  });

  app.post('/api/manual-syncs/stop', async (req) => {
    requireSudo(req);
    if (!manual.running) return ok(manualStatus());
    manual.stopRequested = true;
    mlog('Đang dừng…');
    progress(true);
    return ok(manualStatus());
  });
}
