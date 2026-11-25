import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Serves the built web app from `root`, and the page shell for every route the app handles itself. */
export async function registerWeb(app: FastifyInstance, root: string) {
  const assets = path.resolve(root, 'assets');
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: false,
    // Vite puts a content hash in every file name under assets/, so a browser can keep those for good.
    // index.html keeps the default (checked on every load), so a new build is picked up at once.
    setHeaders: (reply, filePath) => {
      if (path.dirname(path.resolve(filePath)) === assets) reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.code(404).send({ success: false, code: 'NOT_FOUND' });
    return reply.sendFile('index.html');
  });
}
