import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Empty, pageItems, toastTimers } from './ui.tsx';

// Smaller observations of the /qa run on 2026-11-26 (.gstack/qa-reports/qa-report-localhost-2026-11-26.md):
// a toast with a button closed while the pointer was on its way to it; the not-found page had no heading.

test('a toast left alone closes after its time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed: number[] = [];
  toastTimers((id) => closed.push(id)).start(7, 4500);
  t.mock.timers.tick(4499);
  assert.deepEqual(closed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(closed, [7]);
});

test('a toast is kept while it is pointed at or focused, and closes once that ends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed: number[] = [];
  const timers = toastTimers((id) => closed.push(id));
  timers.start(1, 9000);
  t.mock.timers.tick(8000);
  timers.hold(1); // the pointer reaches the toast one second before it would close
  t.mock.timers.tick(60_000);
  assert.deepEqual(closed, []);
  timers.start(1, 9000); // the pointer leaves
  t.mock.timers.tick(8999);
  assert.deepEqual(closed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(closed, [1]);
});

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
