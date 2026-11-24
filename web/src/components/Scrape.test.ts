import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageSplit, type Scrape } from './Scrape.tsx';

const job = (currentPage: number, totalPages: number) => ({ currentPage, totalPages }) as Scrape;

test('pageSplit: pages read, the page being read, and pages left', () => {
  assert.deepEqual(pageSplit(job(3, 10)), { total: 10, done: 3, current: 1, left: 6 });
  assert.deepEqual(pageSplit(job(0, 1)), { total: 1, done: 0, current: 1, left: 0 });
});

test('pageSplit: every page counts as read once they are, or once images are downloading', () => {
  assert.deepEqual(pageSplit(job(10, 10)), { total: 10, done: 10, current: 0, left: 0 });
  assert.deepEqual(pageSplit(job(12, 10)), { total: 10, done: 10, current: 0, left: 0 });
  assert.deepEqual(pageSplit(job(4, 10), { downloaded: 1, total: 30 }), { total: 10, done: 10, current: 0, left: 0 });
});
