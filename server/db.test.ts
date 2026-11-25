import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { db, ensureColumn, migrate } from './db.ts';

/** A database shaped like one created before the data-preservation upgrade. */
function legacyDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE comment(id INTEGER PRIMARY KEY, thread_id INTEGER, post_no INTEGER, page INTEGER, author TEXT, content TEXT,
            content_lc TEXT, created_at TEXT, url TEXT, updated_at TEXT);
          CREATE TABLE scrape(id INTEGER PRIMARY KEY, thread_id INTEGER);
          CREATE TABLE scrape_image(id INTEGER PRIMARY KEY, scrape_id INTEGER, page INTEGER, post_no INTEGER, origin_url TEXT);
          CREATE TABLE scrape_video(id INTEGER PRIMARY KEY, scrape_id INTEGER, page INTEGER, post_no INTEGER, origin_url TEXT);
          CREATE TABLE scrape_link(id INTEGER PRIMARY KEY, scrape_id INTEGER, page INTEGER, post_no INTEGER, url TEXT);
          CREATE TABLE scrape_comment(id INTEGER PRIMARY KEY, scrape_id INTEGER, page INTEGER, post_no INTEGER, url TEXT);
          INSERT INTO comment(id, content) VALUES (1, 'x');
          INSERT INTO scrape(id, thread_id) VALUES (1, 5);`);
  return d;
}
const cols = (d: DatabaseSync, t: string) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name as string);

test('migrate adds new columns to a pre-upgrade database', () => {
  const d = legacyDb();
  migrate(d);
  assert.ok(['edit_count', 'edited_at', 'deleted_at'].every((c) => cols(d, 'comment').includes(c)));
  assert.ok(cols(d, 'scrape').includes('run_no'));
  for (const t of ['scrape_image', 'scrape_video', 'scrape_link', 'scrape_comment'])
    assert.ok(['post_id', 'last_seen_run', 'missing_since'].every((c) => cols(d, t).includes(c)), t);
  assert.equal(d.prepare('SELECT edit_count FROM comment WHERE id=1').get()?.edit_count, 0);
  assert.equal(d.prepare('SELECT run_no FROM scrape WHERE id=1').get()?.run_no, 1);
});

test('migrate is a no-op the second time', () => {
  const d = legacyDb();
  migrate(d);
  assert.doesNotThrow(() => migrate(d));
  assert.equal(ensureColumn(d, 'comment', 'deleted_at', 'TEXT'), false);
});

test('migrate backfills post ids of rows sieved before the upgrade', () => {
  const d = legacyDb();
  d.exec(`INSERT INTO scrape_comment(id, scrape_id, page, post_no, url) VALUES
            (1, 1, 1, 2, 'https://f.test/threads/a.5/post-777'), (2, 1, 1, 3, 'https://f.test/posts/778/'), (3, 1, 1, 4, NULL);
          INSERT INTO scrape_image(id, scrape_id, page, post_no, origin_url) VALUES (1, 1, 1, 2, 'a.jpg'), (2, 1, 1, 4, 'b.jpg');
          INSERT INTO scrape_link(id, scrape_id, page, post_no, url) VALUES (1, 1, 1, 3, 'https://x.test');`);
  migrate(d);
  const ids = (t: string) => d.prepare(`SELECT id, post_id FROM ${t} ORDER BY id`).all().map((r) => [r.id, r.post_id]);
  assert.deepEqual(ids('scrape_comment'), [[1, 777], [2, 778], [3, null]]);
  assert.deepEqual(ids('scrape_image'), [[1, 777], [2, null]]);
  assert.deepEqual(ids('scrape_link'), [[1, 778]]);
});

const version = (d: DatabaseSync) => (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('migrate records the schema version and skips steps a database already had', () => {
  const d = legacyDb();
  migrate(d);
  assert.ok(version(d) > 0);
  // The post-id backfill is part of an earlier step: rows added after it ran are left alone.
  d.exec(`INSERT INTO scrape_comment(id, scrape_id, page, post_no, url) VALUES (9, 1, 1, 2, 'https://f.test/posts/779/')`);
  migrate(d);
  assert.equal(d.prepare('SELECT post_id FROM scrape_comment WHERE id=9').get()?.post_id, null);
});

test('a step that fails leaves the database as it was, at the version before it', () => {
  const d = legacyDb();
  const steps = [(x: DatabaseSync) => x.exec('CREATE TABLE step_one(a)'), (x: DatabaseSync) => {
    x.exec('CREATE TABLE step_two(a)');
    throw new Error('step 2 failed');
  }];
  assert.throws(() => migrate(d, steps), /step 2 failed/);
  assert.equal(version(d), 1);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'step_%'").all().map((r) => r.name);
  assert.deepEqual(tables, ['step_one']);
});

test('item lookups by post use an index', () => {
  const d = legacyDb();
  migrate(d);
  for (const [t, col] of [['scrape_image', 'origin_url'], ['scrape_video', 'origin_url'], ['scrape_link', 'url']] as const) {
    const byId = d.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${t} WHERE scrape_id=? AND post_id=? AND ${col}=?`).all(1, 1, 'x');
    const byNo = d.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${t} WHERE scrape_id=? AND post_id IS NULL AND post_no=? AND ${col}=?`).all(1, 1, 'x');
    assert.match(JSON.stringify(byId), /USING INDEX ix_\w+_post\b/, t);
    assert.match(JSON.stringify(byNo), /USING INDEX ix_\w+_postno\b/, t);
  }
});

test('the overview counts threads per forum and deleted threads from an index', () => {
  const plan = (sql: string) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
  assert.match(plan('SELECT f.id, COUNT(t.id) threads FROM forum f LEFT JOIN thread t ON t.forum_id=f.id GROUP BY f.id'), /USING COVERING INDEX ix_thread_forum\b/);
  assert.match(plan('SELECT COUNT(*) n FROM thread WHERE is_deleted=1'), /USING COVERING INDEX ix_thread_deleted\b/);
});

test('ensureColumn reports when it adds a column', () => {
  const d = legacyDb();
  assert.equal(ensureColumn(d, 'scrape', 'extra_col', 'TEXT'), true);
  assert.ok(cols(d, 'scrape').includes('extra_col'));
});
