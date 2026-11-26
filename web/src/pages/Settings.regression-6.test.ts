import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { LimitNote } from './Settings.tsx';

// Regression: ISSUE-006 — Settings raised an out-of-range number to its limit without saying so
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

const note = (value: number, min: number) => renderToString(createElement(LimitNote, { value, min }));

test('a number field says what will be saved while the number typed is under its limit', () => {
  assert.match(note(1, 5), /Nhỏ nhất là 5\. Khi lưu, số này sẽ thành 5\./);
  assert.match(note(-10, 0), /Nhỏ nhất là 0\./);
});

test('a number field at or above its limit says nothing', () => {
  assert.equal(note(5, 5), '');
  assert.equal(note(40, 5), '');
});
