import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type HTTPMethods } from 'fastify';
import { loadConfig } from './config.ts';
import { registerApiGuard, registerAuth } from './auth.ts';
import { registerMedia } from './media.ts';
import { registerSearch } from './search.ts';
import { registerSync } from './sync.ts';
import { registerScraper } from './scraper.ts';
import { registerSystem } from './system.ts';
import { registerBackup } from './backup.ts';
import { registerSites } from './site.ts';

loadConfig(0);

/** Routes that answer without an access token: they check nothing, or something else themselves. */
const PUBLIC = [
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/verify-2fa',
  'GET /api/auth/validate-token',
  'POST /api/auth/logout',
  'POST /api/auth/refresh/:userId/:token',
  'GET /api/systems/version',
  'GET /api/systems/maintenance',
  'GET /api/events', // the EventSource stream checks the browser cookie
];

async function appWithEveryRoute() {
  const app = Fastify();
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD' && r.url.startsWith('/api/')) routes.push(`${m} ${r.url}`);
  });
  registerApiGuard(app);
  registerSites(app);
  registerAuth(app);
  registerMedia(app);
  registerSearch(app);
  registerSync(app);
  registerScraper(app);
  registerSystem(app, 0);
  registerBackup(app);
  // The realtime routes are declared in index.ts, which starts the server when imported: same paths here.
  app.get('/api/events', async () => ({}));
  app.post('/api/events/:id/join/:group', async () => ({}));
  app.post('/api/events/:id/leave/:group', async () => ({}));
  await app.ready();
  return { app, routes };
}

test('every API route except the public ones turns away a request without an access token', async () => {
  const { app, routes } = await appWithEveryRoute();
  assert.ok(routes.length > 50, `found only ${routes.length} routes`);
  for (const p of PUBLIC) assert.ok(routes.includes(p), `public route ${p} no longer exists`);
  const open: string[] = [];
  for (const r of routes.filter((r) => !PUBLIC.includes(r))) {
    const [method, path] = r.split(' ');
    const res = await app.inject({
      method: method as HTTPMethods,
      url: path.replace(/:\w+/g, '1').replace('*', 'x'),
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
    });
    if (res.statusCode !== 401 || res.json().code !== 'UNAUTHORIZED') open.push(`${r} → ${res.statusCode}`);
  }
  assert.deepEqual(open, []);
});
