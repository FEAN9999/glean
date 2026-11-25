import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerWeb } from './web.ts';

/** A built web app as `vite build` writes it: the page shell plus a hashed asset. */
async function appWithBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-web-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
  const app = Fastify();
  await registerWeb(app, root);
  return app;
}

test('hashed assets are cached for good, while the page shell is checked on every load', async () => {
  const app = await appWithBuild();
  const asset = await app.inject({ url: '/assets/index-abc123.js' });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const url of ['/', '/index.html', '/sang']) {
    const page = await app.inject({ url });
    assert.equal(page.statusCode, 200, url);
    assert.match(page.body, /id="root"/, url);
    assert.equal(page.headers['cache-control'], 'public, max-age=0', url);
  }
});
