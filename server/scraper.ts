import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { SQLInputValue } from 'node:sqlite';
import { all, get, run, now, tx, camel, camelAll } from './db.ts';
import { cfg, forgetSiteConfig, onConfigChange } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, assertNotPaused, intParam, ok } from './http.ts';
import { fetchRaw, pool, proxyStatus, checkProxies, sleep } from './net.ts';
import { fetchThreadPage, parseThreadRef, threadUrl, ThreadGoneError, type ParsedPost } from './source/xenforo.ts';
import { ensureForum, upsertComments } from './sync.ts';
import { reconcileDeletions } from './archive.ts';
import { mergeTop, newestFirst } from './merge.ts';
import { telegram } from './notify.ts';
import { BiError, biOf, pack, type Bi } from './bilingual.ts';
import {
  currentSite,
  currentSiteOrNull,
  forEachSite,
  onSiteAdded,
  requestSite,
  siteByCode,
  siteForLink,
  siteInfo,
  siteMediaPrefix,
  siteMediaRoot,
  siteRequired,
  sites,
  withSite,
} from './site.ts';

export const ScrapeStatus = { None: 0, Waiting: 1, Processing: 2, Completed: 3, Failed: 4, NotProcessed: 5 } as const;

/** Where the current site keeps a job's files, and the URL they are served under. */
const scrapeDir = (id: number) => path.join(siteMediaRoot(), 'scrapes', String(id));
const scrapeUrl = (id: number) => `${siteMediaPrefix()}/scrapes/${id}`;

/* ---------------- queue ---------------- */

/** Each site's queue, by site code: one job at a time within a site, the sites side by side. */
const queues = new Map<string, { working: boolean; currentId: number | null }>();
let readThread = fetchThreadPage;

function queueOf(code = currentSite().code) {
  let q = queues.get(code);
  if (!q) queues.set(code, (q = { working: false, currentId: null }));
  return q;
}

/** Tests only: the page reader the queue uses. */
export function setThreadReader(fn: typeof fetchThreadPage): void {
  readThread = fn;
}

/** Starts the queue of the current site, unless it is running. */
export function kick() {
  const site = currentSite();
  if (!queueOf(site.code).working) void withSite(site, () => work(site.code));
}

async function work(code: string) {
  const q = queueOf(code);
  q.working = true;
  try {
    // A removed site's running job ends in its own store, but no other job is started for it.
    while (siteByCode(code) && !cfg().maintenance.scrape.isPaused) {
      const next = get<{ id: number }>('SELECT id FROM scrape WHERE status=? AND is_marked_deleted=0 ORDER BY id LIMIT 1', ScrapeStatus.Waiting);
      if (!next) break;
      q.currentId = next.id;
      await runScrape(next.id, readThread);
      q.currentId = null;
    }
  } finally {
    q.working = false;
    q.currentId = null;
    // Its last job read its settings again; those of a removed site are not kept.
    if (!siteByCode(code)) forgetSiteConfig(code);
  }
}

function summary(id: number) {
  return camel(get('SELECT * FROM scrape WHERE id=?', id));
}

function failScrape(id: number, error: Bi) {
  const s = get<{ started_at: string | null }>('SELECT started_at FROM scrape WHERE id=?', id);
  run(
    'UPDATE scrape SET status=?, error=?, finished_at=?, handling_seconds=? WHERE id=?',
    ScrapeStatus.Failed,
    pack(error),
    now(),
    s?.started_at ? (Date.now() - Date.parse(s.started_at)) / 1000 : null,
    id,
  );
  const sm = summary(id);
  emit(Ev.UpdateScrape, sm, undefined, 'scrape');
  emit(Ev.FinishScrape, sm, pack(error), 'scrape');
  if (cfg().telegram.notifyScrapeFinished) void telegram(`Glean: lượt sàng #${id} thất bại — ${error[0]}`);
}

const isCancelled = (id: number) => !!get<{ x: number }>('SELECT 1 x FROM scrape WHERE id=? AND (is_marked_deleted=1 OR status<>?)', id, ScrapeStatus.Processing);

class Cancelled extends Error {}

const ITEM_TABLES = ['scrape_image', 'scrape_video', 'scrape_link', 'scrape_comment'] as const;
type ItemTable = (typeof ITEM_TABLES)[number];

/**
 * Inserts an item of a sieve job, or refreshes the one already kept from an earlier run.
 * Items are matched by `key` within the same post (post id, or #n for rows saved without one).
 */
function upsertItem(
  table: ItemTable,
  scrapeId: number,
  page: number,
  p: ParsedPost,
  runNo: number,
  key: Record<string, SQLInputValue>,
  data: Record<string, SQLInputValue>,
) {
  const postId = p.postId || null;
  const keyCols = Object.keys(key);
  const keyWhere = keyCols.map((c) => `AND ${c}=? `).join('');
  // Two lookups rather than one OR, so each uses its own index.
  const ex =
    (postId != null
      ? get<{ id: number }>(`SELECT id FROM ${table} WHERE scrape_id=? AND post_id=? ${keyWhere}ORDER BY id LIMIT 1`, scrapeId, postId, ...Object.values(key))
      : undefined) ??
    get<{ id: number }>(
      `SELECT id FROM ${table} WHERE scrape_id=? AND post_no=? AND post_id IS NULL ${keyWhere}ORDER BY id LIMIT 1`,
      scrapeId,
      p.postNo,
      ...Object.values(key),
    );
  const dataCols = Object.keys(data);
  if (ex) {
    run(
      `UPDATE ${table} SET page=?, post_no=?, post_id=COALESCE(?, post_id), last_seen_run=?${dataCols.map((c) => `, ${c}=?`).join('')} WHERE id=?`,
      page,
      p.postNo,
      postId,
      runNo,
      ...Object.values(data),
      ex.id,
    );
    return;
  }
  const cols = ['scrape_id', 'page', 'post_no', 'post_id', 'last_seen_run', ...keyCols, ...dataCols];
  run(
    `INSERT INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(',')})`,
    scrapeId,
    page,
    p.postNo,
    postId,
    runNo,
    ...Object.values(key),
    ...Object.values(data),
  );
}

/** Saves what one thread page holds; items kept from earlier runs are refreshed, not duplicated. */
export function savePageItems(scrapeId: number, page: number, posts: ParsedPost[], runNo: number) {
  tx(() => {
    for (const p of posts) {
      for (const u of p.images) upsertItem('scrape_image', scrapeId, page, p, runNo, { origin_url: u }, {});
      for (const v of p.videos) upsertItem('scrape_video', scrapeId, page, p, runNo, { origin_url: v.url }, { kind: v.kind });
      for (const l of p.links) upsertItem('scrape_link', scrapeId, page, p, runNo, { url: l.url }, { text: l.text });
      upsertItem('scrape_comment', scrapeId, page, p, runNo, {}, { author: p.author, content: p.text, created_at: p.createdAt, url: p.url });
    }
  });
}

/**
 * After a complete run: items not seen in it are kept and marked missing; items seen again are unmarked.
 * When more than 2 items and more than half of the job went unseen, the forum more likely served
 * broken pages than deleted that much, so nothing new is marked.
 */
export function markMissing(scrapeId: number, runNo: number) {
  const at = now();
  let missing = 0;
  tx(() => {
    let unseen = 0;
    let total = 0;
    for (const t of ITEM_TABLES) {
      const c = get<{ n: number; u: number }>(`SELECT COUNT(*) n, COALESCE(SUM(last_seen_run<?),0) u FROM ${t} WHERE scrape_id=?`, runNo, scrapeId)!;
      unseen += c.u;
      total += c.n;
    }
    const markUnseen = !(unseen > 2 && unseen * 2 > total);
    for (const t of ITEM_TABLES) {
      if (markUnseen) run(`UPDATE ${t} SET missing_since=COALESCE(missing_since, ?) WHERE scrape_id=? AND last_seen_run<?`, at, scrapeId, runNo);
      run(`UPDATE ${t} SET missing_since=NULL WHERE scrape_id=? AND last_seen_run=? AND missing_since IS NOT NULL`, scrapeId, runNo);
      missing += get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE scrape_id=? AND missing_since IS NOT NULL`, scrapeId)!.n;
    }
  });
  return missing;
}

/**
 * Queues a job to run again without discarding what it already holds. A job the user deleted
 * has lost its files, so its rows are dropped and it starts over.
 */
export function prepareRerun(id: number) {
  const s = get<{ is_marked_deleted: number }>('SELECT is_marked_deleted FROM scrape WHERE id=?', id);
  tx(() => {
    if (s?.is_marked_deleted) {
      for (const t of ITEM_TABLES) run(`DELETE FROM ${t} WHERE scrape_id=?`, id);
      run('UPDATE scrape SET total_images=0, total_videos=0, total_links=0, total_comments=0 WHERE id=?', id);
    }
    run(
      `UPDATE scrape SET status=?, run_no=run_no+1, current_page=0, downloaded_images=0, error=NULL, is_thread_deleted=0,
         finished_at=NULL, started_at=NULL, handling_seconds=NULL, is_marked_deleted=0 WHERE id=?`,
      ScrapeStatus.Waiting,
      id,
    );
  });
}

/**
 * Queues many finished jobs to run again: the chosen `ids`, or `all` finished jobs. Jobs that are
 * queued, running, deleted or unknown are skipped.
 */
export function retryMany(sel: { ids?: unknown; all?: unknown }) {
  const ids = Array.isArray(sel.ids) ? sel.ids : null;
  const valid = sel.all === true || (ids && ids.length > 0 && ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0));
  if (!valid) throw new ApiError(400, 'INVALID_SELECTION', ['Chưa chọn bài nào để sàng lại.', 'No threads chosen to sieve again.'], 'toast');
  const unique = sel.all === true ? null : [...new Set(ids as number[])];
  const rows = all<{ id: number }>(
    // One JSON parameter for the ids: SQLite caps the number of parameters at 32,766.
    `SELECT id FROM scrape WHERE status IN (?,?) AND is_marked_deleted=0${unique ? ' AND id IN (SELECT value FROM json_each(?))' : ''} ORDER BY id`,
    ScrapeStatus.Completed,
    ScrapeStatus.Failed,
    ...(unique ? [JSON.stringify(unique)] : []),
  );
  for (const r of rows) {
    prepareRerun(r.id);
    emit(Ev.NewScrape, summary(r.id), undefined, 'scrape');
  }
  if (rows.length) kick();
  return { queued: rows.length, skipped: unique ? unique.length - rows.length : 0 };
}

function ensureThreadRecord(threadId: number, title: string, forumId: number | null, first: ParsedPost | undefined, totalPages: number) {
  const ex = get('SELECT id FROM thread WHERE id=?', threadId);
  const fid = forumId ?? 0;
  if (!ex) {
    ensureForum(fid, fid ? undefined : 'Không rõ chuyên mục');
    run(
      `INSERT INTO thread(id, forum_id, title, title_lc, author, url, created_at, last_post_at, comment_count, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      threadId,
      fid,
      title,
      title.toLowerCase(),
      first?.author ?? '',
      threadUrl(threadId),
      first?.createdAt ?? now(),
      null,
      Math.max(0, totalPages * cfg().source.postsPerPage - 1),
      now(),
    );
  } else {
    run('UPDATE thread SET is_deleted=0 WHERE id=?', threadId);
  }
}

/** Copies stored media of the latest earlier scrape of the same thread (used when the source is gone). */
function copyArchive(fromId: number, toId: number) {
  tx(() => {
    run(
      `INSERT INTO scrape_image(scrape_id, page, post_no, post_id, origin_url, current_url, external_url, is_bin, is_download_failed, display_by_origin_url)
       SELECT ?, page, post_no, post_id, origin_url, current_url, external_url, is_bin, is_download_failed, display_by_origin_url FROM scrape_image WHERE scrape_id=?`,
      toId,
      fromId,
    );
    run(
      'INSERT INTO scrape_video(scrape_id, page, post_no, post_id, origin_url, kind, current_url, hls_url) SELECT ?, page, post_no, post_id, origin_url, kind, current_url, hls_url FROM scrape_video WHERE scrape_id=?',
      toId,
      fromId,
    );
    run('INSERT INTO scrape_link(scrape_id, page, post_no, post_id, url, text) SELECT ?, page, post_no, post_id, url, text FROM scrape_link WHERE scrape_id=?', toId, fromId);
    run(
      'INSERT INTO scrape_comment(scrape_id, page, post_no, post_id, author, content, created_at, url) SELECT ?, page, post_no, post_id, author, content, created_at, url FROM scrape_comment WHERE scrape_id=?',
      toId,
      fromId,
    );
  });
  // Copy the stored files too, so this archive survives deletion of the earlier job.
  const src = scrapeDir(fromId);
  if (fs.existsSync(src)) {
    fs.cpSync(src, scrapeDir(toId), { recursive: true });
    const prefix = `${scrapeUrl(fromId)}/`;
    run(
      `UPDATE scrape_image SET current_url = replace(current_url, ?, ?) WHERE scrape_id=? AND current_url LIKE ?`,
      prefix,
      `${scrapeUrl(toId)}/`,
      toId,
      `${prefix}%`,
    );
    run(
      `UPDATE scrape_video SET current_url = replace(current_url, ?, ?), hls_url = replace(hls_url, ?, ?) WHERE scrape_id=?`,
      prefix,
      `${scrapeUrl(toId)}/`,
      prefix,
      `${scrapeUrl(toId)}/`,
      toId,
    );
  }
}

function computeTotals(id: number, totalPages: number) {
  const c = (table: string) => get<{ n: number; b: number }>(`SELECT COUNT(*) n, COALESCE(SUM(page < ?),0) b FROM ${table} WHERE scrape_id=?`, totalPages, id)!;
  const im = c('scrape_image'),
    vi = c('scrape_video'),
    li = c('scrape_link'),
    co = c('scrape_comment');
  run(
    `UPDATE scrape SET total_images=?, total_videos=?, total_links=?, total_comments=?,
       images_before_last_page=?, videos_before_last_page=?, links_before_last_page=?, comments_before_last_page=? WHERE id=?`,
    im.n,
    vi.n,
    li.n,
    co.n,
    im.b,
    vi.b,
    li.b,
    co.b,
    id,
  );
}

function finish(id: number, extra: { isThreadDeleted?: boolean } = {}) {
  const s = get<{ started_at: string }>('SELECT started_at FROM scrape WHERE id=?', id)!;
  const hours = cfg().scraper.retentionHours;
  run(
    'UPDATE scrape SET status=?, finished_at=?, handling_seconds=?, is_thread_deleted=?, expires_at=?, error=NULL WHERE id=?',
    ScrapeStatus.Completed,
    now(),
    (Date.now() - Date.parse(s.started_at)) / 1000,
    extra.isThreadDeleted ? 1 : 0,
    hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
    id,
  );
  const sm = summary(id);
  emit(Ev.UpdateScrape, sm, undefined, 'scrape');
  emit(Ev.FinishScrape, sm, undefined, 'scrape');
  if (cfg().telegram.notifyScrapeFinished)
    void telegram(`Glean: xong "${sm.threadTitle}" — ${sm.totalImages} ảnh, ${sm.totalVideos} video, ${sm.totalComments} bình luận.`);
}

/** Runs one queued job to its end, recording a failure instead of throwing. A job deleted while it runs is not a failure. */
export async function runScrape(id: number, fetchPage: typeof fetchThreadPage = fetchThreadPage) {
  await processScrape(id, fetchPage).catch((e) => {
    if (e instanceof Cancelled) run('UPDATE scrape SET status=?, finished_at=? WHERE id=?', ScrapeStatus.NotProcessed, now(), id);
    else failScrape(id, biOf(e));
  });
}

/** Sieves one job. `fetchPage` reads a thread page; tests pass a fake forum. */
export async function processScrape(id: number, fetchPage: typeof fetchThreadPage = fetchThreadPage) {
  const s = get<{ thread_id: number; run_no: number }>('SELECT thread_id, run_no FROM scrape WHERE id=?', id)!;
  run('UPDATE scrape SET status=?, started_at=?, current_page=0, downloaded_images=0, error=NULL WHERE id=?', ScrapeStatus.Processing, now(), id);
  emit(Ev.UpdateScrape, summary(id), undefined, 'scrape');

  let first;
  try {
    first = await fetchPage(s.thread_id, 1);
  } catch (e) {
    if (!(e instanceof ThreadGoneError)) throw e;
    return archiveFallback(id, s.thread_id);
  }
  // A thread page always holds at least one post: an empty one is an error page, so stop before
  // anything (title, page count, missing marks) is overwritten from it.
  const emptyPage = (page: number) =>
    new BiError([
      `Trang ${page} của bài #${s.thread_id} không có bài viết nào, có thể diễn đàn trả về trang lỗi. Lượt sàng dừng lại, dữ liệu đã có được giữ nguyên.`,
      `Page ${page} of thread #${s.thread_id} has no posts; the forum may have returned an error page. The sieve stopped and the data already saved is kept.`,
    ]);
  if (first.posts.length === 0) throw emptyPage(1);
  const totalPages = first.totalPages;
  run('UPDATE scrape SET thread_title=?, total_pages=? WHERE id=?', first.title, totalPages, id);
  ensureThreadRecord(s.thread_id, first.title, first.forumId, first.posts[0], totalPages);

  let done = 0;
  const read = new Map<number, ParsedPost[]>();
  const onPage = (page: number, posts: ParsedPost[]) => {
    savePageItems(id, page, posts, s.run_no);
    tx(() => upsertComments(s.thread_id, page, posts));
    read.set(page, posts);
    done++;
    run('UPDATE scrape SET current_page=? WHERE id=?', done, id);
    emit(Ev.UpdateScrapeProcess, { scrapeId: id, page, currentPage: done, totalPages }, undefined, 'scrape');
  };
  onPage(1, first.posts);

  const rest = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  const sc = cfg().scraper;
  for (let i = 0; i < rest.length; i += sc.concurrentPages) {
    if (isCancelled(id)) throw new Cancelled();
    const batch = rest.slice(i, i + sc.concurrentPages);
    await Promise.all(
      batch.map(async (page) => {
        const r = await fetchPage(s.thread_id, page);
        if (r.posts.length === 0) throw emptyPage(page);
        onPage(page, r.posts);
      }),
    );
    if (sc.batchDelayMs) await sleep(sc.batchDelayMs);
  }
  // Every page was read: comments gone from the forum can be marked, and so can sieved items.
  const pages = [...read.keys()].sort((a, b) => a - b).map((p) => read.get(p)!);
  tx(() => reconcileDeletions(s.thread_id, pages, { startsAtFirstPage: true, endsAtLastPage: true }));
  markMissing(id, s.run_no);
  computeTotals(id, totalPages);
  emit(Ev.UpdateScrape, summary(id), undefined, 'scrape');

  if (sc.downloadImages) await downloadImages(id);
  if (sc.downloadVideos) await downloadVideos(id);
  if (isCancelled(id)) throw new Cancelled();
  finish(id);
}

/** The thread is gone from the forum: finish the job from what is archived. */
export function archiveFallback(id: number, threadId: number) {
  run('UPDATE thread SET is_deleted=1 WHERE id=?', threadId);
  // A job sieved before keeps its own items; nothing is copied over them.
  const own = ITEM_TABLES.reduce((n, t) => n + get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE scrape_id=?`, id)!.n, 0);
  if (own > 0) {
    computeTotals(id, get<{ total_pages: number }>('SELECT total_pages FROM scrape WHERE id=?', id)!.total_pages);
    finish(id, { isThreadDeleted: true });
    return;
  }
  const t = get<{ title: string }>('SELECT title FROM thread WHERE id=?', threadId);
  const prev = get<{ id: number; thread_title: string; total_pages: number }>(
    `SELECT id, thread_title, total_pages FROM scrape WHERE thread_id=? AND id<>? AND status=? AND is_marked_deleted=0 ORDER BY id DESC LIMIT 1`,
    threadId,
    id,
    ScrapeStatus.Completed,
  );
  const synced = get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', threadId)!.n;
  if (!prev && !synced) {
    const host = new URL(cfg().source.baseUrl).host;
    throw new BiError([
      `Không tìm thấy bài #${threadId} trên ${host}: bài không tồn tại hoặc đã bị xóa, và Glean chưa có bản lưu trữ nào của bài này.`,
      `Thread #${threadId} was not found on ${host}: it does not exist or was deleted, and Glean has no archived copy of it.`,
    ]);
  }
  run('UPDATE scrape SET thread_title=?, total_pages=? WHERE id=?', prev?.thread_title ?? t?.title ?? `Bài ${threadId}`, prev?.total_pages ?? 0, id);
  if (prev) copyArchive(prev.id, id);
  computeTotals(id, prev?.total_pages ?? 0);
  finish(id, { isThreadDeleted: true });
}

/* ---------------- media download ---------------- */

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

function looksLikeImage(buf: Buffer, type: string) {
  if (buf.length < 8) return false;
  if (type === 'image/svg+xml') return /<svg[\s>]/i.test(buf.subarray(0, 2048).toString('utf8'));
  const h = buf.subarray(0, 12);
  return (
    (h[0] === 0xff && h[1] === 0xd8) ||
    h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    h.subarray(0, 3).toString() === 'GIF' ||
    (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WEBP') ||
    h.subarray(4, 8).toString() === 'ftyp' ||
    h.subarray(0, 2).toString() === 'BM'
  );
}

let fetchMedia = fetchRaw;

/** Tests only: how images and videos are downloaded. */
export function setMediaFetch(fn: typeof fetchRaw): void {
  fetchMedia = fn;
}

async function downloadImages(id: number) {
  const referer = get<{ thread_url: string }>('SELECT thread_url FROM scrape WHERE id=?', id)?.thread_url;
  const rows = all<{ id: number; origin_url: string }>('SELECT id, origin_url FROM scrape_image WHERE scrape_id=? AND current_url IS NULL AND is_bin=0 ORDER BY id', id);
  const dir = scrapeDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = cfg().storage.maxFileSizeMb * 1024 * 1024;
  const cache = new Map<string, Promise<{ file?: string; bin?: boolean; failed?: boolean }>>();
  let downloaded = 0;
  let lastEmit = 0;
  const total = rows.length;
  emit(Ev.UpdateDownloadImageProcess, { scrapeId: id, downloaded: 0, total }, undefined, 'scrape');

  const fetchOne = async (url: string, imgId: number) => {
    try {
      // Send Referer only to the forum itself (its attachments may need it); other hosts often reject foreign referers.
      const sameSite = referer && new URL(url).host === new URL(referer).host;
      const res = await fetchMedia(url, { retries: 1, referer: sameSite ? referer : undefined });
      if (!res.ok) return { failed: true };
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      // an empty body usually means the host removed the image
      if (buf.length === 0 || buf.length > maxBytes) return { failed: true };
      if (!type.startsWith('image/') || !looksLikeImage(buf, type)) return { bin: true };
      const file = `${imgId}.${EXT[type] ?? 'img'}`;
      fs.writeFileSync(path.join(dir, file), buf);
      return { file };
    } catch {
      return { failed: true };
    }
  };

  await pool(rows, cfg().scraper.concurrentImageDownloads, async (r) => {
    if (isCancelled(id)) return;
    if (!cache.has(r.origin_url)) cache.set(r.origin_url, fetchOne(r.origin_url, r.id));
    const out = await cache.get(r.origin_url)!;
    run(
      'UPDATE scrape_image SET current_url=?, is_bin=?, is_download_failed=?, display_by_origin_url=? WHERE id=?',
      out.file ? `${scrapeUrl(id)}/${out.file}` : null,
      out.bin ? 1 : 0,
      out.failed ? 1 : 0,
      out.file ? 0 : 1,
      r.id,
    );
    downloaded++;
    run('UPDATE scrape SET downloaded_images=? WHERE id=?', downloaded, id);
    if (Date.now() - lastEmit > 200 || downloaded === total) {
      lastEmit = Date.now();
      emit(Ev.UpdateDownloadImageProcess, { scrapeId: id, downloaded, total }, undefined, 'scrape');
    }
  });
}

let ffmpegAvailable: boolean | null = null;
async function hasFfmpeg() {
  if (ffmpegAvailable != null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn(cfg().storage.ffmpegPath, ['-version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}
export const ffmpegStatus = () => hasFfmpeg();

/**
 * Another address of the same video file, tried when its own link fails. The same files are
 * served from sN.amvideo.cyou, where save.moe and the zpi.cx subdomains send theirs:
 * - cdn.anh.moe sends /sN/<file> to sN.amvideo.cfd, whose bucket was closed (403, found on 2026-11-26);
 * - zpi.cx/sN/<file> is cut off by name on some networks (connection reset in the TLS handshake,
 *   seen on 2026-11-28), while its subdomains on the same address still answer.
 */
export function videoMirror(url: string): string | null {
  const m = /^https:\/\/(?:cdn\.anh\.moe|zpi\.cx)\/(s\d+)\/([^/?#]+)$/.exec(url);
  return m ? `https://${m[1]}.amvideo.cyou/${m[2]}` : null;
}

async function downloadVideos(id: number) {
  const rows = all<{ id: number; origin_url: string }>("SELECT id, origin_url FROM scrape_video WHERE scrape_id=? AND kind='file' AND current_url IS NULL", id);
  const dir = scrapeDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = cfg().storage.maxFileSizeMb * 1024 * 1024;
  await pool(rows, 2, async (r) => {
    try {
      let res = await fetchMedia(r.origin_url, { retries: 1, timeoutMs: 120_000 });
      const mirror = videoMirror(r.origin_url);
      if (!res.ok && mirror) res = await fetchMedia(mirror, { retries: 1, timeoutMs: 120_000 });
      if (!res.ok) return;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > maxBytes) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) return;
      const ext = (res.headers.get('content-type') ?? '').includes('webm') ? 'webm' : 'mp4';
      const file = `v${r.id}.${ext}`;
      fs.writeFileSync(path.join(dir, file), buf);
      let hls: string | null = null;
      if (cfg().storage.transcodeVideoToHls && (await hasFfmpeg())) {
        const hlsDir = path.join(dir, `v${r.id}-hls`);
        fs.mkdirSync(hlsDir, { recursive: true });
        const okRun = await new Promise<boolean>((resolve) => {
          const p = spawn(cfg().storage.ffmpegPath, [
            '-y', '-i', path.join(dir, file), '-codec:v', 'libx264', '-codec:a', 'aac', '-hls_time', '6',
            '-hls_playlist_type', 'vod', '-f', 'hls', path.join(hlsDir, 'index.m3u8'),
          ]);
          p.on('error', () => resolve(false));
          p.on('exit', (code) => resolve(code === 0));
        });
        if (okRun) hls = `${scrapeUrl(id)}/v${r.id}-hls/index.m3u8`;
      }
      run('UPDATE scrape_video SET current_url=?, hls_url=? WHERE id=?', `${scrapeUrl(id)}/${file}`, hls, r.id);
    } catch {
      /* keep origin url */
    }
  });
}

/* ---------------- retention ---------------- */

function removeMedia(id: number) {
  fs.rmSync(scrapeDir(id), { recursive: true, force: true });
}

function sweepExpired() {
  const rows = all<{ id: number }>('SELECT id FROM scrape WHERE is_marked_deleted=0 AND expires_at IS NOT NULL AND expires_at < ?', now());
  for (const r of rows) {
    run('UPDATE scrape SET is_marked_deleted=1 WHERE id=?', r.id);
    removeMedia(r.id);
  }
}

/** Each site, in its own context, takes up the jobs a stop interrupted, sweeps and starts its queue. */
export function initScraper() {
  for (const s of sites())
    withSite(s, () => {
      run('UPDATE scrape SET status=? WHERE status=?', ScrapeStatus.Waiting, ScrapeStatus.Processing);
      sweepExpired();
      kick();
    });
  setInterval(() => void forEachSite(sweepExpired), 10 * 60_000).unref();
  onSiteAdded((s) => withSite(s, kick));
  onConfigChange(() => kick());
}

/* ---------------- API ---------------- */

const SOURCES = new Set(['direct', 'search-post', 'search-comment', 'home']);

/**
 * Queues a thread from a pasted link or ID. A link goes to the site of its domain, whichever site is
 * current; an ID to the current site. `beforeQueue` runs first in that site: the route checks there
 * that sieving is not paused.
 */
export function createScrape(input: string, source: string, beforeQueue = () => {}) {
  const s = String(input ?? '').trim();
  // parseThreadRef needs no site to tell a thread link from other text (outside one it skips its domain check).
  if (!parseThreadRef(s)) throw new ApiError(400, 'INVALID_THREAD', ['Không nhận ra link hoặc ID bài viết. Dán link dạng …/threads/ten-bai.12345/ hoặc chỉ số ID.', 'Not a thread link or ID. Paste a link like …/threads/thread-title.12345/ or just the ID.'], 'inline');
  const site = siteForLink(s) ?? currentSiteOrNull();
  if (!site) throw siteRequired();
  return withSite(site, () => {
    beforeQueue();
    const ref = parseThreadRef(s)!;
    return {
      ...queueThread(ref.threadId, source),
      // A link on an old domain of the site: the job reads the site's current address.
      domainWarning:
        ref.foreignHost && ref.knownOldDomain
          ? { host: ref.foreignHost, knownOldDomain: true, currentHost: new URL(cfg().source.baseUrl).host }
          : null,
      site: siteInfo(site),
    };
  });
}

function queueThread(threadId: number, source: string) {
  // A thread keeps one job: a queued one is left as it is, a finished one runs again (as Retry
  // does), so the Archive lists the thread once and its files are not saved twice.
  const existing = get<{ id: number; status: number }>(
    'SELECT id, status FROM scrape WHERE thread_id=? AND is_marked_deleted=0 ORDER BY id DESC LIMIT 1',
    threadId,
  );
  let id: number;
  let reused = false;
  let rerun = false;
  if (existing) {
    id = existing.id;
    reused = true;
    if (existing.status !== ScrapeStatus.Waiting && existing.status !== ScrapeStatus.Processing) {
      rerun = true;
      prepareRerun(id);
      emit(Ev.NewScrape, summary(id), undefined, 'scrape');
      kick();
    }
  } else {
    const t = get<{ title: string }>('SELECT title FROM thread WHERE id=?', threadId);
    id = Number(
      run(
        'INSERT INTO scrape(thread_id, thread_title, thread_url, source, status, created_at) VALUES(?,?,?,?,?,?)',
        threadId,
        t?.title ?? null,
        threadUrl(threadId),
        SOURCES.has(source) ? source : 'direct',
        ScrapeStatus.Waiting,
        now(),
      ).lastInsertRowid,
    );
    emit(Ev.NewScrape, summary(id), undefined, 'scrape');
    kick();
  }
  return { scrape: summary(id), reused, rerun };
}

function rank(id: number) {
  const s = get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id);
  if (!s) throw new ApiError(404, 'NOT_FOUND', ['Không tìm thấy lượt sàng.', 'Sieve job not found.']);
  const waiting = get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE status=? AND is_marked_deleted=0', ScrapeStatus.Waiting)!.n;
  if (s.status !== ScrapeStatus.Waiting) return { rank: s.status === ScrapeStatus.Processing ? 0 : null, waiting, status: s.status };
  const ahead = get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE status=? AND is_marked_deleted=0 AND id<?', ScrapeStatus.Waiting, id)!.n;
  return { rank: ahead + 1, waiting, status: s.status };
}

type PageQuery = { page?: string; size?: string };

function pageOf(table: string, id: number, q: PageQuery, extraWhere = '', extraParams: SQLInputValue[] = []) {
  const page = intParam(q.page, 1);
  const size = intParam(q.size, 40, 1, 200);
  const rows = all(
    `SELECT * FROM ${table} WHERE scrape_id=? ${extraWhere} ORDER BY page, post_no, id LIMIT ? OFFSET ?`,
    id,
    ...extraParams,
    size,
    (page - 1) * size,
  );
  const total = get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE scrape_id=? ${extraWhere}`, id, ...extraParams)!.n;
  return { rows: camelAll(rows), total, page, size };
}

/** The current site, as a job names it. */
function siteTag() {
  const s = currentSite();
  return { code: s.code, name: s.name };
}

/** A job the Archive lists: sieved, or failed, and not deleted. */
const FINISHED = 'status IN (?,?) AND is_marked_deleted=0';
const FINISHED_PARAMS = [ScrapeStatus.Completed, ScrapeStatus.Failed];
const finishedTotal = () => get<{ n: number }>(`SELECT COUNT(*) n FROM scrape WHERE ${FINISHED}`, ...FINISHED_PARAMS)!.n;

/** Archive rows of the current site, with what the list shows. */
function archiveItems(rows: Record<string, SQLInputValue>[]) {
  const site = siteTag();
  return camelAll<{ id: number; threadId: number; createdAt: string }>(rows).map((s) => ({
    ...s,
    syncedCommentCount: get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', s.threadId)!.n,
    site,
  }));
}

/** The condition that keeps a site's jobs after the merged Archive's cursor (its time, site code and id). */
function afterCursor(siteCode: string, [at, code, id]: string[]): [string, SQLInputValue[]] {
  // At the cursor's time, the jobs of a site after the cursor's come next; in the cursor's own site, the lower ids.
  if (siteCode > code) return ['AND created_at <= ?', [at]];
  if (siteCode < code) return ['AND created_at < ?', [at]];
  return ['AND (created_at < ? OR (created_at = ? AND id < ?))', [at, at, Number(id)]];
}

/**
 * With `*`: the Archive of every site, newest first, then by site code, then the higher id first.
 * The cursor `${createdAt}|${code}|${id}` is the last row shown; each site lists its rows after it.
 */
async function processedEverySite(cursor: string | undefined, size: number) {
  const c = /^(.+)\|([^|]+)\|(\d+)$/.exec(cursor ?? '');
  const per = await forEachSite((s) => {
    const [after, params] = c ? afterCursor(s.code, c.slice(1)) : ['', []];
    const rows = all(`SELECT * FROM scrape WHERE ${FINISHED} ${after} ORDER BY created_at DESC, id DESC LIMIT ?`, ...FINISHED_PARAMS, ...params, size);
    return { items: archiveItems(rows), total: finishedTotal() };
  });
  const items = mergeTop(
    per.map((p) => p.value.items),
    newestFirst,
    0,
    size,
  );
  const last = items.at(-1);
  return ok(items, {
    nextCursor: items.length === size && last ? `${last.createdAt}|${last.site.code}|${last.id}` : null,
    total: per.reduce((n, p) => n + p.value.total, 0),
    totalBySite: Object.fromEntries(per.map((p) => [p.site.code, p.value.total])),
  });
}

export function registerScraper(app: FastifyInstance) {
  // A link may queue in another site than the request's: sieving must not be paused there.
  app.post<{ Body: { url: string; source?: string } }>('/api/scrapes/create-scrape', async (req) =>
    ok(createScrape(req.body?.url, req.body?.source ?? 'direct', () => assertNotPaused(req, 'scrape'))),
  );

  app.get('/api/scrapes/unprocessed', async () => {
    const rows = all('SELECT * FROM scrape WHERE status IN (?,?) AND is_marked_deleted=0 ORDER BY status DESC, id', ScrapeStatus.Processing, ScrapeStatus.Waiting);
    return ok(camelAll(rows), { processingId: queueOf().currentId });
  });

  app.get<{ Querystring: { cursor?: string; size?: string } }>('/api/scrapes/processed', async (req) => {
    const size = intParam(req.query.size, 20, 1, 100);
    if (requestSite(req) === null) return processedEverySite(req.query.cursor, size);
    const cursor = intParam(req.query.cursor, Number.MAX_SAFE_INTEGER);
    const rows = all<{ id: number }>(`SELECT * FROM scrape WHERE ${FINISHED} AND id<? ORDER BY id DESC LIMIT ?`, ...FINISHED_PARAMS, cursor, size);
    const total = finishedTotal();
    return ok(archiveItems(rows), { nextCursor: rows.length === size ? rows.at(-1)!.id : null, total, totalBySite: { [currentSite().code]: total } });
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/scrapes/check-proxy', async (req) => {
    const fresh = req.query.refresh === '1';
    return ok(fresh ? await checkProxies() : proxyStatus());
  });

  app.get<{ Params: { id: string } }>('/api/scrapes/:id', async (req) => {
    const s = get('SELECT * FROM scrape WHERE id=?', Number(req.params.id));
    if (!s) throw new ApiError(404, 'NOT_FOUND', ['Không tìm thấy lượt sàng.', 'Sieve job not found.']);
    const sm = camel<{ id: number; threadId: number; status: number; runNo: number } & Record<string, unknown>>(s);
    sm.syncedCommentCount = get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', sm.threadId)!.n;
    sm.failedImages = get<{ n: number }>('SELECT COUNT(*) n FROM scrape_image WHERE scrape_id=? AND (is_download_failed=1 OR is_bin=1)', sm.id)!.n;
    // While a job runs, only pages read in this run count as done (earlier runs' items are kept).
    const running = sm.status === ScrapeStatus.Waiting || sm.status === ScrapeStatus.Processing;
    sm.donePages = all<{ page: number }>(
      `SELECT DISTINCT page FROM scrape_comment WHERE scrape_id=?${running ? ' AND last_seen_run=?' : ''}`,
      sm.id,
      ...(running ? [sm.runNo] : []),
    ).map((r) => r.page);
    const missing = (t: ItemTable) => get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE scrape_id=? AND missing_since IS NOT NULL`, sm.id)!.n;
    sm.missingCounts = {
      images: missing('scrape_image'),
      videos: missing('scrape_video'),
      links: missing('scrape_link'),
      comments: missing('scrape_comment'),
    };
    sm.site = siteTag();
    return ok(sm);
  });

  app.get<{ Params: { id: string } }>('/api/scrapes/:id/rank', async (req) => ok(rank(Number(req.params.id))));

  app.get<{ Params: { id: string }; Querystring: PageQuery }>('/api/scrapes/:id/images', async (req) => {
    const r = pageOf('scrape_image', Number(req.params.id), req.query);
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string }; Querystring: PageQuery }>('/api/scrapes/:id/videos', async (req) => {
    const r = pageOf('scrape_video', Number(req.params.id), req.query);
    const rows = (r.rows as { originUrl: string; kind: string }[]).map((v) => ({ ...v, mirrorUrl: v.kind === 'file' ? videoMirror(v.originUrl) : null }));
    return ok(rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string }; Querystring: PageQuery }>('/api/scrapes/:id/links', async (req) => {
    const r = pageOf('scrape_link', Number(req.params.id), req.query);
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string }; Querystring: PageQuery & { minLength?: string } }>('/api/scrapes/:id/comments', async (req) => {
    const id = Number(req.params.id);
    const min = intParam(req.query.minLength, cfg().scraper.minCommentLength, 0, 1000);
    const r = pageOf('scrape_comment', id, req.query, 'AND length(content) >= ?', [min]);
    const all = get<{ n: number }>('SELECT COUNT(*) n FROM scrape_comment WHERE scrape_id=?', id)!.n;
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size, removed: all - r.total, minLength: min });
  });
  app.get<{ Params: { id: string }; Querystring: PageQuery }>('/api/scrapes/:id/synced-comments', async (req) => {
    const s = get<{ thread_id: number }>('SELECT thread_id FROM scrape WHERE id=?', Number(req.params.id));
    if (!s) throw new ApiError(404, 'NOT_FOUND', ['Không tìm thấy lượt sàng.', 'Sieve job not found.']);
    const page = intParam(req.query.page, 1);
    const size = intParam(req.query.size, 40, 1, 200);
    const rows = all('SELECT * FROM comment WHERE thread_id=? ORDER BY post_no LIMIT ? OFFSET ?', s.thread_id, size, (page - 1) * size);
    const total = get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', s.thread_id)!.n;
    return ok(camelAll(rows), { total, page, pageSize: size });
  });

  app.delete<{ Params: { id: string } }>('/api/scrapes/:id/mark-delete', async (req) => {
    const id = Number(req.params.id);
    run('UPDATE scrape SET is_marked_deleted=1 WHERE id=?', id);
    // give an in-flight job a moment to notice cancellation before deleting files
    setTimeout(() => removeMedia(id), id === queueOf().currentId ? 3000 : 0);
    emit(Ev.UpdateScrape, summary(id), undefined, 'scrape');
    return ok(true);
  });

  app.post<{ Params: { id: string } }>('/api/scrapes/:id/retry', async (req) => {
    assertNotPaused(req, 'scrape');
    const id = Number(req.params.id);
    const s = get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id);
    if (!s) throw new ApiError(404, 'NOT_FOUND', ['Không tìm thấy lượt sàng.', 'Sieve job not found.']);
    if (s.status === ScrapeStatus.Processing || s.status === ScrapeStatus.Waiting)
      throw new ApiError(409, 'IN_QUEUE', ['Lượt sàng này đang trong hàng đợi.', 'This sieve job is already in the queue.'], 'toast');
    // Re-running keeps everything already archived; see prepareRerun.
    prepareRerun(id);
    emit(Ev.NewScrape, summary(id), undefined, 'scrape');
    kick();
    return ok(summary(id));
  });

  app.post<{ Body: { ids?: unknown; all?: unknown } }>('/api/scrapes/retry-many', async (req) => {
    assertNotPaused(req, 'scrape');
    return ok(retryMany(req.body ?? {}));
  });

  app.post('/api/scrapes/resume-queue', async () => {
    kick();
    return ok(true);
  });
}
