import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Empty, pageItems } from './ui.tsx';

// Smaller observation of the /qa run on 2026-11-26 (.gstack/qa-reports/qa-report-localhost-2026-11-26.md):
// the not-found page had no heading.

test('an empty state that is the whole page carries the page heading', () => {
  assert.match(renderToString(createElement(Empty, { title: 'Không có trang này', page: true })), /<h1>Không có trang này<\/h1>/);
  // inside a page that has its own heading it stays plain text
  assert.match(renderToString(createElement(Empty, { title: 'Không có ảnh' })), /<strong>Không có ảnh<\/strong>/);
});

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
