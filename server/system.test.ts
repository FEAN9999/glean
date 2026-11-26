import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from './config.ts';
import { registerApiGuard, registerAuth } from './auth.ts';
import { registerSystem } from './system.ts';

loadConfig(0);

const app = Fastify();
registerApiGuard(app);
registerAuth(app);
registerSystem(app, 0);
await app.ready();
const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'an', password: 'mat-khau-thu-1' } });
const headers = { authorization: `Bearer ${setup.json().data.accessToken}` };
const save = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/systems/config', headers, payload: payload as object });
const settings = () => app.inject({ url: '/api/systems/config', headers });

// Regression: ISSUE-008 — a list setting sent as text was stored, and then Settings could not load
// and no request could put it right. Found by /qa-only on 2026-11-26.
// Report: .gstack/qa-reports/run-20261126T151753Z/qa-report-mixed-xamvn-clone-2026-11-26.md
test('a setting sent with the wrong type is refused and not stored', async () => {
  const before = (await settings()).json().data;
  for (const patch of [
    { proxy: { list: '10.0.0.1:8080' } },
    { proxy: { list: [8080] } },
    { proxy: { enabled: 'yes' } },
    { scraper: { ignoredDomains: 'ads.test' } },
    { source: { forums: [{ id: 'one', name: 'Xe' }] } },
    { source: { forums: [{ id: 1 }] } },
    { telegram: { chatId: 123 } },
    { scraper: 'fast' },
  ]) {
    const r = await save(patch);
    assert.deepEqual([r.statusCode, r.json().code], [400, 'INVALID_SETTING'], JSON.stringify(patch));
  }
  const after = await settings();
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json().data, before);
});

test('a setting with the right type is still saved, and a missing value leaves the setting as it was', async () => {
  const r = await save({ proxy: { list: ['10.0.0.1:8080'], enabled: null }, source: { forums: [{ id: 7, name: 'Xe' }] } });
  assert.equal(r.statusCode, 200);
  const { proxy, source } = (await settings()).json().data;
  assert.deepEqual([proxy.list, proxy.enabled, source.forums], [['10.0.0.1:8080'], false, [{ id: 7, name: 'Xe' }]]);
});
