import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg, loadConfig, updateConfig } from './config.ts';
import { DATA_DIR, get, run } from './db.ts';
import { autoBackupName, isBackupDue, mirrorMedia, pruneAutoBackups, runBackup, validateBackupDir } from './backup.ts';
import { ApiError } from './http.ts';

loadConfig(0);

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `glean-${name}-`));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

test('backup settings have the agreed defaults', () => {
  assert.deepEqual(cfg().backup, { enabled: true, intervalHours: 24, keep: 7, targetDir: '', includeMedia: true, notifyOnFail: true });
});

test('autoBackupName uses local time', () => {
  assert.equal(autoBackupName(new Date(2026, 10, 13, 9, 5, 7)), 'glean-auto-20261113-090507.db');
});

test('pruneAutoBackups keeps the newest N and ignores other files', () => {
  const dir = tmp('prune');
  for (let d = 1; d <= 9; d++) write(path.join(dir, `glean-auto-202611${String(d).padStart(2, '0')}-000000.db`), 'x');
  write(path.join(dir, 'glean-2026-11-01.db'), 'manual');
  write(path.join(dir, 'notes.txt'), 'n');
  assert.deepEqual(pruneAutoBackups(dir, 7), ['glean-auto-20261101-000000.db', 'glean-auto-20261102-000000.db']);
  const left = fs.readdirSync(dir);
  assert.equal(left.filter((f) => f.startsWith('glean-auto-')).length, 7);
  assert.ok(left.includes('glean-2026-11-01.db') && left.includes('notes.txt'));
});

test('mirrorMedia copies only new or changed files', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  write(path.join(src, 'a', '1.jpg'), 'abc');
  write(path.join(src, 'b', '2.png'), 'hello');
  write(path.join(dest, 'old.jpg'), 'keep me');
  const none = { failed: 0, firstError: null };
  assert.deepEqual(await mirrorMedia(src, dest), { copied: 2, bytes: 8, ...none });
  assert.deepEqual(await mirrorMedia(src, dest), { copied: 0, bytes: 0, ...none });
  write(path.join(src, 'a', '1.jpg'), 'abcdef');
  assert.deepEqual(await mirrorMedia(src, dest), { copied: 1, bytes: 6, ...none });
  assert.equal(fs.readFileSync(path.join(dest, 'a', '1.jpg'), 'utf8'), 'abcdef');
  assert.ok(fs.existsSync(path.join(dest, 'old.jpg')));
});

test('mirrorMedia tolerates a missing source folder', async () => {
  assert.deepEqual(await mirrorMedia(path.join(tmp('none'), 'nope'), tmp('dest2')), { copied: 0, bytes: 0, failed: 0, firstError: null });
});

test('mirrorMedia carries on past a file it cannot copy', async () => {
  const src = tmp('src3');
  const dest = tmp('dest3');
  write(path.join(src, 'a', '1.jpg'), 'abc');
  write(path.join(src, 'b', '2.png'), 'hello');
  fs.mkdirSync(path.join(dest, 'a', '1.jpg'), { recursive: true }); // a folder where the file should go
  const r = await mirrorMedia(src, dest);
  assert.deepEqual([r.copied, r.bytes, r.failed], [1, 5, 1]);
  assert.match(r.firstError!, /1\.jpg/);
  assert.ok(fs.existsSync(path.join(dest, 'b', '2.png')));
});

test('runBackup writes a database copy and records the run', async () => {
  const target = tmp('target');
  write(path.join(cfg().storage.basePath, 'scrapes', '1', '1.jpg'), 'img');
  updateConfig({ backup: { targetDir: target, includeMedia: true } } as any, 0);
  const r = await runBackup('manual');
  assert.equal(r.error, null);
  assert.ok(r.finishedAt);
  assert.match(r.file!, /^glean-auto-\d{8}-\d{6}\.db$/);
  assert.ok(r.sizeBytes! > 0);
  assert.ok(fs.existsSync(path.join(target, r.file!)));
  assert.equal(r.mediaCopied, 1);
  assert.ok(fs.existsSync(path.join(target, 'media', 'scrapes', '1', '1.jpg')));
});

test('a media copy failure keeps the database copy and still counts as a backup', async () => {
  const target = tmp('target2');
  write(path.join(cfg().storage.basePath, 'scrapes', '2', 'x.jpg'), 'img');
  fs.mkdirSync(path.join(target, 'media', 'scrapes', '2', 'x.jpg'), { recursive: true });
  updateConfig({ backup: { targetDir: target, includeMedia: true } } as any, 0);
  try {
    const r = await runBackup('auto');
    assert.equal(r.error, null);
    assert.ok(r.file && fs.existsSync(path.join(target, r.file)));
    assert.match(r.mediaError!, /x\.jpg/);
  } finally {
    updateConfig({ backup: { targetDir: '' } } as any, 0);
  }
});

test('media is mirrored only into a folder the user chose', async () => {
  write(path.join(cfg().storage.basePath, 'scrapes', '3', 'y.jpg'), 'img');
  updateConfig({ backup: { targetDir: '', includeMedia: true } } as any, 0);
  const r = await runBackup('manual');
  assert.equal(r.error, null);
  assert.equal(r.mediaCopied, 0);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'backups', 'media')), false);
});

test('runBackup records an error when the folder is unusable', async () => {
  const blocker = path.join(tmp('blocked'), 'a-file');
  write(blocker, 'not a folder');
  updateConfig({ backup: { targetDir: blocker } } as any, 0);
  try {
    const r = await runBackup('auto');
    assert.ok(r.error);
    assert.equal(r.file, null);
  } finally {
    updateConfig({ backup: { targetDir: '' } } as any, 0);
  }
});

test('validateBackupDir rejects a folder inside the media folder', () => {
  assert.throws(
    () => validateBackupDir(path.join(cfg().storage.basePath, 'bk')),
    (e: unknown) => e instanceof ApiError && e.code === 'INVALID_BACKUP_DIR',
  );
  assert.equal(validateBackupDir(''), path.join(DATA_DIR, 'backups'));
});

test('isBackupDue waits for the interval and does not retry a failure more than hourly', () => {
  run('DELETE FROM backup_run');
  const t0 = new Date('2026-11-13T00:00:00.000Z');
  const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
  assert.equal(isBackupDue(t0), true); // never backed up
  run('INSERT INTO backup_run(trigger, started_at, finished_at, file) VALUES(?,?,?,?)', 'auto', t0.toISOString(), t0.toISOString(), 'x.db');
  assert.equal(isBackupDue(at(23)), false);
  assert.equal(isBackupDue(at(24)), true);
  run('INSERT INTO backup_run(trigger, started_at, finished_at, error) VALUES(?,?,?,?)', 'auto', at(24).toISOString(), at(24).toISOString(), 'drive missing');
  assert.equal(isBackupDue(at(24.5)), false);
  assert.equal(isBackupDue(at(25)), true);
  updateConfig({ backup: { enabled: false } } as any, 0);
  assert.equal(isBackupDue(at(48)), false);
  updateConfig({ backup: { enabled: true } } as any, 0);
  assert.ok(get('SELECT 1 x FROM backup_run'));
});
