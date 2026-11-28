import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from './config.ts';
import { registerApiGuard, registerAuth } from './auth.ts';
import { registerSystem } from './system.ts';
import { addSite, mainSite, registerSites } from './site.ts';
import { ApiError, sendError } from './http.ts';

loadConfig(0);
addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });

const app = Fastify();
app.setErrorHandler((e, _req, reply) => (e instanceof ApiError ? sendError(reply, e) : reply.send(e)));
registerSites(app);
registerApiGuard(app);
registerAuth(app);
registerSystem(app, 0);
await app.ready();
const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'an', password: 'mat-khau-thu-1' } });
const auth = { authorization: `Bearer ${setup.json().data.accessToken}` };
const save = (payload: unknown, site = mainSite().code) =>
  app.inject({ method: 'PUT', url: '/api/systems/config', headers: { ...auth, 'x-glean-site': site }, payload: payload as object });
const settings = (site = mainSite().code) => app.inject({ url: '/api/systems/config', headers: { ...auth, 'x-glean-site': site } });

// Regression: ISSUE-008 — a list setting sent as text was stored, and then Settings could not load
// and no request could put it right. Found by /qa-only on 2026-11-26.
// Report: .gstack/qa-reports/run-20261126T151753Z/qa-report-mixed-xamvn-clone-2026-11-26.md
test('a setting sent with the wrong type is refused and not stored', async () => {
  const before = (await settings()).json().data;
  for (const patch of [
    { proxy: { list: '10.0.0.1:8080' } },
    { proxy: { list: [8080] } },
    { proxy: { enabled: 'yes' } },
    { scraper: { ignoredDomains: 'ads.test' } },
    { source: { forums: [{ id: 'one', name: 'Xe' }] } },
    { source: { forums: [{ id: 1 }] } },
    { telegram: { chatId: 123 } },
    { scraper: 'fast' },
  ]) {
    const r = await save(patch);
    assert.deepEqual([r.statusCode, r.json().code], [400, 'INVALID_SETTING'], JSON.stringify(patch));
  }
  const after = await settings();
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json().data, before);
});

test('a setting with the right type is still saved, and a missing value leaves the setting as it was', async () => {
  const r = await save({ proxy: { list: ['10.0.0.1:8080'], enabled: null }, source: { forums: [{ id: 7, name: 'Xe' }] } });
  assert.equal(r.statusCode, 200);
  const { proxy, source } = (await settings()).json().data;
  assert.deepEqual([proxy.list, proxy.enabled, source.forums], [['10.0.0.1:8080'], false, [{ id: 7, name: 'Xe' }]]);
});

// Regression: ISSUE-011 — the forum address took any scheme, while "Find sections" needs http(s).
// Found by /qa-only on 2026-11-26.
test('the forum address must start with http:// or https://', async () => {
  const before = (await settings()).json().data.source.baseUrl;
  for (const baseUrl of ['ftp://forum.example.org', 'javascript:alert(1)', 'file:///C:/forum']) {
    const r = await save({ source: { baseUrl } });
    assert.deepEqual([r.statusCode, r.json().code], [400, 'INVALID_URL'], baseUrl);
  }
  assert.equal((await settings()).json().data.source.baseUrl, before);
  assert.equal((await save({ source: { baseUrl: 'https://forum.example.org' } })).statusCode, 200);
});

// Regression: ISSUE-012 — an old domain typed without https:// was saved but never matched, so
// links on it were still refused. Found by /qa-only on 2026-11-27.
// Report: .gstack/qa-reports/run-20261126T170250Z/qa-report-mixed-xamvn-clone-2026-11-26.md
test('an old domain must be a full http(s) address; blank lines are dropped', async () => {
  const before = (await settings()).json().data.source.previousBaseUrls;
  for (const entry of ['old.example', 'ftp://old.example', 'not a url']) {
    const r = await save({ source: { previousBaseUrls: ['https://ok.example', entry] } });
    assert.deepEqual([r.statusCode, r.json().code], [400, 'INVALID_URL'], entry);
  }
  assert.match((await save({ source: { previousBaseUrls: ['old.example'] } })).json().messages.vi, /https:\/\/old\.example/);
  assert.deepEqual((await settings()).json().data.source.previousBaseUrls, before);

  const r = await save({ source: { previousBaseUrls: [' https://old.example ', '', 'http://older.example'] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((await settings()).json().data.source.previousBaseUrls, ['https://old.example', 'http://older.example']);
});

test('settings of one site do not reach another', async () => {
  assert.equal((await save({ source: { postsPerPage: 25 } }, 'rphang')).statusCode, 200);
  assert.equal((await settings('rphang')).json().data.source.postsPerPage, 25);
  const main = (await settings()).json();
  assert.equal(main.data.source.postsPerPage, 20);
  assert.equal(main.site.code, mainSite().code);
  assert.equal((await settings('rphang')).json().site.code, 'rphang');
});

test('shared settings can be saved with *', async () => {
  assert.equal((await save({ backup: { keep: 9 } }, '*')).statusCode, 200);
  assert.equal((await settings()).json().data.backup.keep, 9);
  for (const patch of [{ source: { postsPerPage: 30 } }, { search: { semanticTopK: 3 } }, { sync: {} }]) {
    const r = await save(patch, '*');
    assert.deepEqual([r.statusCode, r.json().code], [400, 'SITE_REQUIRED'], JSON.stringify(patch));
  }
  assert.equal((await settings()).json().data.source.postsPerPage, 20);
});

test('a source address another site uses is refused', async () => {
  for (const patch of [{ source: { baseUrl: 'https://www.rphang.land/' } }, { source: { previousBaseUrls: ['https://rphang.land'] } }]) {
    const r = await save(patch);
    assert.deepEqual([r.statusCode, r.json().code], [409, 'SITE_HOST_TAKEN'], JSON.stringify(patch));
  }
  assert.equal((await save({ source: { baseUrl: 'https://rphang.land/' } }, 'rphang')).statusCode, 200);
});
