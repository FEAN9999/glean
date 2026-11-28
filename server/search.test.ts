import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from './config.ts';
import { mainAll, run } from './db.ts';
import { addSite, mainSite, registerSites, withSite } from './site.ts';
import { ApiError, sendError } from './http.ts';
import { registerSearch, searchComments, searchPosts } from './search.ts';
import { upsertComments } from './sync.ts';
import type { ParsedPost } from './source/xenforo.ts';

loadConfig(0);
addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });

const post = (postId: number, text: string): ParsedPost => ({
  postId,
  postNo: postId - 7000,
  author: 'An',
  createdAt: '2026-11-01T00:00:00.000Z',
  text,
  url: `http://x.test/posts/${postId}`,
  images: [],
  videos: [],
  links: [],
  editedAt: null,
});

run(
  `INSERT INTO thread(id, forum_id, title, author, url, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
  70,
  1,
  'Chủ đề 70',
  'An',
  'http://x.test',
  '2026-11-01T00:00:00.000Z',
  '2026-11-01T00:00:00.000Z',
);
upsertComments(70, 1, [post(7001, 'quanhdao bình thường'), post(7002, 'quanhdao bản đầu'), post(7003, 'quanhdao sắp bị xóa')]);
upsertComments(70, 1, [post(7002, 'quanhdao bản đã sửa')]);
run('UPDATE comment SET deleted_at=? WHERE id=?', '2026-11-13T00:00:00.000Z', 7003);

test('onlyChanged returns edited and deleted comments only', () => {
  const r = searchComments({ keyword: 'quanhdao', onlyChanged: true }, false);
  assert.equal(r.total, 2);
  const byId = new Map(r.items.map((c) => [c.id, c]));
  assert.deepEqual([...byId.keys()].sort(), [7002, 7003]);
  assert.equal(byId.get(7002)?.editCount, 1);
  assert.equal(byId.get(7003)?.deletedAt, '2026-11-13T00:00:00.000Z');
  assert.equal(searchComments({ keyword: 'quanhdao' }, false).total, 3);
});

test('onlyChanged also applies to author search', () => {
  assert.equal(searchComments({ keyword: 'An', isExactMatch: true, threadId: 70, onlyChanged: true }, true).total, 2);
});

test('revisions route lists earlier versions, newest first', async () => {
  upsertComments(70, 1, [post(7002, 'quanhdao bản thứ ba')]);
  const app = Fastify();
  registerSearch(app);
  const r = (await app.inject({ method: 'GET', url: '/api/comments/7002/revisions' })).json<{ data: { content: string; capturedAt: string; replacedAt: string }[] }>();
  assert.deepEqual(
    r.data.map((x) => x.content),
    ['quanhdao bản đã sửa', 'quanhdao bản đầu'],
  );
  assert.ok(r.data[0].capturedAt && r.data[0].replacedAt);
});

test('searchPosts sorts by views and by likes', () => {
  for (const [id, views, likes] of [
    [7101, 5, 9],
    [7102, 50, 1],
    [7103, 20, 4],
  ])
    run(
      `INSERT INTO thread(id, forum_id, title, author, url, created_at, view_count, like_count, updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      id,
      1,
      `xepthutu ${id}`,
      'An',
      'http://x.test',
      `2026-11-0${id - 7100}T00:00:00.000Z`,
      views,
      likes,
      '2026-11-01T00:00:00.000Z',
    );
  const byViews = searchPosts({ keyword: 'xepthutu', sortDescendingField: 'viewCount' }).items as { viewCount: number; likeCount: number }[];
  assert.deepEqual(
    byViews.map((p) => p.viewCount),
    [50, 20, 5],
  );
  const byLikes = searchPosts({ keyword: 'xepthutu', sortDescendingField: 'likeCount' }).items as { viewCount: number; likeCount: number }[];
  assert.deepEqual(
    byLikes.map((p) => p.likeCount),
    [9, 4, 1],
  );
});

test('search history is shared by all sites', async () => {
  const app = Fastify();
  registerSites(app);
  registerSearch(app);
  const r = await app.inject({ method: 'POST', url: '/api/posts/search', headers: { 'x-glean-site': 'rphang' }, payload: { keyword: 'tukhoadungchung' } });
  assert.equal(r.statusCode, 200);
  assert.ok(mainAll<{ keyword: string }>('SELECT keyword FROM search_history').some((x) => x.keyword === 'tukhoadungchung'));
});

// A thread link picks the site by its domain.
withSite('rphang', () => {
  run(
    `INSERT INTO thread(id, forum_id, title, author, url, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
    300,
    1,
    'Chủ đề 300',
    'Bình',
    'http://x.test',
    '2026-11-01T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  );
  upsertComments(300, 1, [post(9, 'xin chào rphang')]);
});

async function siteApp() {
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => (e instanceof ApiError ? sendError(reply, e) : reply.send(e)));
  registerSites(app);
  registerSearch(app);
  await app.ready();
  return app;
}
const threadSearch = async (site: string, url: string, threadId: string, keyword = 'chào') =>
  (await siteApp()).inject({ method: 'POST', url, headers: { 'x-glean-site': site }, payload: { keyword, threadId } });

test('a thread link of another site searches that site', async () => {
  const r = await threadSearch(mainSite().code, '/api/comments/search', 'https://rphang.land/t/a.300/');
  assert.equal(r.statusCode, 200);
  const j = r.json<{ data: { id: number }[]; site: { code: string } }>();
  assert.deepEqual(j.data.map((c) => c.id), [9]);
  assert.equal(j.site.code, 'rphang');
  const c = await threadSearch('*', '/api/comments/search/count', 'https://rphang.land/t/a.300/');
  assert.equal(c.json().data.total, 1);
  const q = await threadSearch('*', '/api/comments/search-by-author', 'https://rphang.land/t/a.300/', 'Bình');
  assert.equal(q.json().site.code, 'rphang');
});

test('a bare thread id with * is refused', async () => {
  const r = await threadSearch('*', '/api/comments/search', '300');
  assert.deepEqual([r.statusCode, r.json().code], [400, 'SITE_REQUIRED']);
});

test('a link on an unknown domain is a 409', async () => {
  const r = await threadSearch(mainSite().code, '/api/comments/search', 'https://nowhere.example/t/a.300/');
  assert.deepEqual([r.statusCode, r.json().code], [409, 'UNKNOWN_SITE']);
});
