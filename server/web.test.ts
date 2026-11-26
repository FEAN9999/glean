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

// Regression: ISSUE-005 — a missing file under /assets/ answered 200 with the page shell
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md
test('a missing file under /assets/ answers 404, not the page shell', async () => {
  const app = await appWithBuild();
  // the script of an earlier build, still asked for by a page that was open during the update
  const gone = await app.inject({ url: '/assets/index-0ldha5h.js' });
  assert.equal(gone.statusCode, 404);
  assert.doesNotMatch(gone.body, /id="root"/);
});
