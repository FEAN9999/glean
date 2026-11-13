import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig, updateConfig } from './config.ts';
import { all, get, now, run } from './db.ts';
import { archiveFallback, markMissing, prepareRerun, processScrape, registerScraper, savePageItems, ScrapeStatus } from './scraper.ts';
import type { ParsedPost, ParsedThreadPage } from './source/xenforo.ts';

loadConfig(0);
// No network in tests: pages come from a fake reader and media is never downloaded.
updateConfig({ scraper: { downloadImages: false, downloadVideos: false, batchDelayMs: 0 } } as any, 0);

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

let nextThread = 900;
function newScrape() {
  const threadId = nextThread++;
  const id = Number(
    run(
      'INSERT INTO scrape(thread_id, thread_title, thread_url, source, status, created_at, total_pages) VALUES(?,?,?,?,?,?,?)',
      threadId,
      `Chủ đề ${threadId}`,
      'http://x.test',
      'direct',
      ScrapeStatus.Processing,
      now(),
      1,
    ).lastInsertRowid,
  );
  return { id, threadId };
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
  const s = get<any>('SELECT run_no, status, is_marked_deleted FROM scrape WHERE id=?', id)!;
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
  const s = get<any>('SELECT status, is_thread_deleted, total_images FROM scrape WHERE id=?', id)!;
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
  const s = get<any>('SELECT thread_title, total_pages FROM scrape WHERE id=?', id)!;
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
