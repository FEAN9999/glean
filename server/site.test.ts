import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { cfg, loadConfig, updateConfig } from './config.ts';
import { DATA_DIR, DB_PATH, get, openStore, run, setTestFallback, siteCtxOrNull } from './db.ts';
import { ApiError } from './http.ts';
import {
  addSite,
  currentSite,
  forEachSite,
  mainSite,
  registerSites,
  removeSite,
  requestSite,
  siteByCode,
  siteForHost,
  siteMediaPrefix,
  siteMediaRoot,
  suggestSite,
  withSite,
} from './site.ts';

loadConfig(0);

const apiError = (code: string, status?: number) => (e: unknown) => e instanceof ApiError && e.code === code && (status == null || e.status === status);

test('the main site is created from the configured address and keeps data/glean.db', () => {
  assert.equal(mainSite().isMain, true);
  assert.equal(mainSite().dbPath, DB_PATH);
  assert.equal(mainSite().code, 'demo');
  assert.equal(mainSite().dir, null);
});

test('addSite creates its own folder and store', () => {
  addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'sites', 'rphang', 'glean.db')));
  assert.equal(
    withSite('rphang', () => cfg().source.baseUrl),
    'https://rphang.land',
  );
});

test('addSite refuses a taken code or a host another site already uses', () => {
  addSite({ baseUrl: 'https://x.test', code: 'x1', name: 'x1' });
  assert.throws(() => addSite({ baseUrl: 'https://www.X.test', code: 'x2', name: 'x2' }), apiError('SITE_HOST_TAKEN', 409));
  assert.throws(() => addSite({ baseUrl: 'https://y.test', code: 'x1', name: 'x1' }), apiError('SITE_CODE_TAKEN', 409));
  assert.throws(
    () => addSite({ baseUrl: 'https://z.test', code: 'Bad Code', name: 'z' }),
    (e: unknown) => e instanceof ApiError && e.status === 400,
  );
  assert.equal(siteByCode('x2'), undefined);
});

test('siteForHost ignores case and a leading www', () => {
  assert.equal(siteForHost('WWW.RPHANG.LAND')?.code, 'rphang');
  withSite('rphang', () => updateConfig({ source: { previousBaseUrls: ['https://old-rphang.test'] } }, 0));
  assert.equal(siteForHost('old-rphang.test')?.code, 'rphang');
  assert.equal(siteForHost('nowhere.test'), undefined);
});

test('suggestSite turns a host into a code', () => {
  assert.equal(suggestSite('https://rphang.land').code, 'rphang');
  assert.deepEqual(suggestSite('https://www.XamVN.com/forums/'), { code: 'xamvn', name: 'xamvn' });
  assert.equal(suggestSite('http://127.0.0.1:4318/demo-forum').code, 'demo');
});

test('removeSite keeps the folder and re-adding the code reattaches it', () => {
  const first = addSite({ baseUrl: 'https://rm1.test', code: 'rm1', name: 'rm1' });
  withSite('rm1', () => run('INSERT INTO forum(id, name) VALUES(?, ?)', 1, 'Chuyên mục rm1'));
  removeSite('rm1');
  assert.equal(siteByCode('rm1'), undefined);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'sites', 'rm1')));
  const again = addSite({ baseUrl: 'https://rm1.test', code: 'rm1', name: 'rm1' });
  assert.equal(again.db, first.db);
  assert.equal(
    withSite('rm1', () => get<{ name: string }>('SELECT name FROM forum WHERE id=1')?.name),
    'Chuyên mục rm1',
  );
  assert.throws(() => removeSite(mainSite().code), apiError('SITE_MAIN', 400));
});

test('forEachSite runs each site in its own context, and each site has its own media folder', async () => {
  const seen = await forEachSite(() => currentSite().code);
  assert.equal(seen[0].site, mainSite());
  assert.ok(seen.every((r) => r.value === r.site.code));
  const rphang = siteByCode('rphang')!;
  assert.equal(siteMediaRoot(rphang), path.join(DATA_DIR, 'sites', 'rphang', 'media'));
  assert.equal(siteMediaPrefix(rphang), '/media/sites/rphang');
  assert.equal(siteMediaRoot(mainSite()), cfg().storage.basePath);
  assert.equal(siteMediaPrefix(mainSite()), '/media');
});

async function appWithSites(opts?: { legacyMainFallback?: boolean }) {
  const app = Fastify();
  registerSites(app, opts);
  app.get('/api/threads/x', async () => currentSite().code);
  app.post('/api/threads/x', async () => currentSite().code);
  app.get('/api/scrapes/processed', async (req) => requestSite(req)?.code ?? '*');
  await app.ready();
  return app;
}

test('site routes need x-glean-site and merge routes accept *', async () => {
  const app = await appWithSites();
  const call = (url: string, site?: string) => app.inject({ url, headers: site ? { 'x-glean-site': site } : {} });

  const none = await call('/api/threads/x');
  assert.equal(none.statusCode, 400);
  assert.equal(none.json().code, 'SITE_REQUIRED');
  const unknown = await call('/api/threads/x', 'nope');
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().code, 'SITE_UNKNOWN');
  assert.equal((await call('/api/threads/x', 'rphang')).body, 'rphang');
  assert.equal((await call('/api/threads/x', '*')).statusCode, 400);
  assert.equal((await call('/api/scrapes/processed', '*')).body, '*');
  assert.equal((await call('/api/scrapes/processed', 'rphang')).body, 'rphang');
});

test('a request with a large body still runs in the site it names', async () => {
  const app = Fastify();
  registerSites(app);
  app.post('/api/threads/x', async () => currentSite().code);
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = app.server.address() as { port: number };
    // Big enough to arrive in several chunks, after the request hooks have run.
    const res = await fetch(`http://127.0.0.1:${port}/api/threads/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-glean-site': 'rphang' },
      body: JSON.stringify({ text: 'x'.repeat(1_000_000) }),
    });
    assert.equal(await res.text(), 'rphang');
  } finally {
    await app.close();
  }
});

test('account routes are shared: they need no x-glean-site and run outside any site', async () => {
  const app = Fastify();
  registerSites(app);
  app.put('/api/accounts/change-password', async (req) => ({ ctx: siteCtxOrNull()?.code ?? null, site: requestSite(req) }));
  await app.ready();
  // Without the tests' fallback site, so a missing context shows as null.
  const prev = setTestFallback(null);
  try {
    const res = await app.inject({ method: 'PUT', url: '/api/accounts/change-password', payload: {} });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ctx: null, site: null });
  } finally {
    setTestFallback(prev);
  }
});

test('with the legacy fallback, a request without x-glean-site runs in the main site', async () => {
  const app = await appWithSites({ legacyMainFallback: true });
  assert.equal((await app.inject({ url: '/api/threads/x' })).body, mainSite().code);
  assert.equal((await app.inject({ url: '/api/scrapes/processed' })).body, mainSite().code);
  const unknown = await app.inject({ url: '/api/threads/x', headers: { 'x-glean-site': 'nope' } });
  assert.equal(unknown.json().code, 'SITE_UNKNOWN');
});

test('the sites API lists, adds, renames and removes sites', async () => {
  const app = await appWithSites();
  const suggest = await app.inject({ url: '/api/sites/suggest?baseUrl=' + encodeURIComponent('https://www.api-site.test/') });
  assert.deepEqual(suggest.json().data, { code: 'api-site', name: 'api-site' });

  const added = await app.inject({ method: 'POST', url: '/api/sites', payload: { baseUrl: 'https://api-site.test', code: 'api-site', name: 'API' } });
  assert.deepEqual(added.json().data, { code: 'api-site', name: 'API', isMain: false, baseUrl: 'https://api-site.test', dir: path.join(DATA_DIR, 'sites', 'api-site') });

  const renamed = await app.inject({ method: 'PATCH', url: '/api/sites/api-site', payload: { name: 'API 2' } });
  assert.equal(renamed.json().data.name, 'API 2');

  const list = (await app.inject({ url: '/api/sites' })).json().data as { code: string; isMain: boolean }[];
  assert.equal(list[0].code, mainSite().code);
  assert.equal(list[0].isMain, true);
  assert.ok(list.some((s) => s.code === 'api-site'));

  const removed = await app.inject({ method: 'DELETE', url: '/api/sites/api-site' });
  assert.equal(removed.json().data, true);
  assert.ok(!(await app.inject({ url: '/api/sites' })).json().data.some((s: { code: string }) => s.code === 'api-site'));
});

test('upgrading an old database only adds', () => {
  const file = path.join(DATA_DIR, 'old.db');
  const old = openStore(file);
  old.exec('DROP TABLE site; ALTER TABLE backup_run DROP COLUMN site_code; PRAGMA user_version = 3');
  old.exec(`INSERT INTO thread (id, forum_id, title, author, url, created_at, updated_at) VALUES (7, 1, 'Cũ', 'a', 'http://x/7', '2026-01-01', '2026-01-01')`);
  old.exec(`INSERT INTO scrape (id, thread_id, thread_url, source, status, created_at) VALUES (1, 7, 'http://x/7', 'demo', 2, '2026-01-01')`);
  old.exec(`INSERT INTO scrape_image (scrape_id, page, origin_url, current_url) VALUES (1, 1, 'http://x/a.jpg', '/media/scrapes/1/a.jpg')`);
  old.close();

  const d = openStore(file);
  const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(d.prepare(`SELECT 1 FROM sqlite_master WHERE name='site'`).get());
  assert.ok(cols('backup_run').includes('site_code'));
  assert.deepEqual({ ...(d.prepare('SELECT id, title, url FROM thread').get() as object) }, { id: 7, title: 'Cũ', url: 'http://x/7' });
  assert.equal((d.prepare('SELECT COUNT(*) n FROM scrape').get() as { n: number }).n, 1);
  assert.equal((d.prepare('SELECT current_url c FROM scrape_image').get() as { c: string }).c, '/media/scrapes/1/a.jpg');
  d.close();
});
