import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { all, get, DATA_DIR, DB_PATH } from './db.ts';
import { assertPatchTypes, cfg, loadConfig, maskedConfig, unmaskPatch, updateConfig, type ConfigPatch } from './config.ts';
import { emit, Ev, clientCount } from './events.ts';
import { ApiError, ok } from './http.ts';
import { requireSudo } from './auth.ts';
import { telegram } from './notify.ts';
import { ffmpegStatus } from './scraper.ts';
import { demoStats } from './demo/forum.ts';
import { fetchForumIndex } from './source/xenforo.ts';
import { validateBackupDir } from './backup.ts';

/** Identifies the running build; clients compare it to decide whether to reload. */
export const APP_VERSION = (() => {
  const indexHtml = path.resolve('dist/web/index.html');
  const stamp = fs.existsSync(indexHtml) ? fs.statSync(indexHtml).mtimeMs : Date.now();
  return `1.0.0+${crypto.createHash('sha1').update(String(stamp)).digest('hex').slice(0, 8)}`;
})();

export function registerSystem(app: FastifyInstance, port: number) {
  app.get('/api/systems/maintenance', async () => ok(cfg().maintenance));
  app.get('/api/systems/version', async () => ok({ version: APP_VERSION }));

  app.get('/api/systems/config', async () => ok(maskedConfig(cfg())));

  app.put<{ Body: ConfigPatch }>('/api/systems/config', async (req) => {
    requireSudo(req);
    assertPatchTypes(req.body);
    const patch = unmaskPatch(structuredClone(req.body ?? {}));
    if (patch.backup && 'targetDir' in patch.backup) {
      patch.backup.targetDir = String(patch.backup.targetDir ?? '').trim();
      validateBackupDir(patch.backup.targetDir);
    }
    if (patch.source?.baseUrl) {
      try {
        // http(s) only, as discover-forums and the reader need
        if (!/^https?:$/.test(new URL(patch.source.baseUrl).protocol)) throw new Error();
      } catch {
        throw new ApiError(400, 'INVALID_URL', ['Địa chỉ nguồn không hợp lệ.', 'The source address is not valid.'], 'inline');
      }
      const old = cfg().source.baseUrl;
      if (patch.source.baseUrl !== old) {
        const prev = new Set([...(patch.source.previousBaseUrls ?? cfg().source.previousBaseUrls), old]);
        prev.delete(patch.source.baseUrl);
        patch.source.previousBaseUrls = [...prev];
      }
    }
    return ok(maskedConfig(updateConfig(patch, port)));
  });

  /** Lists forum sections of a XenForo site (default: the configured source) so the user can pick them. */
  app.get<{ Querystring: { baseUrl?: string } }>('/api/systems/discover-forums', async (req) => {
    const raw = String(req.query.baseUrl ?? cfg().source.baseUrl).trim();
    let url: URL;
    try {
      url = new URL(raw);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      throw new ApiError(400, 'INVALID_URL', ['Địa chỉ diễn đàn không hợp lệ.', 'The forum address is not valid.'], 'inline');
    }
    try {
      const forums = await fetchForumIndex(url.toString());
      if (!forums.length)
        throw new ApiError(422, 'NO_FORUMS', ['Không tìm thấy chuyên mục nào ở trang chủ. Địa chỉ này có phải diễn đàn XenForo không?', 'No sections found on the home page. Is this a XenForo forum?'], 'inline');
      return ok(forums);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'SOURCE_UNREACHABLE', [`Không đọc được ${url.host}: ${(e as Error).message}`, `Could not read ${url.host}: ${(e as Error).message}`], 'inline');
    }
  });

  app.post('/api/systems/reload-config', async (req) => {
    requireSudo(req);
    return ok(maskedConfig(loadConfig(port)));
  });

  app.post<{ Body: { message: string } }>('/api/systems/notify', async (req) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) throw new ApiError(400, 'EMPTY', ['Nhập nội dung thông báo.', 'Type the notice text.'], 'inline');
    emit(Ev.SystemNotification, { message, at: new Date().toISOString() }, message);
    return ok({ delivered: clientCount() });
  });

  app.post('/api/systems/force-reload', async () => {
    emit(Ev.NeedReload, { version: APP_VERSION });
    return ok({ delivered: clientCount() });
  });

  app.post('/api/systems/test-telegram', async () => {
    const r = await telegram('Glean: tin nhắn thử từ trang cài đặt.', true);
    if (!r.ok) throw new ApiError(400, 'TELEGRAM_FAILED', r.error ?? ['Không gửi được.', 'Could not send.'], 'inline');
    return ok(true);
  });

  app.get('/api/systems/environment', async () =>
    ok({
      version: APP_VERSION,
      node: process.version,
      ffmpeg: await ffmpegStatus(),
      dataDir: DATA_DIR,
      dbPath: DB_PATH,
      dbSizeBytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
      demoForum: demoStats(),
      realtimeClients: clientCount(),
    }),
  );

  app.get('/api/systems/overview', async () => {
    const n = (sql: string) => get<{ n: number }>(sql)!.n;
    return ok({
      threads: n('SELECT COUNT(*) n FROM thread'),
      comments: n('SELECT COUNT(*) n FROM comment'),
      deletedThreads: n('SELECT COUNT(*) n FROM thread WHERE is_deleted=1'),
      scrapes: n('SELECT COUNT(*) n FROM scrape WHERE is_marked_deleted=0'),
      images: n('SELECT COUNT(*) n FROM scrape_image i JOIN scrape s ON s.id=i.scrape_id WHERE s.is_marked_deleted=0 AND i.current_url IS NOT NULL'),
      forums: all('SELECT f.id, f.name, COUNT(t.id) threads FROM forum f LEFT JOIN thread t ON t.forum_id=f.id GROUP BY f.id ORDER BY f.id'),
    });
  });
}
