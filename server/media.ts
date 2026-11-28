import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cfg } from './config.ts';
import { ok } from './http.ts';
import { signJwt, verifyJwt } from './auth.ts';
import { siteByCode, siteMediaRoot } from './site.ts';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
};

/* -------- cookie used for <img>/<video> and EventSource, which cannot send Bearer headers -------- */

export const COOKIE = 'glean_session';

export function readCookie(req: FastifyRequest, name = COOKIE) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function cookieUser(req: FastifyRequest): number | null {
  const body = verifyJwt<{ sub: number; scope: string }>(readCookie(req));
  return body?.scope === 'browser' ? body.sub : null;
}

export function browserCookie(userId: number) {
  const days = cfg().auth.refreshTokenDays;
  const token = signJwt({ sub: userId, scope: 'browser' }, days * 86400);
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${days * 86400}`;
}

function safeJoin(root: string, rel: string) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  return full;
}

export function registerMedia(app: FastifyInstance) {
  app.post('/api/auth/browser-session', async (req, reply) => {
    reply.header('set-cookie', browserCookie(req.userId!));
    return ok(true);
  });
  app.post('/api/auth/browser-session/clear', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return ok(true);
  });

  const send = (req: FastifyRequest, reply: FastifyReply, root: string, rel: string) => {
    if (!cookieUser(req)) return reply.code(401).send('unauthorized');
    const full = safeJoin(root, rel);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return reply.code(404).send('not found');
    const ext = path.extname(full).slice(1).toLowerCase();
    reply.header('cache-control', 'private, max-age=604800, immutable');
    if (ext === 'svg') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return reply.type(MIME[ext] ?? 'application/octet-stream').send(fs.createReadStream(full));
  };

  // The main site's images stay at /media/...; every other site has its own folder.
  app.get<{ Params: { code: string; '*': string } }>('/media/sites/:code/*', async (req, reply) => {
    const site = siteByCode(req.params.code);
    if (!site || site.isMain) return cookieUser(req) ? reply.code(404).send('not found') : reply.code(401).send('unauthorized');
    return send(req, reply, siteMediaRoot(site), req.params['*']);
  });
  app.get<{ Params: { '*': string } }>('/media/*', async (req, reply) => send(req, reply, cfg().storage.basePath, req.params['*']));
}
