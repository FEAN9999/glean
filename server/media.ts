import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { get, run, now } from './db.ts';
import { cfg } from './config.ts';
import { ApiError, ok } from './http.ts';
import { signJwt, verifyJwt } from './auth.ts';

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

export const COOKIE = 'sang_session';

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
  for (const type of ['application/octet-stream', 'image/*', 'video/*']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }

  app.post('/api/auth/browser-session', async (req, reply) => {
    reply.header('set-cookie', browserCookie((req as any).userId));
    return ok(true);
  });
  app.post('/api/auth/browser-session/clear', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return ok(true);
  });

  app.get<{ Params: { '*': string } }>('/media/*', async (req, reply) => {
    if (!cookieUser(req)) return reply.code(401).send('unauthorized');
    const full = safeJoin(cfg().storage.basePath, req.params['*']);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return reply.code(404).send('not found');
    const ext = path.extname(full).slice(1).toLowerCase();
    reply.header('cache-control', 'private, max-age=604800, immutable');
    if (ext === 'svg') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return reply.type(MIME[ext] ?? 'application/octet-stream').send(fs.createReadStream(full));
  });

  const uploadsDir = () => path.join(cfg().storage.basePath, 'uploads');
  const cleanName = (n: string) =>
    String(n ?? 'file')
      .replace(/[^\w.\-]+/g, '_')
      .slice(-80) || 'file';

  /** Single-shot upload (raw body). Header `x-file-name` carries the original name. */
  app.post('/api/media/upload', async (req) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new ApiError(400, 'EMPTY', 'Tệp rỗng.', 'inline');
    if (body.length > cfg().storage.maxFileSizeMb * 1024 * 1024)
      throw new ApiError(413, 'TOO_LARGE', `Tệp vượt quá ${cfg().storage.maxFileSizeMb} MB.`, 'inline');
    const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${cleanName(req.headers['x-file-name'] as string)}`;
    fs.mkdirSync(uploadsDir(), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(), name), body);
    return ok({ url: `/media/uploads/${name}`, sizeBytes: body.length });
  });

  app.post<{ Body: { fileName: string; totalSize: number } }>('/api/media/chunks-init', async (req) => {
    const total = Number(req.body?.totalSize);
    if (!total || total > cfg().storage.maxFileSizeMb * 1024 * 1024)
      throw new ApiError(413, 'TOO_LARGE', `Tệp vượt quá ${cfg().storage.maxFileSizeMb} MB.`, 'inline');
    const id = crypto.randomUUID();
    run('INSERT INTO upload_session(id, file_name, total_size, created_at) VALUES(?,?,?,?)', id, cleanName(req.body.fileName), total, now());
    fs.mkdirSync(path.join(uploadsDir(), '.partial'), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(), '.partial', id), Buffer.alloc(0));
    return ok({ uploadId: id, chunkSize: cfg().storage.chunkSizeMb * 1024 * 1024, concurrentUploads: cfg().storage.concurrentUploads });
  });

  /** Chunks are appended in order: `?uploadId=&offset=` must equal bytes received so far. */
  app.post<{ Querystring: { uploadId: string; offset: string } }>('/api/media/chunks-upload', async (req) => {
    const s = get<{ id: string; file_name: string; total_size: number; received: number }>('SELECT * FROM upload_session WHERE id=?', req.query.uploadId);
    if (!s) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Phiên tải lên không tồn tại.');
    const body = req.body as Buffer;
    if (Number(req.query.offset) !== s.received) throw new ApiError(409, 'BAD_OFFSET', `Cần gửi từ byte ${s.received}.`);
    const partial = path.join(uploadsDir(), '.partial', s.id);
    fs.appendFileSync(partial, body);
    const received = s.received + body.length;
    run('UPDATE upload_session SET received=? WHERE id=?', received, s.id);
    if (received >= s.total_size) {
      const name = `${Date.now()}-${s.file_name}`;
      fs.renameSync(partial, path.join(uploadsDir(), name));
      run('DELETE FROM upload_session WHERE id=?', s.id);
      return ok({ done: true, received, url: `/media/uploads/${name}` });
    }
    return ok({ done: false, received });
  });
}
