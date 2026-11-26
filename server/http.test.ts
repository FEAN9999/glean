import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ApiError, sendError } from './http.ts';

test('an error is sent in the language the request asks for, Vietnamese by default', async () => {
  const app = Fastify();
  app.get('/x', async (_req, reply) => sendError(reply, new ApiError(400, 'X', ['Sai rồi.', 'That is wrong.'])));
  const message = async (lang?: string) => (await app.inject({ url: '/x', headers: lang ? { 'accept-language': lang } : {} })).json().message;
  assert.equal(await message('en-US'), 'That is wrong.');
  assert.equal(await message('vi-VN'), 'Sai rồi.');
  assert.equal(await message(), 'Sai rồi.');
});

// Regression: ISSUE-004 — an error already on screen was not translated when the language changed
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md
test('an error also carries both languages, for a page that changes language while it shows the error', async () => {
  const app = Fastify();
  app.get('/x', async (_req, reply) => sendError(reply, new ApiError(400, 'X', ['Sai rồi.', 'That is wrong.'])));
  const body = (await app.inject({ url: '/x', headers: { 'accept-language': 'vi-VN' } })).json();
  assert.deepEqual(body.messages, { vi: 'Sai rồi.', en: 'That is wrong.' });
});

test('every error message written in the server code has an English text', () => {
  // A message written as a plain '…' or `…` string has one language only; write ['…', '…'] instead.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const oneLanguage: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/new ApiError\(\s*[^,]+,\s*'[A-Z0-9_]+',\s*['`]/g)) oneLanguage.push(`${f}: ${src.slice(m.index, m.index + 80)}`);
  }
  assert.deepEqual(oneLanguage, []);
});
