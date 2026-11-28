import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig, updateConfig } from './config.ts';
import { mainAll, run, setTestFallback } from './db.ts';
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
/** Runs a request with the test fallback off, so code that reads a site store outside a site fails as it would in production. */
async function noFallback<T>(fn: () => Promise<T>): Promise<T> {
  const prev = setTestFallback(null);
  try {
    return await fn();
  } finally {
    setTestFallback(prev);
  }
}
const threadSearch = async (site: string, url: string, threadId: string, keyword = 'chào') => {
  const app = await siteApp();
  return noFallback(() => app.inject({ method: 'POST', url, headers: { 'x-glean-site': site }, payload: { keyword, threadId } }));
};

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

/* ---------------- every site at once (x-glean-site: *) ---------------- */

// The same keyword in both stores, with the same ids and times, two threads to a time.
const hour = (i: number) => new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 2) * 3_600_000).toISOString();
const seedThreads = (n: number) => {
  for (let i = 0; i < n; i++)
    run(
      `INSERT INTO thread(id, forum_id, title, author, url, created_at, comment_count, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      8001 + i,
      1,
      `xegop ${i}`,
      'An',
      'http://x.test',
      hour(i),
      i % 4,
      hour(i),
    );
};
seedThreads(25);
withSite('rphang', () => seedThreads(17));
upsertComments(70, 1, [post(7301, 'binhluangop một'), post(7302, 'binhluangop hai')]);
withSite('rphang', () => upsertComments(300, 1, [post(7301, 'binhluangop ba')]));

type Hit = { id: number; createdAt: string; commentCount: number; site: { code: string; name: string } };
const everySite = async (url: string, payload?: object) => {
  const app = await siteApp();
  return noFallback(() => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { 'x-glean-site': '*' }, payload }));
};
const key = (h: Hit) => `${h.site.code}:${h.id}`;
/** Newest first; a tie goes by site code, then the higher id first. */
const newer = (a: Hit, b: Hit) =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && (a.site.code < b.site.code || (a.site.code === b.site.code && a.id > b.id)));

test('merged post search pages through both stores without gaps or repeats', async () => {
  updateConfig({ search: { pageSize: 20 } }, 0);
  for (const sortDescendingField of ['createdAt', 'commentCount']) {
    const rows: Hit[] = [];
    for (const page of [1, 2, 3]) {
      const r = await everySite('/api/posts/search', { keyword: 'xegop', page, sortDescendingField });
      assert.equal(r.statusCode, 200);
      const j = r.json<{ data: Hit[]; total: number; nextPage: number | null }>();
      assert.equal(j.total, 42);
      assert.equal(j.nextPage, page < 3 ? page + 1 : null);
      rows.push(...j.data);
    }
    assert.equal(rows.length, 42);
    assert.equal(new Set(rows.map(key)).size, 42);
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      const ok = sortDescendingField === 'commentCount' ? a.commentCount > b.commentCount || (a.commentCount === b.commentCount && newer(a, b)) : newer(a, b);
      assert.ok(ok, `${sortDescendingField}: ${key(a)} before ${key(b)}`);
    }
  }
});

test('every merged row names its site', async () => {
  const codes = new Set(['demo', 'rphang']);
  const posts = (await everySite('/api/posts/search', { keyword: 'xegop' })).json<{ data: Hit[] }>().data;
  const comments = (await everySite('/api/comments/search', { keyword: 'binhluangop' })).json<{ data: Hit[]; total: number }>();
  assert.deepEqual(comments.data.map(key), ['demo:7302', 'demo:7301', 'rphang:7301']);
  assert.equal(comments.total, 3);
  const suggested = (await everySite('/api/posts/search/suggestions?q=xegop%20khac&topK=8')).json<{ data: Hit[] }>().data;
  assert.deepEqual(
    suggested.map((s) => s.site.code),
    ['demo', 'rphang', 'demo', 'rphang', 'demo', 'rphang', 'demo', 'rphang'],
  );
  for (const row of [...posts, ...comments.data, ...suggested]) {
    assert.ok(codes.has(row.site.code), key(row));
    assert.equal(row.site.name, row.site.code);
  }
  assert.equal((await everySite('/api/posts/search/count', { keyword: 'xegop' })).json().data.total, 42);
  assert.equal((await everySite('/api/comments/search/count', { keyword: 'binhluangop' })).json().data.total, 3);
  // One site: its rows name it too.
  const app = await siteApp();
  const one = (await app.inject({ method: 'POST', url: '/api/posts/search', headers: { 'x-glean-site': 'rphang' }, payload: { keyword: 'xegop' } })).json<{ data: Hit[] }>();
  assert.ok(one.data.length > 0);
  for (const row of one.data) assert.deepEqual(row.site, { code: 'rphang', name: 'rphang' });
});

test('a paused site stops merged search', async () => {
  withSite('rphang', () => updateConfig({ maintenance: { searchPost: { isPaused: true, message: '' } } }, 0));
  try {
    const r = await everySite('/api/posts/search', { keyword: 'xegop' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().code, 'FEATURE_PAUSED');
    assert.match(r.json().message, /rphang/);
    // The main site alone still searches.
    const app = await siteApp();
    const one = await app.inject({ method: 'POST', url: '/api/posts/search', headers: { 'x-glean-site': 'demo' }, payload: { keyword: 'xegop' } });
    assert.equal(one.statusCode, 200);
  } finally {
    withSite('rphang', () => updateConfig({ maintenance: { searchPost: { isPaused: false, message: '' } } }, 0));
  }
});
