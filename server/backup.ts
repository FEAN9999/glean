import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, camel, db, get, now, run } from './db.ts';
import { cfg } from './config.ts';
import { ApiError, ok } from './http.ts';
import { requireSudo } from './auth.ts';
import { telegram } from './notify.ts';

/**
 * Automatic backups: a full database copy on a schedule (newest `keep` copies kept) plus an
 * add-only mirror of the media folder. Manual backups from the Backup page are never pruned.
 */

export interface BackupRun {
  id: number;
  trigger: 'auto' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  file: string | null;
  sizeBytes: number | null;
  mediaCopied: number;
  mediaBytes: number;
  /** Media files that could not be copied; the database copy still counts as a backup. */
  mediaError: string | null;
  error: string | null;
}

const AUTO_NAME = /^glean-auto-\d{8}-\d{6}\.db$/;
/** A failed run is retried at most this often, so an unplugged drive does not spam notifications. */
const RETRY_AFTER_FAILURE_MS = 3600_000;

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Absolute backup folder for a setting value: empty = data/backups, relative = under the data folder. */
export const backupDirPath = (p: string) => {
  const raw = String(p ?? '').trim();
  return raw ? path.resolve(DATA_DIR, raw) : path.join(DATA_DIR, 'backups');
};

/** Resolves and creates the backup folder; rejects folders that would hold or be the media folder. */
export function validateBackupDir(p: string): string {
  const dir = backupDirPath(p);
  const media = path.resolve(cfg().storage.basePath);
  if (isInside(dir, media) || path.resolve(dir, 'media') === media) {
    throw new ApiError(400, 'INVALID_BACKUP_DIR', 'Thư mục sao lưu không được nằm trong thư mục ảnh hay trùng thư mục dữ liệu.', 'inline');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) throw new Error('không phải thư mục');
  } catch (e) {
    throw new ApiError(400, 'INVALID_BACKUP_DIR', `Không dùng được thư mục sao lưu ${dir}: ${(e as Error).message}`, 'inline');
  }
  return dir;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const autoBackupName = (d: Date) =>
  `glean-auto-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;

/** Deletes the oldest automatic backups beyond `keep`. Returns the removed names, oldest first. */
export function pruneAutoBackups(dir: string, keep: number): string[] {
  const autos = fs
    .readdirSync(dir)
    .filter((f) => AUTO_NAME.test(f))
    .sort();
  const remove = autos.slice(0, Math.max(0, autos.length - keep));
  for (const f of remove) fs.rmSync(path.join(dir, f), { force: true });
  return remove;
}

export interface MirrorResult {
  copied: number;
  bytes: number;
  failed: number;
  firstError: string | null;
}

/**
 * Copies files missing from `dest` or differing in size. Never deletes anything in `dest`.
 * A file that cannot be read or copied is counted and skipped; the rest still get copied.
 */
export async function mirrorMedia(src: string, dest: string): Promise<MirrorResult> {
  const out: MirrorResult = { copied: 0, bytes: 0, failed: 0, firstError: null };
  const fail = (e: unknown) => {
    out.failed++;
    out.firstError ??= (e as Error).message;
  };
  const walk = async (from: string, to: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(from, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail(e);
      return;
    }
    for (const e of entries) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) {
        await walk(a, b);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const size = (await fs.promises.stat(a)).size;
        const existing = await fs.promises.stat(b).catch(() => null);
        if (existing && existing.size === size) continue;
        await fs.promises.mkdir(to, { recursive: true });
        await fs.promises.copyFile(a, b);
        out.copied++;
        out.bytes += size;
      } catch (err) {
        fail(err);
      }
    }
  };
  await walk(src, dest);
  return out;
}

const getRun = (id: number) => camel<BackupRun>(get('SELECT * FROM backup_run WHERE id=?', id));

async function doBackup(trigger: BackupRun['trigger']): Promise<BackupRun> {
  const id = Number(run('INSERT INTO backup_run(trigger, started_at) VALUES(?,?)', trigger, now()).lastInsertRowid);
  const label = trigger === 'auto' ? 'sao lưu tự động' : 'sao lưu';
  try {
    const c = cfg().backup;
    const dir = validateBackupDir(c.targetDir);
    const name = autoBackupName(new Date());
    const file = path.join(dir, name);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    // The database copy is the backup; record it before the (slower, optional) media copy.
    run('UPDATE backup_run SET file=?, size_bytes=? WHERE id=?', name, fs.statSync(file).size, id);
    pruneAutoBackups(dir, Math.max(1, c.keep));
    // Media is mirrored only into a folder the user chose: a copy next to data/ on the same disk protects nothing.
    let media: MirrorResult = { copied: 0, bytes: 0, failed: 0, firstError: null };
    if (c.includeMedia && String(c.targetDir ?? '').trim()) {
      media = await mirrorMedia(cfg().storage.basePath, path.join(dir, 'media')).catch((e) => ({ ...media, failed: 1, firstError: (e as Error).message }));
    }
    const mediaError = media.failed ? `${media.failed} tệp ảnh/video không chép được — ${media.firstError}` : null;
    run(
      'UPDATE backup_run SET finished_at=?, media_copied=?, media_bytes=?, media_error=? WHERE id=?',
      now(),
      media.copied,
      media.bytes,
      mediaError,
      id,
    );
    if (mediaError && c.notifyOnFail) void telegram(`Glean: ${label} xong kho dữ liệu nhưng ${mediaError}`);
  } catch (e) {
    const msg = (e as Error).message;
    run('UPDATE backup_run SET finished_at=?, error=? WHERE id=?', now(), msg, id);
    if (cfg().backup.notifyOnFail) void telegram(`Glean: ${label} lỗi — ${msg}`);
  }
  return getRun(id);
}

let running: Promise<BackupRun> | null = null;

/** Runs one backup; a call while one is running gets that run. Never throws: failures are recorded. */
export function runBackup(trigger: BackupRun['trigger']): Promise<BackupRun> {
  running ??= doBackup(trigger).finally(() => {
    running = null;
  });
  return running;
}

const lastSuccessAt = () =>
  get<{ at: string | null }>('SELECT MAX(finished_at) at FROM backup_run WHERE error IS NULL AND file IS NOT NULL')!.at;

/** Enabled, no successful backup within the interval, and no failed attempt within the last hour. */
export function isBackupDue(at = new Date()): boolean {
  const c = cfg().backup;
  if (!c.enabled) return false;
  const ok = lastSuccessAt();
  if (ok && at.getTime() - Date.parse(ok) < c.intervalHours * 3600_000) return false;
  const failed = get<{ at: string | null }>('SELECT MAX(finished_at) at FROM backup_run WHERE error IS NOT NULL')!.at;
  if (failed && (!ok || failed > ok) && at.getTime() - Date.parse(failed) < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

export function backupStatus() {
  const c = cfg().backup;
  const okAt = lastSuccessAt();
  const last = get('SELECT * FROM backup_run ORDER BY id DESC LIMIT 1');
  return {
    running: running != null,
    last: last ? camel<BackupRun>(last) : null,
    lastSuccessAt: okAt,
    /** null while enabled means "at the next check, within minutes". */
    nextDueAt: c.enabled && okAt ? new Date(Date.parse(okAt) + c.intervalHours * 3600_000).toISOString() : null,
    dir: backupDirPath(c.targetDir),
  };
}

export function initBackup() {
  const check = () => {
    if (isBackupDue()) void runBackup('auto');
  };
  setTimeout(check, 60_000).unref();
  setInterval(check, 10 * 60_000).unref();
}

export function registerBackup(app: FastifyInstance) {
  app.get('/api/backups/status', async () => ok(backupStatus()));
  app.post('/api/backups/run', async (req) => {
    requireSudo(req);
    return ok(await runBackup('manual'));
  });
}
