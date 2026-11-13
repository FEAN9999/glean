import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { all, get, db, DATA_DIR, DB_PATH } from './db.ts';
import { cfg, loadConfig, maskedConfig, unmaskPatch, updateConfig } from './config.ts';
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

/** Tables that hold real data and can be cloned (FTS shadow tables are rebuilt by triggers). */
const CLONABLE = [
  'app_user',
  'config',
  'forum',
  'thread',
  'comment',
  'search_history',
  'scrape',
  'scrape_image',
  'scrape_video',
  'scrape_link',
  'scrape_comment',
  'sync_history',
  'sync_history_item',
  'comment_revision',
  'backup_run',
];

function resolveTarget(p: string) {
  const name = String(p ?? '').trim();
  if (!name) throw new ApiError(400, 'INVALID_TARGET', 'Nhập tên tệp đích.', 'inline');
  if (!/^[\w.\-]+\.db$/i.test(name)) throw new ApiError(400, 'INVALID_TARGET', 'Tên tệp chỉ gồm chữ, số, dấu gạch, và kết thúc bằng .db', 'inline');
  const full = path.join(DATA_DIR, 'backups', name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (path.resolve(full) === path.resolve(DB_PATH)) throw new ApiError(400, 'INVALID_TARGET', 'Không thể ghi đè cơ sở dữ liệu đang dùng.', 'inline');
  return full;
}

function cloneTable(table: string, target: string) {
  if (!CLONABLE.includes(table)) throw new ApiError(400, 'INVALID_TABLE', `Bảng ${table} không được hỗ trợ.`);
  const ddl = get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table)!.sql;
  db.exec(`ATTACH DATABASE '${target.replace(/'/g, "''")}' AS clone_target`);
  try {
    db.exec(`DROP TABLE IF EXISTS clone_target.${table}`);
    db.exec(ddl.replace(/CREATE TABLE (IF NOT EXISTS )?/i, 'CREATE TABLE clone_target.'));
    db.exec(`INSERT INTO clone_target.${table} SELECT * FROM main.${table}`);
    const n = get<{ n: number }>(`SELECT COUNT(*) n FROM clone_target.${table}`)!.n;
    return { table, rows: n };
  } finally {
    db.exec('DETACH DATABASE clone_target');
  }
}

export function registerSystem(app: FastifyInstance, port: number) {
  app.get('/api/systems/maintenance', async () => ok(cfg().maintenance));
  app.get('/api/systems/version', async () => ok({ version: APP_VERSION }));

  app.get('/api/systems/config', async () => ok(maskedConfig(cfg())));

  app.put<{ Body: any }>('/api/systems/config', async (req) => {
    requireSudo(req);
    const patch = unmaskPatch(structuredClone(req.body ?? {}));
    if (patch.backup && 'targetDir' in patch.backup) {
      patch.backup.targetDir = String(patch.backup.targetDir ?? '').trim();
      validateBackupDir(patch.backup.targetDir);
    }
    if (patch.source?.baseUrl) {
      try {
        new URL(patch.source.baseUrl);
      } catch {
        throw new ApiError(400, 'INVALID_URL', 'Địa chỉ nguồn không hợp lệ.', 'inline');
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
      throw new ApiError(400, 'INVALID_URL', 'Địa chỉ diễn đàn không hợp lệ.', 'inline');
    }
    try {
      const forums = await fetchForumIndex(url.toString());
      if (!forums.length)
        throw new ApiError(422, 'NO_FORUMS', 'Không tìm thấy chuyên mục nào ở trang chủ. Địa chỉ này có phải diễn đàn XenForo không?', 'inline');
      return ok(forums);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'SOURCE_UNREACHABLE', `Không đọc được ${url.host}: ${(e as Error).message}`, 'inline');
    }
  });

  app.post('/api/systems/reload-config', async (req) => {
    requireSudo(req);
    return ok(maskedConfig(loadConfig(port)));
  });

  app.post<{ Body: { message: string } }>('/api/systems/notify', async (req) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) throw new ApiError(400, 'EMPTY', 'Nhập nội dung thông báo.', 'inline');
    emit(Ev.SystemNotification, { message, at: new Date().toISOString() }, message);
    return ok({ delivered: clientCount() });
  });

  app.post('/api/systems/force-reload', async () => {
    emit(Ev.NeedReload, { version: APP_VERSION });
    return ok({ delivered: clientCount() });
  });

  app.post('/api/systems/test-telegram', async () => {
    const r = await telegram('Glean: tin nhắn thử từ trang cài đặt.', true);
    if (!r.ok) throw new ApiError(400, 'TELEGRAM_FAILED', r.error ?? 'Không gửi được.', 'inline');
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

  /* ---- clone / backup ---- */
  app.get('/api/clone/tables', async () => {
    const tables = CLONABLE.map((t) => ({ name: t, rows: get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)!.n }));
    const dir = path.join(DATA_DIR, 'backups');
    const backups = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.db'))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
          })
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      : [];
    return ok({ tables, backups, backupDir: dir });
  });

  app.post<{ Body: { table: string; target: string } }>('/api/clone/table', async (req) => {
    requireSudo(req);
    return ok(cloneTable(req.body?.table, resolveTarget(req.body?.target)));
  });

  app.post<{ Body: { tables?: string[]; target: string; mode?: 'tables' | 'full' } }>('/api/clone/execute', async (req) => {
    requireSudo(req);
    const target = resolveTarget(req.body?.target);
    const started = Date.now();
    if (req.body?.mode === 'full') {
      if (fs.existsSync(target)) fs.rmSync(target);
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      return ok({ mode: 'full', target: path.basename(target), sizeBytes: fs.statSync(target).size, ms: Date.now() - started });
    }
    const tables = (req.body?.tables?.length ? req.body.tables : CLONABLE).filter((t) => CLONABLE.includes(t));
    const results = tables.map((t) => cloneTable(t, target));
    return ok({ mode: 'tables', target: path.basename(target), results, ms: Date.now() - started });
  });
}
