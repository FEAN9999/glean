import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BiError, biOf, pack } from './bilingual.ts';
import { ApiError } from './http.ts';

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

test('pack keeps both languages in one string', () => {
  assert.equal(pack(['Lỗi', 'Error']), '{"vi":"Lỗi","en":"Error"}');
});

test('pack leaves a text that reads the same in both languages plain', () => {
  assert.equal(pack(['HTTP 500 — http://x.test', 'HTTP 500 — http://x.test']), 'HTTP 500 — http://x.test');
});

test('biOf reads both languages of an error', () => {
  assert.deepEqual(biOf(new BiError(['Không tìm thấy', 'Not found'])), ['Không tìm thấy', 'Not found']);
  assert.deepEqual(biOf(new ApiError(400, 'X', ['Sai', 'Wrong'])), ['Sai', 'Wrong']);
  // a network or file system error has one message: it is shown as it is in both languages
  assert.deepEqual(biOf(new Error('fetch failed')), ['fetch failed', 'fetch failed']);
});

test('no server error is raised with a Vietnamese-only message', () => {
  // The message of an error raised in a sieve job, a sync run or a backup is kept and shown later,
  // so it needs both languages: BiError, or an ApiError with a [vi, en] pair.
  const dir = import.meta.dirname;
  const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const found = files.flatMap((f) =>
    [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/new Error\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)]
      .filter((m) => /[À-ỹ]/.test(m[1]))
      .map((m) => `${f}: ${m[1]}`),
  );
  assert.deepEqual(found, []);
});
