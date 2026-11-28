import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MASK, loadConfig, loadSiteConfig, maskedConfig, cfg, onConfigChange, onSharedConfigChange, unmaskPatch, updateConfig } from './config.ts';
import { ApiError } from './http.ts';
import { DATA_DIR, NoSiteError, get, mainGet, openStore, run, runInSite, setTestFallback, siteCtxOrNull } from './db.ts';

loadConfig(0);

const bCtx = { code: 'b', db: openStore(path.join(DATA_DIR, 'b.db')) };
loadSiteConfig(bCtx, { baseUrl: 'http://b.test' });
const storedIn = (key: string, inB: boolean) =>
  (inB ? runInSite(bCtx, () => get<{ value: string }>('SELECT value FROM config WHERE key=?', key)) : mainGet<{ value: string }>('SELECT value FROM config WHERE key=?', key))?.value ?? '';

const withProxy = (line: string) => updateConfig({ proxy: { enabled: false, list: [line], healthCheckUrl: '' } }, 0);

test('a masked proxy password sent back unchanged keeps the stored password', () => {
  withProxy('1.2.3.4:8080:alice:secret');
  const sent = maskedConfig(cfg()).proxy.list;
  assert.deepEqual(sent, [`1.2.3.4:8080:alice:${MASK}`]);
  assert.deepEqual(unmaskPatch({ proxy: { list: sent } }).proxy.list, ['1.2.3.4:8080:alice:secret']);
});

test('a masked proxy password is never saved when the host, port or user changed', () => {
  withProxy('1.2.3.4:8080:alice:secret');
  for (const line of [`1.2.3.4:8080:bob:${MASK}`, `1.2.3.4:9090:alice:${MASK}`, `5.6.7.8:8080:alice:${MASK}`]) {
    assert.throws(
      () => unmaskPatch({ proxy: { list: [line] } }),
      (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'PROXY_PASSWORD_REQUIRED',
      line,
    );
  }
});

test('a number setting below the limit the Settings form shows is saved at that limit', () => {
  // An emptied number field sends 0; 0 pages in parallel used to stall the sieve queue for good.
  updateConfig({ scraper: { concurrentPages: 0 }, source: { postsPerPage: 0 }, search: { pageSize: 2 } }, 0);
  try {
    assert.equal(cfg().scraper.concurrentPages, 1);
    assert.equal(cfg().source.postsPerPage, 1);
    assert.equal(cfg().search.pageSize, 5);
  } finally {
    updateConfig({ scraper: { concurrentPages: 3 }, source: { postsPerPage: 20 }, search: { pageSize: 20 } }, 0);
  }
});

test('a number setting may be 0 where 0 means off, but never negative or not a number', () => {
  // @ts-expect-error a string where a number belongs, as a hand-written request could send
  updateConfig({ scraper: { retentionHours: 0, batchDelayMs: -5, minCommentLength: 'abc' } }, 0);
  try {
    assert.equal(cfg().scraper.retentionHours, 0);
    assert.equal(cfg().scraper.batchDelayMs, 0);
    assert.equal(cfg().scraper.minCommentLength, 12);
  } finally {
    updateConfig({ scraper: { batchDelayMs: 150 } }, 0);
  }
});

test('a 0 already stored by an earlier version is read back at the limit', () => {
  run("UPDATE config SET value=json_set(value, '$.concurrentPages', 0) WHERE key='scraper'");
  try {
    assert.equal(loadConfig(0).scraper.concurrentPages, 1);
  } finally {
    updateConfig({ scraper: { concurrentPages: 3 } }, 0);
  }
});

test('a settings section an earlier version saved but no longer has is not loaded or sent to the browser', () => {
  run(
    "INSERT INTO config(key, value, updated_at) VALUES('ai', ?, '') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify({ chatGpt: { enabled: true, apiKey: 'sk-old-key' } }),
  );
  const sent = maskedConfig(loadConfig(0));
  assert.equal('ai' in sent, false);
  assert.equal(JSON.stringify(sent).includes('sk-old-key'), false);
});

test('a changed proxy user with a newly typed password is kept as typed', () => {
  withProxy('1.2.3.4:8080:alice:secret');
  assert.deepEqual(unmaskPatch({ proxy: { list: ['1.2.3.4:8080:bob:newpass'] } }).proxy.list, ['1.2.3.4:8080:bob:newpass']);
});

test('site sections are stored in the store of the site', () => {
  assert.equal(runInSite(bCtx, () => cfg().source.baseUrl), 'http://b.test');
  assert.deepEqual(runInSite(bCtx, () => cfg().source.forums), []);
  runInSite(bCtx, () => updateConfig({ source: { postsPerPage: 33 } }, 0));
  assert.equal(runInSite(bCtx, () => cfg().source.postsPerPage), 33);
  assert.equal(cfg().source.postsPerPage, 20);
  assert.equal(JSON.parse(storedIn('source', true)).postsPerPage, 33);
  assert.equal(storedIn('source', false).includes('33'), false);
});

test('shared sections are shared by every site', () => {
  updateConfig({ telegram: { chatId: 'x' } }, 0);
  assert.equal(runInSite(bCtx, () => cfg().telegram.chatId), 'x');
  assert.equal(storedIn('telegram', true), '');
});

test('semantic search settings belong to each site', () => {
  runInSite(bCtx, () => updateConfig({ search: { semanticSearchUrl: 'http://sem.b.test', pageSize: 40 } }, 0));
  try {
    assert.equal(runInSite(bCtx, () => cfg().search.semanticSearchUrl), 'http://sem.b.test');
    assert.equal(cfg().search.semanticSearchUrl, '');
    assert.equal(runInSite(bCtx, () => cfg().search.pageSize), 40);
    assert.equal(cfg().search.pageSize, 40);
    assert.equal(storedIn('search', false).includes('sem.b.test'), false);
    assert.deepEqual(Object.keys(JSON.parse(storedIn('search', true))), ['semanticSearchUrl', 'semanticTopK']);
  } finally {
    updateConfig({ search: { pageSize: 20 } }, 0);
  }
});

test('site sections outside a site throw', () => {
  const prev = setTestFallback(null);
  try {
    assert.throws(() => cfg().source, NoSiteError);
    assert.equal(cfg().auth.issuer, 'glean');
    // A change that includes a site section is refused whole, before any of it is stored.
    assert.throws(() => updateConfig({ telegram: { chatId: 'none' }, sync: { posts: { enabled: false } } }, 0), NoSiteError);
    assert.equal(cfg().telegram.chatId, 'x');
    updateConfig({ telegram: { chatId: 'outside' } }, 0);
    assert.equal(cfg().telegram.chatId, 'outside');
  } finally {
    setTestFallback(prev);
  }
});

test('onConfigChange runs in the context of the changed site only', () => {
  let seen: (string | undefined)[] = [];
  let sharedCalls = 0;
  onConfigChange(() => seen.push(siteCtxOrNull()?.code));
  onSharedConfigChange(() => sharedCalls++);
  runInSite(bCtx, () => updateConfig({ scraper: { minCommentLength: 5 } }, 0));
  assert.deepEqual(seen, ['b']);
  assert.equal(sharedCalls, 0);
  seen = [];
  updateConfig({ telegram: { chatId: 'y' } }, 0);
  assert.deepEqual(seen.sort(), ['b', 'main']);
  assert.equal(sharedCalls, 1);
});
