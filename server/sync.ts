import type { FastifyInstance, FastifyRequest } from 'fastify';
import { all, get, run, now, tx, camelAll, camel } from './db.ts';
import { cfg, forgetSiteConfig, onConfigChange } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, intParam, ok } from './http.ts';
import { fetchForumPage, fetchThreadPage, ThreadGoneError, type ListedThread, type ParsedPost } from './source/xenforo.ts';
import { requireSudo } from './auth.ts';
import { telegram } from './notify.ts';
import { pool, sleep } from './net.ts';
import { normalizeText, reconcileDeletions, type ReconcileSkip } from './archive.ts';
import { biOf, pack, type Bi } from './bilingual.ts';
import { currentSite, onSiteAdded, onSiteRemoved, siteByCode, sites, withSite } from './site.ts';

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
      `INSERT INTO thread(id, forum_id, title, title_lc, author, url, created_at, last_post_at, comment_count, view_count, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      t.id,
      forumId,
      t.title,
      t.title.toLowerCase(),
      t.author,
      t.url,
      t.createdAt,
      t.lastPostAt,
      t.replies,
      t.views ?? 0,
      now(),
    );
    return { action: 'new', delta: t.replies };
  }
  if (ex.title === t.title && ex.comment_count === t.replies && ex.last_post_at === t.lastPostAt && !ex.is_deleted) {
    // Views change all the time: keep them current without counting the thread as updated.
    run('UPDATE thread SET view_count=? WHERE id=? AND view_count<>?', t.views ?? 0, t.id, t.views ?? 0);
    return { action: null, delta: 0 };
  }
  run(
    `UPDATE thread SET title=?, title_lc=?, forum_id=?, url=?, last_post_at=?, comment_count=?, view_count=?, is_deleted=0, updated_at=? WHERE id=?`,
    t.title,
    t.title.toLowerCase(),
    forumId,
    t.url,
    t.lastPostAt,
    t.replies,
    t.views ?? 0,
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
export function upsertComments(threadId: number, page: number, posts: ParsedPost[]): { added: number; edited: number; liked: number } {
  let added = 0;
  let edited = 0;
  let liked = 0; // stored comments whose like count changed
  for (const p of posts) {
    const id = p.postId || threadId * 100000 + p.postNo;
    const at = now();
    const ex = get<{ content: string; updated_at: string }>('SELECT content, updated_at FROM comment WHERE id=?', id);
    if (!ex) {
      run(
        `INSERT INTO comment(id, thread_id, post_no, page, author, content, content_lc, created_at, url, updated_at, edited_at, like_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        p.likes ?? 0,
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
    liked += Number(run('UPDATE comment SET like_count=? WHERE id=? AND like_count<>?', p.likes ?? 0, id, p.likes ?? 0).changes);
  }
  run(
    `UPDATE thread SET synced_comment_count=(SELECT COUNT(*) FROM comment WHERE thread_id=?),
       like_count=(SELECT COALESCE(SUM(like_count), 0) FROM comment WHERE thread_id=?) WHERE id=?`,
    threadId,
    threadId,
    threadId,
  );
  return { added, edited, liked };
}

function startHistory(type: SyncType, trigger: string, forum: number, forumName: string) {
  return Number(
    run('INSERT INTO sync_history(type, trigger, forum, forum_name, sync_started_at) VALUES(?,?,?,?,?)', type, trigger, forum, forumName, now())
      .lastInsertRowid,
  );
}
function finishHistory(id: number, count: number, error?: Bi) {
  run('UPDATE sync_history SET sync_count=?, sync_finished_at=?, error=? WHERE id=?', count, now(), error ? pack(error) : null, id);
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
  log?: (line: Bi) => void;
  batchSize?: number;
  /** Page reader; defaults to the live forum (tests pass a fake). */
  fetchPage?: typeof fetchThreadPage;
  /** Forum list page reader; defaults to the live forum (tests pass a fake). */
  fetchListPage?: typeof fetchForumPage;
  /** Comments: read every page from page 1, e.g. to fill in like counts of an older archive. */
  fromFirstPage?: boolean;
  /** Manual runs: pause between tries while the forum looks down (tests pass a short one). */
  outageWaitMs?: number;
}

/** Failed pages (or threads) in a row before a run gives up: the forum is then likely down, not just slow. */
const MAX_FAILURES_IN_A_ROW = 3;
/** A manual run then waits and tries again this many times (about 15 minutes) before it gives up. */
const OUTAGE_TRIES = 15;
const OUTAGE_WAIT_MS = 60_000;

/** Sleeps, but wakes early when the run is asked to stop. */
async function pauseUnlessStopped(ms: number, ctx: RunCtx) {
  const until = Date.now() + ms;
  while (Date.now() < until && !ctx.shouldStop()) await sleep(Math.min(1000, until - Date.now()));
}

/**
 * Lets a long run step over a page that still fails after fetch retries, instead of losing the
 * whole run to it. Several failures in a row mean the forum is likely down: an auto run rethrows
 * the last one (the next run comes soon anyway); a manual run waits for the forum to answer again,
 * with one step asking while the others wait, and rethrows only when it stays down.
 */
function skipper(ctx: RunCtx) {
  let inRow = 0;
  const skipped: Bi[] = [];
  /** While the forum looks down: resolves true once it answers again, false when the run gives up. */
  let outage: Promise<boolean> | null = null;

  async function waitForForum<T>(label: Bi, step: () => Promise<T>, e: unknown): Promise<T | undefined> {
    const wait = ctx.outageWaitMs ?? OUTAGE_WAIT_MS;
    const secs = Math.round(wait / 1000);
    for (let i = 1; i <= OUTAGE_TRIES; i++) {
      const [vi, en] = biOf(e);
      ctx.log?.([
        `Diễn đàn không phản hồi (${vi}) — chờ ${secs} giây rồi thử lại ${label[0]} (lần ${i}/${OUTAGE_TRIES}).`,
        `The forum is not answering (${en}). Waiting ${secs} s, then trying ${label[1]} again (try ${i}/${OUTAGE_TRIES}).`,
      ]);
      await pauseUnlessStopped(wait, ctx);
      if (ctx.shouldStop()) {
        skipped.push(label);
        return undefined;
      }
      try {
        const v = await step();
        ctx.log?.(['Diễn đàn đã phản hồi lại — chạy tiếp.', 'The forum is answering again. The run goes on.']);
        return v;
      } catch (next) {
        e = next;
      }
    }
    throw e;
  }

  return {
    async run<T>(label: Bi, step: () => Promise<T>): Promise<T | undefined> {
      for (;;) {
        try {
          const v = await step();
          inRow = 0;
          return v;
        } catch (e) {
          // Another step is already waiting for the forum: wait for it, then try this one again.
          if (outage) {
            if (!(await outage)) throw e;
            if (ctx.shouldStop()) {
              skipped.push(label);
              return undefined;
            }
            continue;
          }
          if (++inRow >= MAX_FAILURES_IN_A_ROW) {
            if (ctx.trigger !== 'manual') throw e;
            let answered!: (back: boolean) => void;
            outage = new Promise((r) => (answered = r));
            try {
              const v = await waitForForum(label, step, e);
              inRow = 0;
              answered(true);
              return v;
            } catch (last) {
              answered(false);
              throw last;
            } finally {
              outage = null;
            }
          }
          skipped.push(label);
          const [vi, en] = biOf(e);
          ctx.log?.([`${label[0]}: lỗi — ${vi}. Bỏ qua, chạy tiếp.`, `${label[1]}: error: ${en}. Skipped, the run goes on.`]);
          return undefined;
        }
      }
    },
    /** For the sync log: which steps were skipped, so they can be run again. */
    summary: (): Bi | undefined =>
      skipped.length
        ? [
            `Bỏ qua ${skipped.map((l) => l[0]).join(', ')} vì lỗi — chạy lại để lấy phần này.`,
            `Skipped ${skipped.map((l) => l[1]).join(', ')} because of errors. Run the sync again to fetch this part.`,
          ]
        : undefined,
  };
}

export async function syncPostsForum(forum: { id: number; name: string }, from: number, to: number | 'all', ctx: RunCtx) {
  ensureForum(forum.id, forum.name);
  const hid = startHistory('posts', ctx.trigger, forum.id, forum.name);
  const fetchList = ctx.fetchListPage ?? fetchForumPage;
  const skip = skipper(ctx);
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
      const p = page;
      const r = await skip.run([`[${forum.name}] trang ${p}`, `[${forum.name}] page ${p}`], () => fetchList(forum.id, p));
      if (r) {
        if (to === 'all') total = r.totalPages;
        else total = Math.min(to, r.totalPages);
        buffer.push(...r.threads);
        if (buffer.length >= (ctx.batchSize ?? 1)) flush();
        ctx.onPage?.({ forum: forum.id, forumName: forum.name, page, totalPages: total, synced: count });
        ctx.log?.([`[${forum.name}] trang ${page}/${total}: ${r.threads.length} bài`, `[${forum.name}] page ${page}/${total}: ${r.threads.length} threads`]);
      }
      page++;
      if (cfg().scraper.batchDelayMs) await sleep(cfg().scraper.batchDelayMs);
    }
    flush();
    finishHistory(hid, count, skip.summary());
    return count;
  } catch (e) {
    flush();
    finishHistory(hid, count, biOf(e));
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

/**
 * The page of the thread's last stored comment, 0 with none. It reads one row through the
 * (thread_id, post_no) index: MAX(page) had to read every comment of the thread, which on a
 * thread with tens of thousands of comments held up the server for seconds on each sync.
 */
export function storedLastPage(threadId: number): number {
  return get<{ page: number }>('SELECT page FROM comment WHERE thread_id=? ORDER BY post_no DESC LIMIT 1', threadId)?.page ?? 0;
}

const SKIP_REASON: Record<Exclude<ReconcileSkip, null>, Bi> = {
  'empty-page': ['có trang trả về không có bài nào', 'a page came back with no posts'],
  'missing-id': ['có bài không đọc được ID', 'a post had no readable ID'],
  'too-many': ['quá nhiều bình luận cùng biến mất, có thể do lỗi đọc trang', 'too many comments disappeared at once, possibly a page read error'],
};

/**
 * Re-reads the last stored pages of a thread, then fetches up to `maxPages` new ones.
 * Stored pages do not count toward `maxPages`.
 */
export async function syncThreadComments(threadId: number, maxPages: number, ctx: RunCtx) {
  const out: { added: number; edited: number; liked: number; deleted: number; skipped: ReconcileSkip } = { added: 0, edited: 0, liked: 0, deleted: 0, skipped: null };
  const t = get<{ comment_count: number; synced_comment_count: number }>('SELECT comment_count, synced_comment_count FROM thread WHERE id=?', threadId);
  if (!t) return out;
  const fetchPage = ctx.fetchPage ?? fetchThreadPage;
  const per = cfg().source.postsPerPage;
  const storedMaxPage = storedLastPage(threadId);
  const start = ctx.fromFirstPage
    ? 1
    : commentSyncStartPage({
        syncedCount: t.synced_comment_count,
        perPage: per,
        storedMaxPage,
        recheckPages: cfg().sync.comments.recheckPages,
      });
  let totalPages = Math.max(1, Math.ceil((t.comment_count + 1) / per), storedMaxPage);
  /** Reads and stores one page; null when the thread is gone from the forum. */
  const readPage = async (p: number) => {
    try {
      const r = await fetchPage(threadId, p);
      totalPages = r.totalPages;
      const n = tx(() => upsertComments(threadId, p, r.posts));
      out.added += n.added;
      out.edited += n.edited;
      out.liked += n.liked;
      ctx.onSaving?.(r.posts.length);
      return r.posts;
    } catch (e) {
      if (e instanceof ThreadGoneError) {
        run('UPDATE thread SET is_deleted=1, updated_at=? WHERE id=?', now(), threadId);
        ctx.log?.([
          `Bài ${threadId} không còn trên diễn đàn (HTTP ${e.status}) — giữ bản lưu trữ.`,
          `Thread ${threadId} is no longer on the forum (HTTP ${e.status}); the archived copy is kept.`,
        ]);
        return null;
      }
      throw e;
    }
  };
  // The first post usually collects most of a thread's likes: keep it current on every re-check.
  // It stays out of the deletion check, which needs consecutive pages.
  if (start > 1 && !ctx.shouldStop()) {
    if (!(await readPage(1))) return out;
    if (cfg().scraper.batchDelayMs) await sleep(cfg().scraper.batchDelayMs);
  }
  let page = start;
  let newPages = 0;
  const read: ParsedPost[][] = [];
  while (page <= totalPages && !ctx.shouldStop()) {
    const isNew = page > storedMaxPage;
    if (isNew && newPages >= maxPages) break;
    const posts = await readPage(page);
    if (!posts) return out;
    read.push(posts);
    if (isNew) newPages++;
    page++;
    if (cfg().scraper.batchDelayMs) await sleep(cfg().scraper.batchDelayMs);
  }
  if (read.length) {
    const lastRead = start + read.length - 1;
    const r = tx(() => reconcileDeletions(threadId, read, { startsAtFirstPage: start === 1, endsAtLastPage: lastRead >= totalPages }));
    out.deleted = r.deleted;
    out.skipped = r.skipped;
    if (r.skipped) {
      const [vi, en] = SKIP_REASON[r.skipped];
      ctx.log?.([`Bài ${threadId}: bỏ qua kiểm tra bình luận bị xóa (${vi}).`, `Thread ${threadId}: the check for deleted comments was skipped (${en}).`]);
    }
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
  const skip = skipper(ctx);
  let count = 0;
  try {
    let i = 0;
    // Set when a run gives up; the other workers then stop taking threads before the error is rethrown.
    let failure: { e: unknown } | null = null;
    await pool(threadIds, cfg().sync.comments.concurrentThreads, async (id) => {
      if (failure || ctx.shouldStop()) return;
      let n: Awaited<ReturnType<typeof syncThreadComments>> | undefined;
      try {
        n = await skip.run([`[${forum.name}] bài ${id}`, `[${forum.name}] thread ${id}`], () => syncThreadComments(id, pagesPerThread, ctx));
      } catch (e) {
        failure ??= { e };
        return;
      }
      i++;
      if (!n) return;
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
      ctx.log?.([
        `[${forum.name}] bài ${id}: +${n.added} bình luận${n.liked ? `, ${n.liked} bình luận cập nhật like` : ''}${n.edited ? `, ~${n.edited} sửa` : ''}${n.deleted ? `, −${n.deleted} xóa` : ''} (${i}/${threadIds.length})`,
        `[${forum.name}] thread ${id}: +${n.added} comments${n.liked ? `, ${n.liked} with updated likes` : ''}${n.edited ? `, ~${n.edited} edited` : ''}${n.deleted ? `, −${n.deleted} deleted` : ''} (${i}/${threadIds.length})`,
      ]);
    });
    if (failure) throw (failure as { e: unknown }).e;
    finishHistory(hid, count, skip.summary());
    return count;
  } catch (e) {
    finishHistory(hid, count, biOf(e));
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
    Number.isFinite(limit) ? limit : -1, // -1: no limit
  ).map((r) => r.id);
}

/* ---------------- auto sync scheduler ---------------- */

const idleState = () => ({
  autoRunning: { posts: false, comments: false } as Record<SyncType, boolean>,
  timers: {} as Partial<Record<SyncType, NodeJS.Timeout>>,
  lastAuto: {
    posts: { at: null, error: null },
    comments: { at: null, error: null },
  } as Record<SyncType, { at: string | null; error: string | null }>,
  manual: {
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
  },
  /** When the manual run's progress was last sent. */
  lastEmit: 0,
});

/** Each site's sync state, by site code: its auto runs and timers, and its one manual run. */
const states = new Map<string, ReturnType<typeof idleState>>();
let readForum = fetchForumPage;

function syncState(code = currentSite().code) {
  let st = states.get(code);
  if (!st) states.set(code, (st = idleState()));
  return st;
}

/** False once the current site was removed: a run still going ends, but nothing new starts for it. */
const siteLive = () => siteByCode(currentSite().code) !== undefined;

/** Tests only: the forum list reader of auto and manual syncs. */
export function setForumReader(fn: typeof fetchForumPage): void {
  readForum = fn;
}

/** Tests only: the sync types a site has a timer set for. */
export function syncTimersForTests(code: string): SyncType[] {
  return Object.keys(states.get(code)?.timers ?? {}) as SyncType[];
}

export async function runAutoSync(type: SyncType) {
  const { autoRunning, lastAuto, manual } = syncState();
  if (autoRunning[type] || (manual.running && manual.type === type)) return;
  autoRunning[type] = true;
  const ctx: RunCtx = { trigger: 'auto', shouldStop: () => false, batchSize: 50, fetchListPage: readForum };
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
    const error = biOf(e);
    lastAuto[type] = { at: now(), error: pack(error) };
    if (cfg().telegram.notifySyncFailed) void telegram(`Glean: đồng bộ tự động (${type}) lỗi — ${error[0]}`);
  } finally {
    autoRunning[type] = false;
    // The run read its settings again; those of a removed site are not kept.
    if (!siteLive()) forgetSiteConfig(currentSite().code);
  }
}

/** Sets the timer of the current site; the timer keeps the site, so its runs are that site's. */
export function schedule(type: SyncType) {
  const { timers } = syncState();
  clearTimeout(timers[type]);
  delete timers[type];
  if (!siteLive()) return;
  const c = cfg().sync[type];
  if (!c.enabled) return;
  timers[type] = setTimeout(async () => {
    await runAutoSync(type);
    schedule(type);
  }, Math.max(15_000, c.intervalMs));
  timers[type]!.unref?.();
}

function startAutoSync() {
  // first pass shortly after boot (or after the site is added) so a fresh site has data to search
  setTimeout(async () => {
    if (siteLive() && cfg().sync.posts.enabled) await runAutoSync('posts');
    if (siteLive() && cfg().sync.comments.enabled) await runAutoSync('comments');
  }, 1500).unref();
  schedule('posts');
  schedule('comments');
}

/** Each site syncs on its own timers, in its own context; a site added later starts at once. */
export function initAutoSync() {
  for (const s of sites()) withSite(s, startAutoSync);
  onSiteAdded((s) => withSite(s, startAutoSync));
  onConfigChange((c, prev) => {
    if (JSON.stringify(c.sync.posts) !== JSON.stringify(prev.sync.posts)) schedule('posts');
    if (JSON.stringify(c.sync.comments) !== JSON.stringify(prev.sync.comments)) schedule('comments');
  });
}

// A removed site: its timers are cleared and its manual run is asked to stop. Registered on load,
// not in initAutoSync: a manual run and its state exist without auto sync.
onSiteRemoved((s) => {
  const st = states.get(s.code);
  if (!st) return;
  for (const type of Object.keys(st.timers) as SyncType[]) {
    clearTimeout(st.timers[type]);
    delete st.timers[type];
  }
  withSite(s, stopManual);
});

/* ---------------- manual sync ---------------- */

interface ManualOptions {
  type: SyncType;
  allPages: boolean;
  pageFrom: number;
  pageTo: number;
  batchSize: number;
  forums: number[];
  /** Comments only: skip threads that already have every comment and were not active lately. */
  onlyMissing: boolean;
  /** Comments only: re-read every page from page 1 (fills in likes of an older archive). */
  fromFirstPage: boolean;
}

/** The manual run of the current site. */
export function manualStatus() {
  const { manual } = syncState();
  const { stopRequested, ...rest } = manual;
  const elapsedSeconds = manual.startedAt
    ? Math.round(((manual.finishedAt ? Date.parse(manual.finishedAt) : Date.now()) - Date.parse(manual.startedAt)) / 1000)
    : 0;
  return { ...rest, stopRequested, elapsedSeconds };
}

function mlog(line: Bi) {
  const { manual } = syncState();
  manual.logs.push({ at: now(), line: pack(line) });
  if (manual.logs.length > 300) manual.logs.splice(0, manual.logs.length - 300);
}

function progress(force = false) {
  const st = syncState();
  if (!force && Date.now() - st.lastEmit < 250) return;
  st.lastEmit = Date.now();
  emit(Ev.ManualSyncProgress, { ...manualStatus(), logs: st.manual.logs.slice(-12) }, undefined, 'manual-sync');
}

function stopManual() {
  const { manual } = syncState();
  if (!manual.running) return;
  manual.stopRequested = true;
  mlog(['Đang dừng…', 'Stopping…']);
  progress(true);
}

async function runManual(o: ManualOptions) {
  const { manual } = syncState();
  const forums = o.forums.length ? cfg().source.forums.filter((f) => o.forums.includes(f.id)) : cfg().source.forums;
  let done = 0; // records saved by forums already finished
  const ctx: RunCtx = {
    trigger: 'manual',
    shouldStop: () => manual.stopRequested,
    batchSize: o.batchSize,
    fromFirstPage: o.fromFirstPage,
    fetchListPage: readForum,
    onPage: (p) => {
      manual.forum = p.forum;
      manual.forumName = p.forumName;
      manual.currentPage = p.page;
      manual.totalPages = p.totalPages;
      manual.totalSynced = done + p.synced;
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
      mlog([`Bắt đầu ${o.type === 'posts' ? 'bài viết' : 'bình luận'} — ${f.name}`, `Starting ${o.type === 'posts' ? 'threads' : 'comments'}: ${f.name}`]);
      if (o.type === 'posts') {
        done += await syncPostsForum(f, o.allPages ? 1 : o.pageFrom, o.allPages ? 'all' : o.pageTo, ctx);
      } else {
        let ids: number[];
        if (o.allPages && o.onlyMissing) {
          ids = threadsNeedingComments(f.id, Infinity);
        } else if (o.allPages) {
          ids = all<{ id: number }>('SELECT id FROM thread WHERE forum_id=? AND is_deleted=0 ORDER BY last_post_at DESC', f.id).map((r) => r.id);
        } else {
          const seen = new Set<number>();
          const skip = skipper(ctx);
          for (let p = o.pageFrom; p <= o.pageTo && !manual.stopRequested; p++) {
            const r = await skip.run([`[${f.name}] trang ${p}`, `[${f.name}] page ${p}`], () => readForum(f.id, p));
            if (!r) continue;
            tx(() => r.threads.forEach((t) => upsertThread(t, f.id)));
            r.threads.forEach((t) => seen.add(t.id));
            if (p >= r.totalPages) break;
          }
          ids = [...seen];
          if (o.onlyMissing) {
            const needing = new Set(threadsNeedingComments(f.id, Infinity));
            ids = ids.filter((id) => needing.has(id));
          }
        }
        if (o.onlyMissing) mlog([`[${f.name}] ${ids.length} bài cần tải bình luận.`, `[${f.name}] ${ids.length} threads need their comments fetched.`]);
        done += await syncCommentsForum(f, ids, Number.MAX_SAFE_INTEGER, ctx);
      }
      manual.totalSynced = done;
      progress(true);
    }
    manual.result = manual.stopRequested ? 'stopped' : 'completed';
    mlog(manual.stopRequested ? ['Đã dừng theo yêu cầu.', 'Stopped on request.'] : [`Hoàn tất: ${manual.totalSynced} bản ghi.`, `Done: ${manual.totalSynced} records.`]);
    manual.finishedAt = now();
  } catch (e) {
    const [vi, en] = biOf(e);
    manual.result = 'failed';
    manual.error = pack([vi, en]);
    manual.finishedAt = now();
    mlog([`Lỗi: ${vi}`, `Error: ${en}`]);
    if (cfg().telegram.notifySyncFailed) void telegram(`Glean: đồng bộ thủ công lỗi — ${vi}`);
  } finally {
    manual.running = false;
    manual.stopRequested = false;
    manual.saving = 0;
    // The run read its settings again; those of a removed site are not kept.
    if (!siteLive()) forgetSiteConfig(currentSite().code);
  }
  // sent only now, so the page gets the finished state rather than a "running" one
  if (manual.result === 'failed') emit(Ev.ManualSyncFailed, manualStatus(), manual.error!, 'manual-sync');
  else emit(Ev.ManualSyncComplete, manualStatus(), undefined, 'manual-sync');
}

/* ---------------- routes ---------------- */

export function registerSync(app: FastifyInstance) {
  type PageQuery = { page?: string; size?: string };
  const list = (type: SyncType) => async (req: FastifyRequest<{ Querystring: PageQuery }>) => {
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

  const items = async (req: FastifyRequest<{ Params: { id: string }; Querystring: PageQuery }>) => {
    const id = Number(req.params.id);
    const h = get('SELECT * FROM sync_history WHERE id=?', id);
    if (!h) throw new ApiError(404, 'NOT_FOUND', ['Không tìm thấy lần đồng bộ này.', 'Sync run not found.']);
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

  app.get('/api/sync/auto-status', async () => {
    const { lastAuto, autoRunning } = syncState();
    return ok({
      posts: { ...lastAuto.posts, running: autoRunning.posts, enabled: cfg().sync.posts.enabled, intervalMs: cfg().sync.posts.intervalMs },
      comments: { ...lastAuto.comments, running: autoRunning.comments, enabled: cfg().sync.comments.enabled, intervalMs: cfg().sync.comments.intervalMs },
    });
  });
  app.post<{ Params: { type: SyncType } }>('/api/sync/auto/:type/run-now', async (req) => {
    const type = req.params.type === 'comments' ? 'comments' : 'posts';
    void runAutoSync(type);
    return ok(true);
  });

  app.get('/api/manual-syncs/status', async () => ok(manualStatus()));

  app.post<{ Body: Partial<ManualOptions> }>('/api/manual-syncs/start', async (req) => {
    requireSudo(req);
    const { manual } = syncState();
    if (manual.running) throw new ApiError(409, 'ALREADY_RUNNING', ['Đang có một lượt đồng bộ thủ công chạy.', 'A manual sync is already running.'], 'inline');
    const b = req.body ?? {};
    const o: ManualOptions = {
      type: b.type === 'comments' ? 'comments' : 'posts',
      allPages: !!b.allPages,
      pageFrom: intParam(b.pageFrom, 1),
      pageTo: intParam(b.pageTo, 1),
      batchSize: intParam(b.batchSize, 100, 1, 5000),
      forums: Array.isArray(b.forums) ? b.forums.map(Number).filter(Boolean) : [],
      onlyMissing: !!b.onlyMissing && !b.fromFirstPage,
      fromFirstPage: b.type === 'comments' && !!b.fromFirstPage,
    };
    if (!o.allPages && o.pageTo < o.pageFrom) throw new ApiError(400, 'INVALID_RANGE', ['Trang kết thúc phải lớn hơn hoặc bằng trang bắt đầu.', 'The last page must be the same as or after the first page.'], 'inline');
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
    stopManual();
    return ok(manualStatus());
  });
}
