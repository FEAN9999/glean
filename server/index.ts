import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.ts';
import { ApiError, sendError } from './http.ts';
import { registerAuth, userFromRequest } from './auth.ts';
import { registerSearch } from './search.ts';
import { registerSync, initAutoSync } from './sync.ts';
import { registerScraper, initScraper } from './scraper.ts';
import { registerSystem, APP_VERSION } from './system.ts';
import { registerMedia, cookieUser } from './media.ts';
import { registerDemoForum } from './demo/forum.ts';
import { initNet } from './net.ts';
import { addClient, removeClient, joinGroup, leaveGroup } from './events.ts';

const PORT = Number(process.env.SANG_PORT ?? 4318);
const HOST = process.env.SANG_HOST ?? '127.0.0.1';

loadConfig(PORT);
initNet();

const app = Fastify({
  logger: { level: process.env.SANG_LOG ?? 'warn' },
  routerOptions: { ignoreTrailingSlash: true },
  bodyLimit: 2 * 1024 * 1024,
});

const PUBLIC = [
  /^\/api\/auth\/(status|setup|login|verify-2fa|validate-token|logout)$/,
  /^\/api\/auth\/refresh\//,
  /^\/api\/systems\/(version|maintenance)$/,
  /^\/api\/events/,
];

app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/')) return;
  if (PUBLIC.some((r) => r.test(url))) return;
  const uid = userFromRequest(req);
  if (uid == null) return sendError(reply, new ApiError(401, 'UNAUTHORIZED', 'Phiên đăng nhập đã hết hạn.', 'silent'));
  (req as any).userId = uid;
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) return sendError(reply, err);
  const e = err as { statusCode?: number; message: string };
  if (e.statusCode && e.statusCode < 500) return sendError(reply, new ApiError(e.statusCode, 'BAD_REQUEST', e.message, 'toast'));
  app.log.error(err);
  return sendError(reply, new ApiError(500, 'SERVER_ERROR', `Lỗi máy chủ: ${e.message}`, 'toast'));
});

/* ---- realtime (Server-Sent Events) ---- */
app.get<{ Querystring: { groups?: string } }>('/api/events', (req, reply) => {
  if (!cookieUser(req)) {
    reply.code(401).send({ success: false, code: 'UNAUTHORIZED' });
    return;
  }
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const groups = (req.query.groups ?? '*').split(',').filter(Boolean);
  const id = addClient(reply, groups);
  reply.raw.write(`retry: 3000\ndata: ${JSON.stringify({ type: 0, data: { clientId: id, version: APP_VERSION } })}\n\n`);
  req.raw.on('close', () => removeClient(id));
});
app.post<{ Params: { id: string; group: string } }>('/api/events/:id/join/:group', async (req) => {
  joinGroup(Number(req.params.id), req.params.group);
  return { success: true, data: true };
});
app.post<{ Params: { id: string; group: string } }>('/api/events/:id/leave/:group', async (req) => {
  leaveGroup(Number(req.params.id), req.params.group);
  return { success: true, data: true };
});

registerAuth(app);
registerMedia(app);
registerSearch(app);
registerSync(app);
registerScraper(app);
registerSystem(app, PORT);
registerDemoForum(app);

/* ---- built web app (production) ---- */
const webDist = path.resolve('dist/web');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.code(404).send({ success: false, code: 'NOT_FOUND' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: HOST });
console.log(`Sàng ${APP_VERSION} — http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);

initScraper();
initAutoSync();
