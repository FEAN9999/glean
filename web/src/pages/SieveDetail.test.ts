import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { TabEmpty } from './SieveDetail.tsx';

// Smaller observation of the /qa run on 2026-11-26 (.gstack/qa-reports/qa-report-localhost-2026-11-26.md):
// the Images tab of a failed job said "This thread has no images", though the job never read the thread.

const html = (failed: boolean) => renderToString(createElement(TabEmpty, { failed, title: 'Không có ảnh' }, 'Chủ đề này không có ảnh nào.'));

test('an empty tab of a failed job says the thread was not read to the end, not that it has nothing', () => {
  assert.match(html(true), /Chưa đọc xong bài/);
  assert.doesNotMatch(html(true), /Không có ảnh|không có ảnh nào/);
});

test('an empty tab of a job that finished keeps its own text', () => {
  assert.match(html(false), /<strong>Không có ảnh<\/strong>/);
  assert.match(html(false), /Chủ đề này không có ảnh nào\./);
});
