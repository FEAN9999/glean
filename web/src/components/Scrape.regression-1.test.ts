import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeStatus, threadOnForum } from './Scrape.tsx';

// Regression: ISSUE-001 — a failed sieve said "The thread is still on the forum"
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

test('threadOnForum: only a completed job says whether its thread is still there', () => {
  assert.equal(threadOnForum({ status: ScrapeStatus.Completed, isThreadDeleted: false }), true);
  assert.equal(threadOnForum({ status: ScrapeStatus.Completed, isThreadDeleted: true }), false);
  // A failed job got no answer it can vouch for: the forum may not have the thread at all.
  assert.equal(threadOnForum({ status: ScrapeStatus.Failed, isThreadDeleted: false }), null);
  for (const status of [ScrapeStatus.Waiting, ScrapeStatus.Processing]) assert.equal(threadOnForum({ status, isThreadDeleted: false }), null);
});
