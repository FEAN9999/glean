import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import { telegram } from './notify.ts';

loadConfig(0);

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

test('a test message without a bot token says why in both languages', async () => {
  assert.deepEqual(await telegram('x', true), { ok: false, error: ['Thiếu bot token hoặc chat ID', 'The bot token or chat ID is missing'] });
});
