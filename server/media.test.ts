import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { cfg, loadConfig } from './config.ts';
import { DATA_DIR } from './db.ts';
import { signJwt } from './auth.ts';
import { browserCookie, registerMedia } from './media.ts';

loadConfig(0);

const root = cfg().storage.basePath;
fs.mkdirSync(path.join(root, 'scrapes', '1'), { recursive: true });
fs.writeFileSync(path.join(root, 'scrapes', '1', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
fs.writeFileSync(path.join(root, 'scrapes', '1', 'b.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
// A folder next to the media folder whose name starts the same way.
fs.mkdirSync(`${root}-evil`, { recursive: true });
fs.writeFileSync(`${root}-evil/secret.txt`, 'secret');

const app = Fastify();
registerMedia(app);
await app.ready();

const cookie = browserCookie(1).split(';')[0];
const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ url, headers });

test('media needs the browser cookie', async () => {
  assert.equal((await get('/media/scrapes/1/a.png', {})).statusCode, 401);
  const r = await get('/media/scrapes/1/a.png');
  assert.deepEqual([r.statusCode, r.headers['content-type']], [200, 'image/png']);
});

test('an access token in the cookie does not open media', async () => {
  const access = `glean_session=${encodeURIComponent(signJwt({ sub: 1, scope: 'access' }, 60))}`;
  assert.equal((await get('/media/scrapes/1/a.png', { cookie: access })).statusCode, 401);
});

test('svg files are sent with a policy that blocks scripts', async () => {
  const r = await get('/media/scrapes/1/b.svg');
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
});

test('no path reaches a file outside the media folder', async () => {
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'glean.db')));
  const tries = [
    '/media/..%2Fglean.db',
    '/media/%2e%2e%2fglean.db',
    '/media/..%5Cglean.db',
    '/media/scrapes/..%2F..%2Fglean.db',
    `/media/..%2F${path.basename(root)}-evil%2Fsecret.txt`,
    '/media/scrapes',
  ];
  for (const url of tries) {
    const r = await get(url);
    assert.equal(r.statusCode, 404, url);
    assert.ok(!r.body.startsWith('SQLite format') && r.body !== 'secret', url);
  }
});
