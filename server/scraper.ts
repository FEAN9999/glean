import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { SQLInputValue } from 'node:sqlite';
import { all, get, run, now, tx, camel, camelAll } from './db.ts';
import { cfg, onConfigChange } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, assertNotPaused, intParam, ok } from './http.ts';
import { fetchRaw, pool, proxyStatus, checkProxies, sleep } from './net.ts';
import { fetchThreadPage, parseThreadRef, threadUrl, ThreadGoneError, type ParsedPost } from './source/xenforo.ts';
import { ensureForum, upsertComments } from './sync.ts';
import { reconcileDeletions } from './archive.ts';
import { telegram } from './notify.ts';

export const ScrapeStatus = { None: 0, Waiting: 1, Processing: 2, Completed: 3, Failed: 4, NotProcessed: 5 } as const;

const mediaRoot = () => cfg().storage.basePath;
const scrapeDir = (id: number) => path.join(mediaRoot(), 'scrapes', String(id));

/* ---------------- queue ---------------- */

let working = false;
let currentId: number | null = null;

function kick() {
  if (!working) void work();
}

async function work() {
  working = true;
  try {
    for (;;) {
      if (cfg().maintenance.scrape.isPaused) break;
      const next = get<{ id: number }>('SELECT id FROM scrape WHERE status=? AND is_marked_deleted=0 ORDER BY id LIMIT 1', ScrapeStatus.Waiting);
      if (!next) break;
      currentId = next.id;
      await processScrape(next.id).catch((e) => failScrape(next.id, (e as Error).message));
      currentId = null;
    }
  } finally {
    working = false;
    currentId = null;
  }
}

function summary(id: number) {
  return camel(get('SELECT * FROM scrape WHERE id=?', id));
}

function failScrape(id: number, error: string) {
  const s = get<{ started_at: string | null }>('SELECT started_at FROM scrape WHERE id=?', id);
  run(
    'UPDATE scrape SET status=?, error=?, finished_at=?, handling_seconds=? WHERE id=?',
    ScrapeStatus.Failed,
    error,
    now(),
    s?.started_at ? (Date.now() - Date.parse(s.started_at)) / 1000 : null,
    id,
  );
  const sm = summary(id);
  emit(Ev.UpdateScrape, sm, undefined, 'scrape');
  emit(Ev.FinishScrape, sm, error, 'scrape');
  if (cfg().telegram.notifyScrapeFinished) void telegram(`Glean: lượt sàng #${id} thất bại — ${error}`);
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
    const prefix = `/media/scrapes/${fromId}/`;
    run(
      `UPDATE scrape_image SET current_url = replace(current_url, ?, ?) WHERE scrape_id=? AND current_url LIKE ?`,
      prefix,
      `/media/scrapes/${toId}/`,
      toId,
      `${prefix}%`,
    );
    run(
      `UPDATE scrape_video SET current_url = replace(current_url, ?, ?), hls_url = replace(hls_url, ?, ?) WHERE scrape_id=?`,
      prefix,
      `/media/scrapes/${toId}/`,
      prefix,
      `/media/scrapes/${toId}/`,
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
    new Error(`Trang ${page} của bài #${s.thread_id} không có bài viết nào, có thể diễn đàn trả về trang lỗi. Lượt sàng dừng lại, dữ liệu đã có được giữ nguyên.`);
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
    throw new Error(
      `Không tìm thấy bài #${threadId} trên ${new URL(cfg().source.baseUrl).host}: bài không tồn tại hoặc đã bị xóa, và Glean chưa có bản lưu trữ nào của bài này.`,
    );
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
      const res = await fetchRaw(url, { retries: 1, referer: sameSite ? referer : undefined });
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
      out.file ? `/media/scrapes/${id}/${out.file}` : null,
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

async function downloadVideos(id: number) {
  const rows = all<{ id: number; origin_url: string }>("SELECT id, origin_url FROM scrape_video WHERE scrape_id=? AND kind='file' AND current_url IS NULL", id);
  const dir = scrapeDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = cfg().storage.maxFileSizeMb * 1024 * 1024;
  await pool(rows, 2, async (r) => {
    try {
      const res = await fetchRaw(r.origin_url, { retries: 1, timeoutMs: 120_000 });
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
        if (okRun) hls = `/media/scrapes/${id}/v${r.id}-hls/index.m3u8`;
      }
      run('UPDATE scrape_video SET current_url=?, hls_url=? WHERE id=?', `/media/scrapes/${id}/${file}`, hls, r.id);
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

export function initScraper() {
  run('UPDATE scrape SET status=? WHERE status=?', ScrapeStatus.Waiting, ScrapeStatus.Processing);
  setInterval(sweepExpired, 10 * 60_000).unref();
  sweepExpired();
  kick();
  onConfigChange(() => kick());
}

/* ---------------- API ---------------- */

const SOURCES = new Set(['direct', 'search-post', 'search-comment', 'home']);

export function createScrape(input: string, source: string) {
  const ref = parseThreadRef(String(input ?? ''));
  if (!ref) throw new ApiError(400, 'INVALID_THREAD', 'Không nhận ra link hoặc ID bài viết. Dán link dạng …/threads/ten-bai.12345/ hoặc chỉ số ID.', 'inline');
  if (ref.foreignHost && !ref.knownOldDomain) {
    const current = new URL(cfg().source.baseUrl);
    const isDemo = current.pathname.replace(/\/+$/, '').endsWith('/demo-forum');
    throw new ApiError(
      409,
      'SOURCE_MISMATCH',
      `Link thuộc ${ref.foreignHost}, nhưng Glean đang đọc từ ${isDemo ? 'diễn đàn mẫu' : current.host}. ` +
        (isDemo
          ? `Đổi "Địa chỉ diễn đàn" trong Cài đặt → Nguồn dữ liệu thành https://${ref.foreignHost} rồi dán lại link.`
          : `Nếu ${ref.foreignHost} là tên miền khác của cùng diễn đàn, thêm https://${ref.foreignHost} vào "Tên miền cũ" trong Cài đặt → Nguồn dữ liệu; nếu là diễn đàn khác, đổi "Địa chỉ diễn đàn".`),
      'inline',
    );
  }
  const existing = get<{ id: number }>(
    'SELECT id FROM scrape WHERE thread_id=? AND status IN (?,?) AND is_marked_deleted=0 ORDER BY id DESC LIMIT 1',
    ref.threadId,
    ScrapeStatus.Waiting,
    ScrapeStatus.Processing,
  );
  let id: number;
  let reused = false;
  if (existing) {
    id = existing.id;
    reused = true;
  } else {
    const t = get<{ title: string }>('SELECT title FROM thread WHERE id=?', ref.threadId);
    id = Number(
      run(
        'INSERT INTO scrape(thread_id, thread_title, thread_url, source, status, created_at) VALUES(?,?,?,?,?,?)',
        ref.threadId,
        t?.title ?? null,
        threadUrl(ref.threadId),
        SOURCES.has(source) ? source : 'direct',
        ScrapeStatus.Waiting,
        now(),
      ).lastInsertRowid,
    );
    emit(Ev.NewScrape, summary(id), undefined, 'scrape');
    kick();
  }
  return {
    scrape: summary(id),
    reused,
    domainWarning: ref.foreignHost
      ? {
          host: ref.foreignHost,
          knownOldDomain: ref.knownOldDomain,
          currentHost: new URL(cfg().source.baseUrl).host,
        }
      : null,
  };
}

function rank(id: number) {
  const s = get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id);
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt sàng.');
  const waiting = get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE status=? AND is_marked_deleted=0', ScrapeStatus.Waiting)!.n;
  if (s.status !== ScrapeStatus.Waiting) return { rank: s.status === ScrapeStatus.Processing ? 0 : null, waiting, status: s.status };
  const ahead = get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE status=? AND is_marked_deleted=0 AND id<?', ScrapeStatus.Waiting, id)!.n;
  return { rank: ahead + 1, waiting, status: s.status };
}

function pageOf(table: string, id: number, q: any, extraWhere = '', extraParams: any[] = []) {
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

export function registerScraper(app: FastifyInstance) {
  app.post<{ Body: { url: string; source?: string } }>('/api/scrapes/create-scrape', async (req) => {
    assertNotPaused(req, 'scrape');
    return ok(createScrape(req.body?.url, req.body?.source ?? 'direct'));
  });

  app.get('/api/scrapes/unprocessed', async () => {
    const rows = all('SELECT * FROM scrape WHERE status IN (?,?) AND is_marked_deleted=0 ORDER BY status DESC, id', ScrapeStatus.Processing, ScrapeStatus.Waiting);
    return ok(camelAll(rows), { processingId: currentId });
  });

  app.get<{ Querystring: { cursor?: string; size?: string } }>('/api/scrapes/processed', async (req) => {
    const cursor = intParam(req.query.cursor, Number.MAX_SAFE_INTEGER);
    const size = intParam(req.query.size, 20, 1, 100);
    const rows = all<{ id: number }>(
      'SELECT * FROM scrape WHERE status IN (?,?) AND is_marked_deleted=0 AND id<? ORDER BY id DESC LIMIT ?',
      ScrapeStatus.Completed,
      ScrapeStatus.Failed,
      cursor,
      size,
    );
    const items = camelAll(rows).map((s: any) => ({
      ...s,
      syncedCommentCount: get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', s.threadId)!.n,
    }));
    return ok(items, { nextCursor: rows.length === size ? rows.at(-1)!.id : null });
  });

  app.get('/api/scrapes/check-proxy', async (req) => {
    const fresh = (req.query as any).refresh === '1';
    return ok(fresh ? await checkProxies() : proxyStatus());
  });

  app.get<{ Params: { id: string } }>('/api/scrapes/:id', async (req) => {
    const s = get('SELECT * FROM scrape WHERE id=?', Number(req.params.id));
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt sàng.');
    const sm: any = camel(s);
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
    return ok(sm);
  });

  app.get<{ Params: { id: string } }>('/api/scrapes/:id/rank', async (req) => ok(rank(Number(req.params.id))));

  app.get<{ Params: { id: string } }>('/api/scrapes/:id/images', async (req) => {
    const r = pageOf('scrape_image', Number(req.params.id), req.query);
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string } }>('/api/scrapes/:id/videos', async (req) => {
    const r = pageOf('scrape_video', Number(req.params.id), req.query);
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string } }>('/api/scrapes/:id/links', async (req) => {
    const r = pageOf('scrape_link', Number(req.params.id), req.query);
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size });
  });
  app.get<{ Params: { id: string }; Querystring: { minLength?: string } }>('/api/scrapes/:id/comments', async (req) => {
    const id = Number(req.params.id);
    const min = intParam(req.query.minLength, cfg().scraper.minCommentLength, 0, 1000);
    const r = pageOf('scrape_comment', id, req.query, 'AND length(content) >= ?', [min]);
    const all = get<{ n: number }>('SELECT COUNT(*) n FROM scrape_comment WHERE scrape_id=?', id)!.n;
    return ok(r.rows, { total: r.total, page: r.page, pageSize: r.size, removed: all - r.total, minLength: min });
  });
  app.get<{ Params: { id: string } }>('/api/scrapes/:id/synced-comments', async (req) => {
    const s = get<{ thread_id: number }>('SELECT thread_id FROM scrape WHERE id=?', Number(req.params.id));
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt sàng.');
    const page = intParam((req.query as any).page, 1);
    const size = intParam((req.query as any).size, 40, 1, 200);
    const rows = all('SELECT * FROM comment WHERE thread_id=? ORDER BY post_no LIMIT ? OFFSET ?', s.thread_id, size, (page - 1) * size);
    const total = get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=?', s.thread_id)!.n;
    return ok(camelAll(rows), { total, page, pageSize: size });
  });

  app.delete<{ Params: { id: string } }>('/api/scrapes/:id/mark-delete', async (req) => {
    const id = Number(req.params.id);
    run('UPDATE scrape SET is_marked_deleted=1 WHERE id=?', id);
    // give an in-flight job a moment to notice cancellation before deleting files
    setTimeout(() => removeMedia(id), id === currentId ? 3000 : 0);
    emit(Ev.UpdateScrape, summary(id), undefined, 'scrape');
    return ok(true);
  });

  app.post<{ Params: { id: string } }>('/api/scrapes/:id/retry', async (req) => {
    assertNotPaused(req, 'scrape');
    const id = Number(req.params.id);
    const s = get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id);
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt sàng.');
    if (s.status === ScrapeStatus.Processing || s.status === ScrapeStatus.Waiting)
      throw new ApiError(409, 'IN_QUEUE', 'Lượt sàng này đang trong hàng đợi.', 'toast');
    // Re-running keeps everything already archived; see prepareRerun.
    prepareRerun(id);
    emit(Ev.NewScrape, summary(id), undefined, 'scrape');
    kick();
    return ok(summary(id));
  });

  app.post('/api/scrapes/resume-queue', async () => {
    kick();
    return ok(true);
  });
}
