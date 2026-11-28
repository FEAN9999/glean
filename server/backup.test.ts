import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { cfg, loadConfig, updateConfig } from './config.ts';
import { DATA_DIR, get, now, run, setTestFallback } from './db.ts';
import { autoBackupName, backupStatus, isBackupDue, mirrorMedia, pruneAutoBackups, registerBackup, runBackup, validateBackupDir, type BackupRun } from './backup.ts';
import { ApiError } from './http.ts';
import { addSite, mainSite, registerSites, siteMediaRoot } from './site.ts';

loadConfig(0);
const rphang = addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `glean-${name}-`));
/** The run of the main store among the runs of one backup. */
const mainOf = (runs: BackupRun[]) => runs.find((r) => r.siteCode === null)!;
const autoCopies = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^glean-auto-\d{8}-\d{6}\.db$/.test(f)) : []);
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
  updateConfig({ backup: { targetDir: target, includeMedia: true } }, 0);
  const r = mainOf(await runBackup('manual'));
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
  updateConfig({ backup: { targetDir: target, includeMedia: true } }, 0);
  try {
    const r = mainOf(await runBackup('manual'));
    assert.equal(r.error, null);
    assert.ok(r.file && fs.existsSync(path.join(target, r.file)));
    assert.match(r.mediaError!, /x\.jpg/);
    // Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI (/qa, 2026-11-26)
    assert.match(r.mediaError!, /"vi":"1 tệp ảnh\/video không chép được — /);
    assert.match(r.mediaError!, /"en":"1 media file could not be copied: /);
  } finally {
    updateConfig({ backup: { targetDir: '' } }, 0);
  }
});

test('media is mirrored only into a folder the user chose', async () => {
  write(path.join(cfg().storage.basePath, 'scrapes', '3', 'y.jpg'), 'img');
  updateConfig({ backup: { targetDir: '', includeMedia: true } }, 0);
  const r = mainOf(await runBackup('manual'));
  assert.equal(r.error, null);
  assert.equal(r.mediaCopied, 0);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'backups', 'media')), false);
});

test('the backup status lists the database copies in the chosen folder, newest first', () => {
  const target = tmp('list');
  write(path.join(target, 'glean-2026-10-01.db'), 'older copy');
  write(path.join(target, 'glean-auto-20261101-000000.db'), 'aa');
  write(path.join(target, 'notes.txt'), 'n');
  fs.mkdirSync(path.join(target, 'media'));
  fs.utimesSync(path.join(target, 'glean-2026-10-01.db'), new Date('2026-10-01'), new Date('2026-10-01'));
  fs.utimesSync(path.join(target, 'glean-auto-20261101-000000.db'), new Date('2026-11-01'), new Date('2026-11-01'));
  updateConfig({ backup: { targetDir: target } }, 0);
  try {
    const files = backupStatus().files.map((f) => [f.name, f.sizeBytes]);
    assert.deepEqual(files, [['glean-auto-20261101-000000.db', 2], ['glean-2026-10-01.db', 10]]);
  } finally {
    updateConfig({ backup: { targetDir: '' } }, 0);
  }
});

test('runBackup records an error when the folder is unusable', async () => {
  const blocker = path.join(tmp('blocked'), 'a-file');
  write(blocker, 'not a folder');
  updateConfig({ backup: { targetDir: blocker } }, 0);
  try {
    const r = mainOf(await runBackup('manual'));
    assert.ok(r.error);
    assert.equal(r.file, null);
    // Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI (/qa, 2026-11-26)
    assert.match(r.error, /"vi":"Không dùng được thư mục sao lưu /);
    assert.match(r.error, /"en":"Cannot use the backup folder /);
  } finally {
    updateConfig({ backup: { targetDir: '' } }, 0);
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
  assert.equal(isBackupDue(t0, mainSite()), true); // never backed up
  run('INSERT INTO backup_run(trigger, started_at, finished_at, file) VALUES(?,?,?,?)', 'auto', t0.toISOString(), t0.toISOString(), 'x.db');
  assert.equal(isBackupDue(at(23), mainSite()), false);
  assert.equal(isBackupDue(at(24), mainSite()), true);
  run('INSERT INTO backup_run(trigger, started_at, finished_at, error) VALUES(?,?,?,?)', 'auto', at(24).toISOString(), at(24).toISOString(), 'drive missing');
  assert.equal(isBackupDue(at(24.5), mainSite()), false);
  assert.equal(isBackupDue(at(25), mainSite()), true);
  updateConfig({ backup: { enabled: false } }, 0);
  assert.equal(isBackupDue(at(48), mainSite()), false);
  updateConfig({ backup: { enabled: true } }, 0);
  assert.ok(get('SELECT 1 x FROM backup_run'));
});

test('the server keeps answering while a large database is copied', async () => {
  // About 30 MB of filler, so the copy takes long enough to notice a stalled event loop.
  run('CREATE TABLE filler(v TEXT)');
  run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) INSERT INTO filler SELECT printf('%0100d', i) FROM n");
  const target = tmp('large');
  updateConfig({ backup: { targetDir: target, includeMedia: false } }, 0);
  let turns = 0;
  let spinning = true;
  const spin = () => {
    turns++;
    if (spinning) setImmediate(spin);
  };
  try {
    setImmediate(spin);
    const r = mainOf(await runBackup('manual'));
    assert.equal(r.error, null);
    assert.ok(r.sizeBytes! > 20_000_000);
    assert.ok(turns > 20, `the event loop turned only ${turns} times during the copy`);
  } finally {
    spinning = false;
    run('DROP TABLE filler');
    updateConfig({ backup: { targetDir: '', includeMedia: true } }, 0);
  }
});

test('a manual backup copies every store with the main file name unchanged', async () => {
  const target = tmp('every');
  write(path.join(siteMediaRoot(rphang), 'scrapes', '1', 'r.jpg'), 'img');
  updateConfig({ backup: { targetDir: target, includeMedia: true } }, 0);
  try {
    const runs = await runBackup('manual');
    assert.deepEqual(
      runs.map((r) => [r.siteCode, r.error]),
      [
        [null, null],
        ['rphang', null],
      ],
    );
    assert.deepEqual(autoCopies(target), [mainOf(runs).file]);
    const site = runs.find((r) => r.siteCode === 'rphang')!;
    assert.deepEqual(autoCopies(path.join(target, 'sites', 'rphang')), [site.file]);
    // The copy in sites/rphang is rphang's own store.
    const copy = new DatabaseSync(path.join(target, 'sites', 'rphang', site.file!), { readOnly: true });
    try {
      const source = copy.prepare("SELECT value FROM config WHERE key='source'").get() as { value: string };
      assert.equal(JSON.parse(source.value).baseUrl, 'https://rphang.land');
    } finally {
      copy.close();
    }
    assert.equal(site.mediaCopied, 1);
    assert.ok(fs.existsSync(path.join(target, 'sites', 'rphang', 'media', 'scrapes', '1', 'r.jpg')));
  } finally {
    updateConfig({ backup: { targetDir: '' } }, 0);
  }
});

test('a failing site is retried alone', async () => {
  run('DELETE FROM backup_run');
  const target = tmp('retry');
  updateConfig({ backup: { targetDir: target, includeMedia: false } }, 0);
  const dbPath = rphang.dbPath;
  rphang.dbPath = path.join(tmp('gone'), 'missing', 'glean.db');
  try {
    const runs = await runBackup('manual');
    const failed = runs.find((r) => r.siteCode === 'rphang')!;
    assert.equal(mainOf(runs).error, null);
    assert.ok(failed.error);
    assert.equal(isBackupDue(new Date(), mainSite()), false);
    assert.equal(isBackupDue(new Date(), rphang), false); // retried at most hourly
    assert.equal(isBackupDue(new Date(Date.now() + 2 * 3600_000), rphang), true);

    const status = backupStatus();
    assert.equal(status.last?.siteCode, null);
    assert.equal(status.last?.error, null);
    const rp = status.sites.find((s) => s.code === 'rphang')!;
    assert.equal(rp.name, 'rphang');
    assert.equal(rp.last?.id, failed.id);
    assert.equal(rp.lastSuccessAt, null);

    // Two hours later the automatic check retries rphang only: the main store keeps its copies.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    run('UPDATE backup_run SET started_at=?, finished_at=? WHERE id=?', twoHoursAgo, twoHoursAgo, failed.id);
    const copies = autoCopies(target).length;
    const again = await runBackup('auto');
    assert.deepEqual(
      again.map((r) => r.siteCode),
      ['rphang'],
    );
    assert.equal(autoCopies(target).length, copies);

    // Nor does rphang's fresh failure hold back the main store once that is due.
    const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
    run('UPDATE backup_run SET started_at=?, finished_at=? WHERE site_code IS NULL', dayAgo, dayAgo);
    assert.equal(isBackupDue(new Date(), mainSite()), true);
  } finally {
    rphang.dbPath = dbPath;
    updateConfig({ backup: { targetDir: '', includeMedia: true } }, 0);
  }
});

test('back up now during an automatic run still copies every store', async () => {
  run('DELETE FROM backup_run');
  // Every store was just copied, so the automatic run skips them all.
  for (const code of [null, 'rphang'])
    run('INSERT INTO backup_run(trigger, started_at, finished_at, file, site_code) VALUES(?,?,?,?,?)', 'auto', now(), now(), 'x.db', code);
  updateConfig({ backup: { targetDir: tmp('during'), includeMedia: false } }, 0);
  try {
    const auto = runBackup('auto');
    const manual = await runBackup('manual');
    assert.deepEqual(await auto, []);
    assert.deepEqual(
      manual.map((r) => [r.siteCode, r.trigger, r.error]),
      [
        [null, 'manual', null],
        ['rphang', 'manual', null],
      ],
    );
  } finally {
    updateConfig({ backup: { targetDir: '', includeMedia: true } }, 0);
  }
});

test('the backups API runs outside any site and answers with the main store run', async () => {
  const app = Fastify();
  registerSites(app);
  registerBackup(app);
  await app.ready();
  const prev = setTestFallback(null);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/backups/run' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: BackupRun; runs: BackupRun[] };
    assert.equal(body.data.siteCode, null);
    assert.equal(body.data.error, null);
    assert.deepEqual(
      body.runs.map((r) => r.siteCode),
      [null, 'rphang'],
    );
    const status = await app.inject({ url: '/api/backups/status' });
    assert.equal(status.statusCode, 200);
    assert.ok(status.json().data.sites.some((s: { code: string }) => s.code === 'rphang'));
  } finally {
    setTestFallback(prev);
  }
});

test('a backup folder inside any site media folder is refused', () => {
  assert.throws(
    () => validateBackupDir(path.join(siteMediaRoot(rphang), 'bk')),
    (e: unknown) => e instanceof ApiError && e.code === 'INVALID_BACKUP_DIR',
  );
  // The main media would be mirrored into rphang's media folder.
  assert.throws(
    () => validateBackupDir(rphang.dir!),
    (e: unknown) => e instanceof ApiError && e.code === 'INVALID_BACKUP_DIR',
  );
});
