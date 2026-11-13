import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from './config.ts';
import { run } from './db.ts';
import { registerSearch, searchComments } from './search.ts';
import { upsertComments } from './sync.ts';
import type { ParsedPost } from './source/xenforo.ts';

loadConfig(0);

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
  const byId = new Map(r.items.map((c: any) => [c.id, c]));
  assert.deepEqual([...byId.keys()].sort(), [7002, 7003]);
  assert.equal(byId.get(7002).editCount, 1);
  assert.equal(byId.get(7003).deletedAt, '2026-11-13T00:00:00.000Z');
  assert.equal(searchComments({ keyword: 'quanhdao' }, false).total, 3);
});

test('onlyChanged also applies to author search', () => {
  assert.equal(searchComments({ keyword: 'An', isExactMatch: true, threadId: 70, onlyChanged: true }, true).total, 2);
});

test('revisions route lists earlier versions, newest first', async () => {
  upsertComments(70, 1, [post(7002, 'quanhdao bản thứ ba')]);
  const app = Fastify();
  registerSearch(app);
  const r = (await app.inject({ method: 'GET', url: '/api/comments/7002/revisions' })).json();
  assert.deepEqual(
    r.data.map((x: any) => x.content),
    ['quanhdao bản đã sửa', 'quanhdao bản đầu'],
  );
  assert.ok(r.data[0].capturedAt && r.data[0].replacedAt);
});
