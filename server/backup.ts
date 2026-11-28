import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, camel, mainGet, mainRun, now } from './db.ts';
import { cfg } from './config.ts';
import { ApiError, ok } from './http.ts';
import { requireSudo } from './auth.ts';
import { telegram } from './notify.ts';
import { BiError, biOf, pack, type Bi } from './bilingual.ts';
import { siteMediaRoot, sites, withSite, type Site } from './site.ts';

/**
 * Automatic backups: a full copy of every site's store on a schedule (newest `keep` copies kept per
 * store) plus an add-only mirror of each media folder. The main store goes in the backup folder
 * itself, the others in sites/<code>/. Only glean-auto-* files are pruned; other files in the folder
 * are left alone. Each store's runs are tracked on their own, so only a store that failed is retried.
 */

export interface BackupRun {
  id: number;
  trigger: 'auto' | 'manual';
  /** The site whose store was copied; null for the main site. */
  siteCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  file: string | null;
  sizeBytes: number | null;
  mediaCopied: number;
  mediaBytes: number;
  /** Media files that could not be copied; the database copy still counts as a backup. In both languages (bilingual.ts, pack). */
  mediaError: string | null;
  /** Why the run failed, in both languages (bilingual.ts, pack). */
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

/** Where a site's copies go inside the backup folder. */
const storeDir = (dir: string, site: Site) => (site.isMain ? dir : path.join(dir, 'sites', site.code));

/** Resolves and creates the backup folder; rejects folders inside a site's media folder or that would mirror media onto one. */
export function validateBackupDir(p: string): string {
  const dir = backupDirPath(p);
  const media = sites().map((s) => path.resolve(siteMediaRoot(s)));
  const mirrors = sites().map((s) => path.resolve(storeDir(dir, s), 'media'));
  if (media.some((m) => isInside(dir, m) || mirrors.includes(m))) {
    throw new ApiError(400, 'INVALID_BACKUP_DIR', ['Thư mục sao lưu không được nằm trong thư mục ảnh hay trùng thư mục dữ liệu.', 'The backup folder cannot be inside the media folder or be the data folder.'], 'inline');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) throw new BiError(['không phải thư mục', 'not a folder']);
  } catch (e) {
    const [vi, en] = biOf(e);
    throw new ApiError(400, 'INVALID_BACKUP_DIR', [`Không dùng được thư mục sao lưu ${dir}: ${vi}`, `Cannot use the backup folder ${dir}: ${en}`], 'inline');
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

/**
 * Copies the store at `src` with VACUUM INTO on its own read-only connection in a worker thread, so
 * a large archive does not stall every request while it is copied.
 */
function vacuumInto(src: string, dest: string) {
  const code = `
    const { DatabaseSync } = require('node:sqlite');
    const { workerData } = require('node:worker_threads');
    const d = new DatabaseSync(workerData.src, { readOnly: true });
    try {
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec("VACUUM INTO '" + workerData.dest.replace(/'/g, "''") + "'");
    } finally {
      d.close();
    }`;
  return new Promise<void>((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { src, dest } });
    w.once('error', reject);
    w.once('exit', (exit) =>
      exit === 0 ? resolve() : reject(new BiError([`Sao lưu dừng giữa chừng (mã ${exit}).`, `The backup stopped partway (code ${exit}).`])),
    );
  });
}

// backup_run is a shared table in the main store; site_code is NULL for the main site's runs.
const getRun = (id: number) => camel<BackupRun>(mainGet('SELECT * FROM backup_run WHERE id=?', id));
const siteCodeOf = (site: Site) => (site.isMain ? null : site.code);

/** Copies one site's store (and media); called inside that site, so a Telegram message names it. */
async function doBackup(trigger: BackupRun['trigger'], site: Site): Promise<BackupRun> {
  const id = Number(mainRun('INSERT INTO backup_run(trigger, started_at, site_code) VALUES(?,?,?)', trigger, now(), siteCodeOf(site)).lastInsertRowid);
  const label = trigger === 'auto' ? 'sao lưu tự động' : 'sao lưu';
  try {
    const c = cfg().backup;
    const dir = storeDir(validateBackupDir(c.targetDir), site);
    fs.mkdirSync(dir, { recursive: true });
    const name = autoBackupName(new Date());
    const file = path.join(dir, name);
    await vacuumInto(site.dbPath, file);
    // The database copy is the backup; record it before the (slower, optional) media copy.
    mainRun('UPDATE backup_run SET file=?, size_bytes=? WHERE id=?', name, fs.statSync(file).size, id);
    pruneAutoBackups(dir, Math.max(1, c.keep));
    // Media is mirrored only into a folder the user chose: a copy next to data/ on the same disk protects nothing.
    let media: MirrorResult = { copied: 0, bytes: 0, failed: 0, firstError: null };
    if (c.includeMedia && String(c.targetDir ?? '').trim()) {
      media = await mirrorMedia(siteMediaRoot(site), path.join(dir, 'media')).catch((e) => ({ ...media, failed: 1, firstError: (e as Error).message }));
    }
    const mediaError: Bi | null = media.failed
      ? [
          `${media.failed} tệp ảnh/video không chép được — ${media.firstError}`,
          `${media.failed} media file${media.failed === 1 ? '' : 's'} could not be copied: ${media.firstError}`,
        ]
      : null;
    mainRun(
      'UPDATE backup_run SET finished_at=?, media_copied=?, media_bytes=?, media_error=? WHERE id=?',
      now(),
      media.copied,
      media.bytes,
      mediaError && pack(mediaError),
      id,
    );
    if (mediaError && c.notifyOnFail) void telegram(`Glean: ${label} xong kho dữ liệu nhưng ${mediaError[0]}`);
  } catch (e) {
    const msg = biOf(e);
    mainRun('UPDATE backup_run SET finished_at=?, error=? WHERE id=?', now(), pack(msg), id);
    if (cfg().backup.notifyOnFail) void telegram(`Glean: ${label} lỗi — ${msg[0]}`);
  }
  return getRun(id);
}

/** Copies the stores one after another: every store when manual, the ones due when automatic. */
async function backUpStores(trigger: BackupRun['trigger']): Promise<BackupRun[]> {
  const runs: BackupRun[] = [];
  for (const site of sites()) {
    if (trigger === 'auto' && !isBackupDue(new Date(), site)) continue;
    runs.push(await withSite(site, () => doBackup(trigger, site)));
  }
  return runs;
}

let running: Promise<BackupRun[]> | null = null;
let runningTrigger: BackupRun['trigger'] = 'auto';

/**
 * Runs one backup of the stores, one run per store copied. A call while one is running gets that
 * run, except a manual call during an automatic run, which may have skipped stores: it runs next.
 * Never throws: failures are recorded.
 */
export function runBackup(trigger: BackupRun['trigger']): Promise<BackupRun[]> {
  if (running && (trigger === 'auto' || runningTrigger === 'manual')) return running;
  const next: Promise<BackupRun[]> = (running ?? Promise.resolve())
    .then(() => backUpStores(trigger))
    .finally(() => {
      if (running === next) running = null;
    });
  running = next;
  runningTrigger = trigger;
  return next;
}

const lastSuccessAt = (site: Site) =>
  mainGet<{ at: string | null }>('SELECT MAX(finished_at) at FROM backup_run WHERE error IS NULL AND file IS NOT NULL AND site_code IS ?', siteCodeOf(site))!.at;

/** For one site's store: enabled, no successful backup within the interval, and no failed attempt within the last hour. */
export function isBackupDue(at: Date, site: Site): boolean {
  const c = cfg().backup;
  if (!c.enabled) return false;
  const ok = lastSuccessAt(site);
  if (ok && at.getTime() - Date.parse(ok) < c.intervalHours * 3600_000) return false;
  const failed = mainGet<{ at: string | null }>('SELECT MAX(finished_at) at FROM backup_run WHERE error IS NOT NULL AND site_code IS ?', siteCodeOf(site))!.at;
  if (failed && (!ok || failed > ok) && at.getTime() - Date.parse(failed) < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

/** Database copies in a backup folder, newest first. */
function backupFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db'))
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** The last run, last success and next run of one site's store. */
function storeStatus(site: Site) {
  const c = cfg().backup;
  const okAt = lastSuccessAt(site);
  const last = mainGet('SELECT * FROM backup_run WHERE site_code IS ? ORDER BY id DESC LIMIT 1', siteCodeOf(site));
  return {
    last: last ? camel<BackupRun>(last) : null,
    lastSuccessAt: okAt,
    /** null while enabled means "at the next check, within minutes". */
    nextDueAt: c.enabled && okAt ? new Date(Date.parse(okAt) + c.intervalHours * 3600_000).toISOString() : null,
  };
}

/** The main store's status and copies, then the status of each other site's store. */
export function backupStatus() {
  const dir = backupDirPath(cfg().backup.targetDir);
  const [main, ...others] = sites();
  return {
    running: running != null,
    ...storeStatus(main),
    dir,
    files: backupFiles(dir),
    sites: others.map((s) => ({ code: s.code, name: s.name, ...storeStatus(s) })),
  };
}

export function initBackup() {
  const check = () => {
    const at = new Date();
    if (sites().some((s) => isBackupDue(at, s))) void runBackup('auto');
  };
  setTimeout(check, 60_000).unref();
  setInterval(check, 10 * 60_000).unref();
}

export function registerBackup(app: FastifyInstance) {
  app.get('/api/backups/status', async () => ok(backupStatus()));
  app.post('/api/backups/run', async (req) => {
    requireSudo(req);
    const runs = await runBackup('manual');
    return ok(runs.find((r) => r.siteCode === null), { runs });
  });
}
