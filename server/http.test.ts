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
