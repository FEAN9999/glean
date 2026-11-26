import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpack } from './i18n.tsx';

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

test('unpack shows a text the server wrote in both languages in the reader language', () => {
  const stored = '{"vi":"Không tìm thấy bài #5","en":"Thread #5 was not found"}';
  assert.equal(unpack(stored, 'vi-VN'), 'Không tìm thấy bài #5');
  assert.equal(unpack(stored, 'en-US'), 'Thread #5 was not found');
});

test('unpack leaves a plain text as it is', () => {
  // a row saved before both languages were kept, or a message that reads the same in both
  assert.equal(unpack('HTTP 500 — http://x.test', 'en-US'), 'HTTP 500 — http://x.test');
  // cut off on the way: better shown raw than not at all
  assert.equal(unpack('{"vi":"Không tìm', 'en-US'), '{"vi":"Không tìm');
});
