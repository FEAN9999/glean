import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg, loadConfig } from './config.ts';
import { addSite, withSite } from './site.ts';
import { telegram } from './notify.ts';

loadConfig(0);
addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

test('a test message without a bot token says why in both languages', async () => {
  assert.deepEqual(await telegram('x', true), { ok: false, error: ['Thiếu bot token hoặc chat ID', 'The bot token or chat ID is missing'] });
});

test('telegram messages start with the site name', async () => {
  const t = cfg().telegram;
  const saved = { ...t };
  Object.assign(t, { enabled: true, botToken: 'tok', chatId: '1' });
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(String(init?.body)).text);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await withSite('rphang', () => telegram('xong')), { ok: true });
    assert.equal(sent[0], '[rphang] xong');
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(t, saved);
  }
});
