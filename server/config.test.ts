import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, loadConfig, maskedConfig, cfg, unmaskPatch, updateConfig } from './config.ts';
import { ApiError } from './http.ts';

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

test('a changed proxy user with a newly typed password is kept as typed', () => {
  withProxy('1.2.3.4:8080:alice:secret');
  assert.deepEqual(unmaskPatch({ proxy: { list: ['1.2.3.4:8080:bob:newpass'] } }).proxy.list, ['1.2.3.4:8080:bob:newpass']);
});
