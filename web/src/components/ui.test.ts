import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageItems } from './ui.tsx';

test('pageItems lists every page when there are few', () => {
  assert.deepEqual(pageItems(1, 1), [1]);
  assert.deepEqual(pageItems(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('pageItems shows the ends and the pages around the current one, with gaps', () => {
  assert.deepEqual(pageItems(1, 20), [1, 2, 3, 4, 5, null, 20]);
  assert.deepEqual(pageItems(10, 20), [1, null, 9, 10, 11, null, 20]);
  assert.deepEqual(pageItems(20, 20), [1, null, 16, 17, 18, 19, 20]);
});

test('pageItems keeps the same length on every page, so the buttons do not jump', () => {
  for (let page = 1; page <= 20; page++) {
    const items = pageItems(page, 20);
    assert.equal(items.length, 7, `page ${page}`);
    assert.ok(items.includes(page) && items[0] === 1 && items.at(-1) === 20, `page ${page}`);
  }
});
