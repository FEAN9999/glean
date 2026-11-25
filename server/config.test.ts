import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, loadConfig, maskedConfig, cfg, unmaskPatch, updateConfig } from './config.ts';
import { ApiError } from './http.ts';
import { run } from './db.ts';

loadConfig(0);

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
