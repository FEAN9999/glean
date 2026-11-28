import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { cfg, loadConfig, onConfigChange, updateConfig } from './config.ts';
import { all, get, now, run, setTestFallback, siteCtxOrNull } from './db.ts';
import {
  archiveFallback,
  createScrape,
  kick,
  markMissing,
  prepareRerun,
  processScrape,
  registerScraper,
  retryMany,
  runScrape,
  savePageItems,
  ScrapeStatus,
  setMediaFetch,
  setThreadReader,
  videoMirror,
} from './scraper.ts';
import { ApiError, sendError } from './http.ts';
import { addSite, mainSite, registerSites, removeSite, withSite, type Site } from './site.ts';
import { ThreadGoneError, type ParsedPost, type ParsedThreadPage } from './source/xenforo.ts';

loadConfig(0);
// No network in tests: pages come from a fake reader and media is never downloaded.
updateConfig({ scraper: { downloadImages: false, downloadVideos: false, batchDelayMs: 0 } }, 0);
// The main site is the demo forum on 127.0.0.1; the other sites use their own hosts.
const rphang = addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });
const rm2 = addSite({ baseUrl: 'https://rm2.test', code: 'rm2', name: 'rm2' });
for (const s of [rphang, rm2]) withSite(s, () => updateConfig({ scraper: { downloadImages: false, downloadVideos: false, batchDelayMs: 0 } }, 0));

const A = 'http://x.test/a.jpg';
const B = 'http://x.test/b.jpg';

const post = (postId: number, postNo: number, images: string[] = []): ParsedPost => ({
  postId,
  postNo,
  author: 'An',
  createdAt: '2026-11-01T00:00:00.000Z',
  text: `bình luận ${postNo}`,
  url: `http://x.test/posts/${postId}`,
  images,
  videos: [],
  links: [],
  editedAt: null,
});

/** A thread of one page with one post. */
const onePage = async (): Promise<ParsedThreadPage> => ({ title: 'Chủ đề', forumId: 1, totalPages: 1, posts: [post(1, 1)] });
// A job queued by a test is read from this fake forum, and its images from nowhere.
setThreadReader(onePage);
setMediaFetch(async () => {
  throw new Error('no network in tests');
});

/** A job for `threadId` in the current site. */
function jobFor(threadId: number, status: number = ScrapeStatus.Processing) {
  return Number(
    run(
      'INSERT INTO scrape(thread_id, thread_title, thread_url, source, status, created_at, total_pages) VALUES(?,?,?,?,?,?,?)',
      threadId,
      `Chủ đề ${threadId}`,
      'http://x.test',
      'direct',
      status,
      now(),
      1,
    ).lastInsertRowid,
  );
}

let nextThread = 900;
function newScrape() {
  const threadId = nextThread++;
  return { id: jobFor(threadId), threadId };
}
const images = (id: number) =>
  all<{ id: number; origin_url: string; current_url: string | null; missing_since: string | null; post_id: number | null }>(
    'SELECT id, origin_url, current_url, missing_since, post_id FROM scrape_image WHERE scrape_id=? ORDER BY id',
    id,
  );
const count = (table: string, id: number) => get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE scrape_id=?`, id)!.n;

test('rerun keeps items no longer on the forum and marks them missing', () => {
  const { id } = newScrape();
  savePageItems(id, 1, [post(11, 1, [A]), post(12, 2, [B])], 1);
  run('UPDATE scrape_image SET current_url=? WHERE scrape_id=? AND origin_url=?', '/media/scrapes/x/1.jpg', id, A);
  const aId = images(id)[0].id;

  prepareRerun(id);
  assert.equal(get<{ run_no: number }>('SELECT run_no FROM scrape WHERE id=?', id)!.run_no, 2);
  savePageItems(id, 1, [post(11, 1, [A])], 2);
  // post 12 is gone: its image and its comment are kept and marked
  assert.equal(markMissing(id, 2), 2);

  const rows = images(id);
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.origin_url === A)!;
  const b = rows.find((r) => r.origin_url === B)!;
  assert.equal(a.id, aId);
  assert.equal(a.current_url, '/media/scrapes/x/1.jpg');
  assert.equal(a.missing_since, null);
  assert.ok(b.missing_since);
  assert.equal(count('scrape_comment', id), 2);
});

test('an item that reappears clears missing_since', () => {
  const { id } = newScrape();
  savePageItems(id, 1, [post(21, 1, [A]), post(22, 2, [B])], 1);
  prepareRerun(id);
  savePageItems(id, 1, [post(21, 1, [A])], 2);
  markMissing(id, 2);
  prepareRerun(id);
  savePageItems(id, 1, [post(21, 1, [A]), post(22, 2, [B])], 3);
  assert.equal(markMissing(id, 3), 0);
  assert.ok(images(id).every((r) => r.missing_since === null));
  assert.equal(images(id).length, 2);
});

test('rerun matches legacy rows without post_id', () => {
  const { id } = newScrape();
  // rows written before the upgrade: no post_id
  run('INSERT INTO scrape_image(scrape_id, page, post_no, origin_url) VALUES(?,?,?,?)', id, 1, 2, A);
  run('INSERT INTO scrape_comment(scrape_id, page, post_no, author, content) VALUES(?,?,?,?,?)', id, 1, 2, 'An', 'cũ');
  prepareRerun(id);
  savePageItems(id, 1, [post(32, 2, [A])], 2);
  const rows = images(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].post_id, 32);
  assert.equal(count('scrape_comment', id), 1);
  assert.equal(get<{ content: string }>('SELECT content FROM scrape_comment WHERE scrape_id=?', id)!.content, 'bình luận 2');
});

test('prepareRerun on a deleted job drops its rows', () => {
  const { id } = newScrape();
  savePageItems(id, 1, [post(41, 1, [A])], 1);
  run('UPDATE scrape SET is_marked_deleted=1 WHERE id=?', id);
  prepareRerun(id);
  for (const t of ['scrape_image', 'scrape_video', 'scrape_link', 'scrape_comment']) assert.equal(count(t, id), 0, t);
  const s = get<{ run_no: number; status: number; is_marked_deleted: number }>('SELECT run_no, status, is_marked_deleted FROM scrape WHERE id=?', id)!;
  assert.deepEqual([s.run_no, s.status, s.is_marked_deleted], [2, ScrapeStatus.Waiting, 0]);
});

test("archiveFallback keeps the job's own data", () => {
  const { id, threadId } = newScrape();
  savePageItems(id, 1, [post(51, 1, [A]), post(52, 2, [B])], 1);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, id);
  prepareRerun(id);
  run('UPDATE scrape SET status=?, started_at=? WHERE id=?', ScrapeStatus.Processing, now(), id);
  archiveFallback(id, threadId);
  assert.equal(images(id).length, 2);
  assert.equal(count('scrape_comment', id), 2);
  const s = get<{ status: number; is_thread_deleted: number; total_images: number }>('SELECT status, is_thread_deleted, total_images FROM scrape WHERE id=?', id)!;
  assert.deepEqual([s.status, s.is_thread_deleted, s.total_images], [ScrapeStatus.Completed, 1, 2]);
});

test('archiveFallback copies post ids along with an earlier job', () => {
  const prev = newScrape();
  savePageItems(prev.id, 1, [post(71, 1, [A])], 1);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, prev.id);
  const id = Number(
    run(
      'INSERT INTO scrape(thread_id, thread_title, thread_url, source, status, created_at, started_at, total_pages) VALUES(?,?,?,?,?,?,?,?)',
      prev.threadId,
      'x',
      'http://x.test',
      'direct',
      ScrapeStatus.Processing,
      now(),
      now(),
      1,
    ).lastInsertRowid,
  );
  archiveFallback(id, prev.threadId);
  assert.deepEqual(images(id).map((r) => r.post_id), [71]);
  assert.equal(get<{ post_id: number }>('SELECT post_id FROM scrape_comment WHERE scrape_id=?', id)!.post_id, 71);
});

test('detail reports missing counts and the pages done in the current run', async () => {
  const { id } = newScrape();
  savePageItems(id, 1, [post(61, 1, [A])], 1);
  savePageItems(id, 2, [post(62, 21, [B])], 1);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, id);
  prepareRerun(id);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Processing, id);
  savePageItems(id, 1, [post(61, 1, [A])], 2);

  const app = Fastify();
  registerScraper(app);
  const running = (await app.inject({ method: 'GET', url: `/api/scrapes/${id}` })).json().data;
  assert.deepEqual(running.donePages, [1]);

  markMissing(id, 2);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, id);
  const done = (await app.inject({ method: 'GET', url: `/api/scrapes/${id}` })).json().data;
  assert.deepEqual(done.missingCounts, { images: 1, videos: 0, links: 0, comments: 1 });
  assert.deepEqual([...done.donePages].sort(), [1, 2]);
});

test('a cdn.anh.moe video has a mirror on amvideo.cyou; other links have none', () => {
  assert.equal(videoMirror('https://cdn.anh.moe/s9/N5QpKLvV.mp4'), 'https://s9.amvideo.cyou/N5QpKLvV.mp4');
  assert.equal(videoMirror('https://cdn.anh.moe/s4/7mL8oF.mp4'), 'https://s4.amvideo.cyou/7mL8oF.mp4');
  assert.equal(videoMirror('https://cdn.anh.moe/N5QpKLvV.mp4'), null);
  assert.equal(videoMirror('https://cdn.save.moe/s9/N5QpKLvV.mp4'), null);
  assert.equal(videoMirror('https://evil.test/cdn.anh.moe/s9/a.mp4'), null);
});

test('the video list gives a file its mirror link', async () => {
  const { id } = newScrape();
  const anh = 'https://cdn.anh.moe/s9/N5QpKLvV.mp4';
  const other = 'http://x.test/v.mp4';
  savePageItems(id, 1, [{ ...post(91, 1), videos: [{ url: anh, kind: 'file' }, { url: other, kind: 'file' }] }], 1);

  const app = Fastify();
  registerScraper(app);
  const rows: { originUrl: string; mirrorUrl: string | null }[] = (await app.inject({ method: 'GET', url: `/api/scrapes/${id}/videos` })).json().data;
  assert.deepEqual(
    rows.map((v) => [v.originUrl, v.mirrorUrl]),
    [
      [anh, 'https://s9.amvideo.cyou/N5QpKLvV.mp4'],
      [other, null],
    ],
  );
});

/** A fake forum: page number → posts, every page reporting `totalPages`. */
const forum = (totalPages: number, pages: Record<number, ParsedPost[]>, title = 'Chủ đề') =>
  async (_id: number, page: number): Promise<ParsedThreadPage> => ({ title, forumId: 1, totalPages, posts: pages[page] ?? [] });
const missing = (id: number) =>
  ['scrape_image', 'scrape_video', 'scrape_link', 'scrape_comment'].reduce(
    (n, t) => n + get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE scrape_id=? AND missing_since IS NOT NULL`, id)!.n,
    0,
  );

test('a re-sieve that gets an empty page fails and marks nothing missing', async () => {
  const { id } = newScrape();
  savePageItems(id, 1, [post(81, 1, [A])], 1);
  savePageItems(id, 2, [post(82, 21, [B])], 1);
  prepareRerun(id);
  await assert.rejects(processScrape(id, forum(2, { 1: [post(81, 1, [A])], 2: [] })), /trang 2/i);
  assert.equal(missing(id), 0);
  assert.equal(images(id).length, 2);
});

test('an empty first page keeps the title and page count', async () => {
  const { id, threadId } = newScrape();
  run('UPDATE scrape SET total_pages=3 WHERE id=?', id);
  await assert.rejects(processScrape(id, forum(1, {}, '')), /trang 1/i);
  const s = get<{ thread_title: string; total_pages: number }>('SELECT thread_title, total_pages FROM scrape WHERE id=?', id)!;
  assert.deepEqual([s.thread_title, s.total_pages], [`Chủ đề ${threadId}`, 3]);
});

test('a re-sieve that misses most items does not mark them missing', async () => {
  const { id } = newScrape();
  const urls = [1, 2, 3, 4, 5, 6].map((n) => `http://x.test/${n}.jpg`);
  savePageItems(id, 1, urls.map((u, i) => post(91 + i, i + 1, [u])), 1);
  prepareRerun(id);
  await processScrape(id, forum(1, { 1: [post(91, 1, [urls[0]])] }));
  assert.equal(missing(id), 0);
  assert.equal(images(id).length, 6);
  assert.equal(get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id)!.status, ScrapeStatus.Completed);
});

test('deleting a job while it is sieved stops it without recording a failure', async () => {
  const { id } = newScrape();
  const read = forum(3, { 1: [post(101, 1)], 2: [post(102, 21)], 3: [post(103, 41)] });
  await runScrape(id, async (threadId, page) => {
    // the user deletes the job while page 1 is being read
    if (page === 1) run('UPDATE scrape SET is_marked_deleted=1 WHERE id=?', id);
    return read(threadId, page);
  });
  const s = get<{ status: number; error: string | null }>('SELECT status, error FROM scrape WHERE id=?', id)!;
  assert.deepEqual([s.status, s.error], [ScrapeStatus.NotProcessed, null]);
});

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md
test('a failed sieve keeps its reason in Vietnamese and in English', async () => {
  const { id, threadId } = newScrape();
  // the forum has no such thread, and nothing of it is archived
  await runScrape(id, async () => {
    throw new ThreadGoneError(threadId, 404);
  });
  const s = get<{ status: number; error: string | null }>('SELECT status, error FROM scrape WHERE id=?', id)!;
  assert.equal(s.status, ScrapeStatus.Failed);
  assert.match(s.error ?? '', new RegExp(`"vi":"Không tìm thấy bài #${threadId} `));
  assert.match(s.error ?? '', new RegExp(`"en":"Thread #${threadId} was not found `));
});

// Regression: ISSUE-009 — sieving a thread again made a second job: the Archive listed the thread
// twice and its images were saved twice. Found by /qa-only on 2026-11-26.
// Report: .gstack/qa-reports/run-20261126T151753Z/qa-report-mixed-xamvn-clone-2026-11-26.md
test('sieving a thread that has a finished job runs that job again, keeping what it holds', () => {
  // paused, so the queued job is not read in the background
  updateConfig({ maintenance: { scrape: { isPaused: true, message: '' } } }, 0);
  try {
    for (const status of [ScrapeStatus.Completed, ScrapeStatus.Failed]) {
      const { id, threadId } = newScrape();
      savePageItems(id, 1, [post(111, 1, [A])], 1);
      run('UPDATE scrape SET status=? WHERE id=?', status, id);

      const r = createScrape(String(threadId), 'direct');
      assert.deepEqual([r.scrape.id, r.reused, r.rerun], [id, true, true], `status ${status}`);
      assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE thread_id=?', threadId)!.n, 1);
      assert.equal(get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id)!.status, ScrapeStatus.Waiting);
      assert.equal(count('scrape_image', id), 1);
    }
  } finally {
    updateConfig({ maintenance: { scrape: { isPaused: false, message: '' } } }, 0);
  }
});

test('sieving a thread whose job is still queued, or was deleted, works as before', () => {
  updateConfig({ maintenance: { scrape: { isPaused: true, message: '' } } }, 0);
  try {
    const queued = newScrape();
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Waiting, queued.id);
    const again = createScrape(String(queued.threadId), 'direct');
    assert.deepEqual([again.scrape.id, again.reused, again.rerun], [queued.id, true, false]);

    const deleted = newScrape();
    run('UPDATE scrape SET status=?, is_marked_deleted=1 WHERE id=?', ScrapeStatus.Completed, deleted.id);
    const fresh = createScrape(String(deleted.threadId), 'direct');
    assert.notEqual(fresh.scrape.id, deleted.id);
    assert.deepEqual([fresh.reused, fresh.rerun], [false, false]);
  } finally {
    updateConfig({ maintenance: { scrape: { isPaused: false, message: '' } } }, 0);
  }
});

/* ---------------- sàng lại hàng loạt ---------------- */

/** Runs `fn` with sieving paused, so jobs queued by it are not read in the background. */
function whilePaused<T>(fn: () => T): T {
  updateConfig({ maintenance: { scrape: { isPaused: true, message: '' } } }, 0);
  try {
    return fn();
  } finally {
    updateConfig({ maintenance: { scrape: { isPaused: false, message: '' } } }, 0);
  }
}
const statusOf = (id: number) => get<{ status: number; run_no: number; is_marked_deleted: number }>('SELECT status, run_no, is_marked_deleted FROM scrape WHERE id=?', id)!;
const finishedCount = () =>
  get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE status IN (?,?) AND is_marked_deleted=0', ScrapeStatus.Completed, ScrapeStatus.Failed)!.n;

test('retry-many queues the chosen finished jobs once and skips the rest', () => {
  whilePaused(() => {
    const done = newScrape(), failed = newScrape(), queued = newScrape(), gone = newScrape();
    savePageItems(done.id, 1, [post(301, 1, [A])], 1);
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Failed, failed.id);
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Waiting, queued.id);
    run('UPDATE scrape SET status=?, is_marked_deleted=1 WHERE id=?', ScrapeStatus.Completed, gone.id);
    const runBefore = statusOf(done.id).run_no;

    const r = retryMany({ ids: [done.id, done.id, failed.id, queued.id, gone.id, 999999] });

    assert.deepEqual(r, { queued: 2, skipped: 3 });
    assert.equal(statusOf(done.id).status, ScrapeStatus.Waiting);
    assert.equal(statusOf(failed.id).status, ScrapeStatus.Waiting);
    assert.equal(statusOf(done.id).run_no, runBefore + 1);
    assert.equal(count('scrape_image', done.id), 1);
    assert.equal(statusOf(gone.id).is_marked_deleted, 1);
    assert.equal(statusOf(gone.id).status, ScrapeStatus.Completed);
  });
});

test('retry-many with all queues every finished job that is not deleted', () => {
  whilePaused(() => {
    const a = newScrape(), b = newScrape(), gone = newScrape();
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, a.id);
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Failed, b.id);
    run('UPDATE scrape SET status=?, is_marked_deleted=1 WHERE id=?', ScrapeStatus.Completed, gone.id);
    const before = finishedCount();

    const r = retryMany({ all: true });

    assert.deepEqual(r, { queued: before, skipped: 0 });
    assert.equal(finishedCount(), 0);
    assert.equal(statusOf(a.id).status, ScrapeStatus.Waiting);
    assert.equal(statusOf(b.id).status, ScrapeStatus.Waiting);
    assert.equal(statusOf(gone.id).status, ScrapeStatus.Completed);
  });
});

test('retry-many refuses a malformed selection without changing anything', () => {
  whilePaused(() => {
    const done = newScrape();
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);
    for (const bad of [{}, { ids: [] }, { ids: 'x' }, { ids: [1.5] }, { ids: [-1] }, { ids: [String(done.id)] }, { all: 'yes' }, { all: false }])
      assert.throws(
        () => retryMany(bad),
        (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'INVALID_SELECTION',
        JSON.stringify(bad),
      );
    assert.equal(statusOf(done.id).status, ScrapeStatus.Completed);
  });
});

test('the retry-many route is refused while sieving is paused, and the archive list reports its total', async () => {
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => (e instanceof ApiError ? sendError(reply, e) : reply.send(e)));
  registerScraper(app);
  const done = newScrape();
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);

  updateConfig({ maintenance: { scrape: { isPaused: true, message: '' } } }, 0);
  try {
    const paused = await app.inject({ method: 'POST', url: '/api/scrapes/retry-many', payload: { all: true } });
    assert.equal(paused.statusCode, 503);
    assert.equal(paused.json().code, 'FEATURE_PAUSED');
    assert.equal(statusOf(done.id).status, ScrapeStatus.Completed);

    const list = (await app.inject({ method: 'GET', url: '/api/scrapes/processed?size=1' })).json();
    assert.equal(list.total, finishedCount());
  } finally {
    updateConfig({ maintenance: { scrape: { isPaused: false, message: '' } } }, 0);
  }
});

// Review minor: each id was its own SQL parameter, so 32,767 or more ids failed with "too many SQL variables".
test('retry-many takes a selection larger than SQLite allows as parameters', () => {
  whilePaused(() => {
    const done = newScrape();
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);
    const ids = [done.id, ...Array.from({ length: 40_000 }, (_, i) => 10_000_000 + i)];
    assert.deepEqual(retryMany({ ids }), { queued: 1, skipped: 40_000 });
    assert.equal(statusOf(done.id).status, ScrapeStatus.Waiting);
  });
});

test('retry-many skips a job that is running', () => {
  whilePaused(() => {
    const done = newScrape(), running = newScrape();
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);
    run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Processing, running.id);
    assert.deepEqual(retryMany({ ids: [done.id, running.id] }), { queued: 1, skipped: 1 });
    assert.equal(statusOf(running.id).status, ScrapeStatus.Processing);
  });
});

// Sieving is not paused here, so nothing these requests send may be queued: a queued job would be
// read from the forum at once.
test('the retry-many route answers through Fastify and refuses a missing or non-object body', async () => {
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => (e instanceof ApiError ? sendError(reply, e) : reply.send(e)));
  registerScraper(app);
  const running = newScrape();
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Processing, running.id);

  const r = await app.inject({ method: 'POST', url: '/api/scrapes/retry-many', payload: { ids: [running.id, 99_999_999] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { success: true, data: { queued: 0, skipped: 2 } });

  for (const payload of [undefined, 'null', '[1,2]', '"x"']) {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/scrapes/retry-many',
      ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(bad.statusCode, 400, String(payload));
    assert.equal(bad.json().code, 'INVALID_SELECTION', String(payload));
  }
});

/* ---------------- theo trang ---------------- */

/** Waits until `check` is true. */
async function until(check: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const statusIn = (site: Site | string, id: number) => withSite(site, () => get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id)!.status);
const jobsOfThread = (threadId: number) => get<{ n: number }>('SELECT COUNT(*) n FROM scrape WHERE thread_id=?', threadId)!.n;
/** A reader that holds `threadId` until `release()`; other threads are one page. */
function holding(threadId: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const read: number[] = [];
  const reader = async (id: number) => {
    read.push(id);
    if (id === threadId) await gate;
    return onePage();
  };
  return { reader, release, read };
}

test("the same thread id is sieved into each site's own store", async () => {
  const say = (text: string) => async (): Promise<ParsedThreadPage> => ({ title: 'Chủ đề', forumId: 1, totalPages: 1, posts: [{ ...post(1, 1), text }] });
  const idMain = jobFor(4242);
  const idB = withSite('rphang', () => jobFor(4242));
  await processScrape(idMain, say('chữ của trang chính'));
  await withSite('rphang', () => processScrape(idB, say('chữ của rphang')));

  const content = (id: number) => get<{ content: string }>('SELECT content FROM scrape_comment WHERE scrape_id=?', id)!.content;
  assert.equal(count('scrape_comment', idMain), 1);
  assert.equal(
    withSite('rphang', () => count('scrape_comment', idB)),
    1,
  );
  assert.equal(content(idMain), 'chữ của trang chính');
  assert.equal(
    withSite('rphang', () => content(idB)),
    'chữ của rphang',
  );
});

test('queues of two sites run at the same time', async () => {
  const h = holding(5151);
  setThreadReader(h.reader);
  try {
    const idMain = jobFor(5151, ScrapeStatus.Waiting);
    const idB = withSite('rphang', () => jobFor(5151, ScrapeStatus.Waiting));
    kick();
    withSite('rphang', kick);
    // Both are held by the reader at once: neither queue waits for the other.
    await until(() => statusIn(mainSite(), idMain) === ScrapeStatus.Processing && statusIn('rphang', idB) === ScrapeStatus.Processing, 'both jobs to run');
    h.release();
    await until(() => statusIn(mainSite(), idMain) === ScrapeStatus.Completed && statusIn('rphang', idB) === ScrapeStatus.Completed, 'both jobs to finish');
  } finally {
    setThreadReader(onePage);
  }
});

test('a link is queued on the site of its domain', async () => {
  const r = createScrape('https://rphang.land/t/a.77/', 'direct');
  assert.equal(r.site.code, 'rphang');
  assert.equal(r.domainWarning, null);
  assert.equal(
    withSite('rphang', () => jobsOfThread(77)),
    1,
  );
  assert.equal(jobsOfThread(77), 0);
  await until(() => statusIn('rphang', Number(r.scrape.id)) === ScrapeStatus.Completed, 'the job to finish');
});

test('a link on an old domain of a site is queued there with a warning', async () => {
  withSite('rphang', () => updateConfig({ source: { previousBaseUrls: ['https://old-rphang.test'] } }, 0));
  const r = createScrape('https://old-rphang.test/threads/b.78/', 'direct');
  assert.equal(r.site.code, 'rphang');
  assert.deepEqual(r.domainWarning, { host: 'old-rphang.test', knownOldDomain: true, currentHost: 'rphang.land' });
  await until(() => statusIn('rphang', Number(r.scrape.id)) === ScrapeStatus.Completed, 'the job to finish');
});

test('a link of an unknown domain is refused', () => {
  assert.throws(
    () => createScrape('https://khong-co.test/threads/1/', 'direct'),
    (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'UNKNOWN_SITE' && e.message.includes('khong-co.test') && e.en.includes('khong-co.test'),
  );
  // Text that is no thread link at all is still told apart from a link.
  assert.throws(
    () => createScrape('hello', 'direct'),
    (e: unknown) => e instanceof ApiError && e.code === 'INVALID_THREAD',
  );
});

test('with every site chosen, a link finds its site and a bare thread id is refused', async () => {
  const prev = setTestFallback(null);
  let id: number;
  try {
    assert.equal(siteCtxOrNull(), null);
    assert.throws(
      () => createScrape('4242', 'direct'),
      (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'SITE_REQUIRED',
    );
    const r = createScrape('https://rphang.land/threads/c.79/', 'direct');
    assert.equal(r.site.code, 'rphang');
    id = Number(r.scrape.id);
  } finally {
    setTestFallback(prev);
  }
  await until(() => statusIn('rphang', id) === ScrapeStatus.Completed, 'the job to finish');
});

test('create-scrape is refused while the site the link goes to is paused', async () => {
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => (e instanceof ApiError ? sendError(reply, e) : reply.send(e)));
  registerSites(app);
  registerScraper(app);
  withSite('rphang', () => updateConfig({ maintenance: { scrape: { isPaused: true, message: '' } } }, 0));
  try {
    for (const header of [mainSite().code, '*']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/scrapes/create-scrape',
        headers: { 'x-glean-site': header },
        payload: { url: 'https://rphang.land/threads/d.80/' },
      });
      assert.equal(r.statusCode, 503, header);
      assert.equal(r.json().code, 'FEATURE_PAUSED', header);
    }
    assert.equal(
      withSite('rphang', () => jobsOfThread(80)),
      0,
    );
  } finally {
    withSite('rphang', () => updateConfig({ maintenance: { scrape: { isPaused: false, message: '' } } }, 0));
  }
});

test('a job and the archive list name their site', async () => {
  const app = Fastify();
  registerSites(app);
  registerScraper(app);
  const id = withSite('rphang', () => jobFor(8181, ScrapeStatus.Completed));
  const headers = { 'x-glean-site': 'rphang' };
  const one = (await app.inject({ method: 'GET', url: `/api/scrapes/${id}`, headers })).json().data;
  assert.deepEqual(one.site, { code: 'rphang', name: 'rphang' });
  const list: { site: unknown }[] = (await app.inject({ method: 'GET', url: '/api/scrapes/processed', headers })).json().data;
  assert.ok(list.length > 0);
  for (const s of list) assert.deepEqual(s.site, { code: 'rphang', name: 'rphang' });
});

test('media of a non-main site is saved under its own folder and URL', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  setMediaFetch(async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
  withSite('rphang', () => updateConfig({ scraper: { downloadImages: true } }, 0));
  try {
    const id = withSite('rphang', () => jobFor(6161));
    await withSite('rphang', () => processScrape(id, async () => ({ title: 'Ảnh', forumId: 1, totalPages: 1, posts: [post(1, 1, [A])] })));
    const url = withSite('rphang', () => get<{ current_url: string | null }>('SELECT current_url FROM scrape_image WHERE scrape_id=?', id)!.current_url ?? '');
    assert.ok(url.startsWith(`/media/sites/rphang/scrapes/${id}/`), url);
    assert.ok(fs.existsSync(path.join(rphang.dir!, 'media', 'scrapes', String(id), path.basename(url))));
  } finally {
    withSite('rphang', () => updateConfig({ scraper: { downloadImages: false } }, 0));
    setMediaFetch(async () => {
      throw new Error('no network in tests');
    });
  }
});

test('removing a site stops its queue', async () => {
  const configured: (string | null)[] = [];
  onConfigChange(() => configured.push(siteCtxOrNull()?.code ?? null));
  const h = holding(7171);
  setThreadReader(h.reader);
  try {
    const [first, second] = withSite(rm2, () => [jobFor(7171, ScrapeStatus.Waiting), jobFor(7272, ScrapeStatus.Waiting)]);
    const mainJobs = get<{ n: number }>('SELECT COUNT(*) n FROM scrape')!.n;
    withSite(rm2, kick);
    await until(() => statusIn(rm2, first) === ScrapeStatus.Processing, 'the first job to run');
    removeSite('rm2');
    h.release();
    // The running job ends in its own store; the queue then stops.
    await until(() => statusIn(rm2, first) === ScrapeStatus.Completed, 'the first job to finish');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(statusIn(rm2, second), ScrapeStatus.Waiting);
    assert.deepEqual(h.read, [7171]);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM scrape')!.n, mainJobs);
    // Its settings, loaded again by that job, are not kept: a shared change does not reach it.
    updateConfig({ search: { pageSize: cfg().search.pageSize } }, 0);
    assert.ok(configured.length > 0);
    assert.ok(!configured.includes('rm2'), configured.join());
  } finally {
    setThreadReader(onePage);
  }
});
