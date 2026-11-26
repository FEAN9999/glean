import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { omniDraftKey } from './Shell.tsx';

// Regression: ISSUE-010 — a keyword typed in the top box was wiped when the thread scope of the
// comment search was applied. Found by /qa-only on 2026-11-26.
// Report: .gstack/qa-reports/run-20261126T151753Z/qa-report-mixed-xamvn-clone-2026-11-26.md
const key = (url: string) => {
  const u = new URL(url, 'http://glean.test');
  return omniDraftKey(u.pathname, u.search);
};

test('the top box keeps what is typed in it while a filter of the search page changes', () => {
  assert.equal(key('/binh-luan/tu-khoa'), key('/binh-luan/tu-khoa?thread=3034'));
  assert.equal(key('/binh-luan/tu-khoa?q=xe'), key('/binh-luan/tu-khoa?q=xe&exact=1&changed=1'));
});

test('the top box shows the searched words again when they or the page change', () => {
  assert.notEqual(key('/binh-luan/tu-khoa?q=xe'), key('/binh-luan/tu-khoa?q=bep'));
  assert.notEqual(key('/binh-luan/tu-khoa?q=xe'), key('/bai-viet/tu-khoa?q=xe'));
  assert.notEqual(key('/sang'), key('/sang/12'));
});
