import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '../config.ts';
import { registerDemoForum } from './forum.ts';
import { parseThreadHtml } from '../source/xenforo.ts';

loadConfig(0);

const app = Fastify();
registerDemoForum(app);

/** First thread listed in demo forum 1, read the way Glean reads it. */
async function firstThread() {
  const list = (await app.inject({ method: 'GET', url: '/demo-forum/forums/x.1/' })).body;
  const href = list.match(/href="(\/demo-forum\/threads\/[^"]+)"/)![1];
  const read = async () => parseThreadHtml((await app.inject({ method: 'GET', url: href })).body, `http://demo.test${href}`, 1);
  return { read };
}

test('an edited demo post shows its new text and a last-edit time', async () => {
  const { read } = await firstThread();
  const target = (await read()).posts[1];
  const r = (await app.inject({ method: 'POST', url: `/demo-forum/_edit-post/${target.postId}`, payload: {} })).json();
  assert.equal(r.postId, target.postId);
  assert.ok(r.threadId);
  const after = (await read()).posts.find((p) => p.postId === target.postId)!;
  assert.match(after.text, /\(đã sửa\)$/);
  assert.equal(after.editedAt, r.editedAt);
});

test('an edit can set the text', async () => {
  const { read } = await firstThread();
  const target = (await read()).posts[2];
  await app.inject({ method: 'POST', url: `/demo-forum/_edit-post/${target.postId}`, payload: { text: 'Nội dung thay thế' } });
  assert.equal((await read()).posts.find((p) => p.postId === target.postId)!.text, 'Nội dung thay thế');
});

test('a deleted demo post disappears and can be restored', async () => {
  const { read } = await firstThread();
  const target = (await read()).posts[1];
  const del = (await app.inject({ method: 'POST', url: `/demo-forum/_toggle-post-delete/${target.postId}` })).json();
  assert.equal(del.deleted, true);
  assert.equal((await read()).posts.some((p) => p.postId === target.postId), false);
  const back = (await app.inject({ method: 'POST', url: `/demo-forum/_toggle-post-delete/${target.postId}` })).json();
  assert.equal(back.deleted, false);
  assert.equal((await read()).posts.some((p) => p.postId === target.postId), true);
});

test('the first post of a thread cannot be deleted on its own', async () => {
  const { read } = await firstThread();
  const first = (await read()).posts[0];
  const r = await app.inject({ method: 'POST', url: `/demo-forum/_toggle-post-delete/${first.postId}` });
  assert.equal(r.statusCode, 400);
});

test('unknown posts are a 404', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/demo-forum/_edit-post/1' })).statusCode, 404);
});

test('the second demo forum shares ids but tags titles', async () => {
  const app2 = Fastify();
  registerDemoForum(app2, { prefix: '/demo-forum-2', titleTag: '[B] ' });
  const list = (await app2.inject({ method: 'GET', url: '/demo-forum-2/forums/x.1/' })).body;
  const href = list.match(/href="(\/demo-forum-2\/threads\/[^"]+)"/)![1];
  const id = href.match(/\.(\d+)\/$/)![1];
  const res = await app2.inject({ method: 'GET', url: `/demo-forum-2/threads/x.${id}/` });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<h1 class="p-title-value">\[B\] /);
  const first = (await app.inject({ method: 'GET', url: `/demo-forum/threads/x.${id}/` })).body;
  assert.doesNotMatch(first, /\[B\] /);
  const links = [...res.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(links.length > 3);
  for (const l of links) assert.ok(l.startsWith('/demo-forum-2/'), l);
  assert.doesNotMatch(res.body, /\/demo-forum\//);
});
