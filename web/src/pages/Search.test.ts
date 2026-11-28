import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSiteOf } from './Search.tsx';

test('searchSiteOf prefers the site in the URL over the picker', () => {
  assert.equal(searchSiteOf(new URLSearchParams('trang=rphang'), '*'), 'rphang');
  assert.equal(searchSiteOf(new URLSearchParams(''), 'demo'), 'demo');
});
