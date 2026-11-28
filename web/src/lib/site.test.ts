import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelected, type SiteInfo } from './site.tsx';

const main: SiteInfo = { code: 'demo', name: 'demo', isMain: true, baseUrl: 'http://127.0.0.1:4318/demo-forum', dir: null };
const rphang: SiteInfo = { code: 'rphang', name: 'rphang', isMain: false, baseUrl: 'https://rphang.land', dir: 'data/sites/rphang' };

test('a stored site that still exists stays selected', () => {
  assert.equal(resolveSelected('rphang', [main, rphang]), 'rphang');
});

test('a stored site that was removed falls back to the main site', () => {
  assert.equal(resolveSelected('xoa', [main, rphang]), main.code);
});

test('every site at once needs at least two sites', () => {
  assert.equal(resolveSelected('*', [main]), main.code);
  assert.equal(resolveSelected('*', [main, rphang]), '*');
});

test('nothing stored selects the main site', () => {
  assert.equal(resolveSelected(null, [main, rphang]), main.code);
});
