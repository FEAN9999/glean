import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.SANG_DATA_DIR ?? 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'sang.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS app_user (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_token (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forum (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread (
  id INTEGER PRIMARY KEY,
  forum_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  title_lc TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_post_at TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  synced_comment_count INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_thread_created ON thread(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_thread_comments ON thread(comment_count DESC);
CREATE INDEX IF NOT EXISTS ix_thread_author ON thread(author COLLATE NOCASE);

CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
  title, content='thread', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS thread_ai AFTER INSERT ON thread BEGIN
  INSERT INTO thread_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER IF NOT EXISTS thread_ad AFTER DELETE ON thread BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER IF NOT EXISTS thread_au AFTER UPDATE OF title ON thread BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO thread_fts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TABLE IF NOT EXISTS comment (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  post_no INTEGER NOT NULL,
  page INTEGER NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  content_lc TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_comment_thread ON comment(thread_id, post_no);
CREATE INDEX IF NOT EXISTS ix_comment_created ON comment(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_comment_author ON comment(author COLLATE NOCASE);

CREATE VIRTUAL TABLE IF NOT EXISTS comment_fts USING fts5(
  content, content='comment', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS comment_ai AFTER INSERT ON comment BEGIN
  INSERT INTO comment_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS comment_ad AFTER DELETE ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS comment_au AFTER UPDATE OF content ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO comment_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  keyword TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_search_history_kind ON search_history(kind, id DESC);

CREATE TABLE IF NOT EXISTS scrape (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  thread_title TEXT,
  thread_url TEXT NOT NULL,
  source TEXT NOT NULL,
  status INTEGER NOT NULL,
  total_pages INTEGER NOT NULL DEFAULT 0,
  current_page INTEGER NOT NULL DEFAULT 0,
  total_images INTEGER NOT NULL DEFAULT 0,
  total_videos INTEGER NOT NULL DEFAULT 0,
  total_comments INTEGER NOT NULL DEFAULT 0,
  total_links INTEGER NOT NULL DEFAULT 0,
  images_before_last_page INTEGER NOT NULL DEFAULT 0,
  videos_before_last_page INTEGER NOT NULL DEFAULT 0,
  comments_before_last_page INTEGER NOT NULL DEFAULT 0,
  links_before_last_page INTEGER NOT NULL DEFAULT 0,
  downloaded_images INTEGER NOT NULL DEFAULT 0,
  handling_seconds REAL,
  is_thread_deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  is_marked_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_scrape_status ON scrape(status, id);

CREATE TABLE IF NOT EXISTS scrape_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_id INTEGER NOT NULL REFERENCES scrape(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  post_no INTEGER,
  origin_url TEXT NOT NULL,
  current_url TEXT,
  external_url TEXT,
  is_bin INTEGER NOT NULL DEFAULT 0,
  is_download_failed INTEGER NOT NULL DEFAULT 0,
  display_by_origin_url INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_scrape_image ON scrape_image(scrape_id, page, id);

CREATE TABLE IF NOT EXISTS scrape_video (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_id INTEGER NOT NULL REFERENCES scrape(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  post_no INTEGER,
  origin_url TEXT NOT NULL,
  kind TEXT NOT NULL,
  current_url TEXT,
  hls_url TEXT
);
CREATE INDEX IF NOT EXISTS ix_scrape_video ON scrape_video(scrape_id, page, id);

CREATE TABLE IF NOT EXISTS scrape_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_id INTEGER NOT NULL REFERENCES scrape(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  post_no INTEGER,
  url TEXT NOT NULL,
  text TEXT
);
CREATE INDEX IF NOT EXISTS ix_scrape_link ON scrape_link(scrape_id, page, id);

CREATE TABLE IF NOT EXISTS scrape_comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_id INTEGER NOT NULL REFERENCES scrape(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  post_no INTEGER,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT,
  url TEXT
);
CREATE INDEX IF NOT EXISTS ix_scrape_comment ON scrape_comment(scrape_id, page, id);

CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  trigger TEXT NOT NULL,
  forum INTEGER NOT NULL,
  forum_name TEXT NOT NULL,
  sync_count INTEGER NOT NULL DEFAULT 0,
  sync_started_at TEXT NOT NULL,
  sync_finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_sync_history ON sync_history(type, id DESC);

CREATE TABLE IF NOT EXISTS sync_history_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id INTEGER NOT NULL REFERENCES sync_history(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  action TEXT NOT NULL,
  comment_delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sync_history_item ON sync_history_item(history_id, id);

CREATE TABLE IF NOT EXISTS upload_session (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();

type Row = Record<string, SQLInputValue>;

export function all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** snake_case row → camelCase object, 0/1 flag columns starting with is_/display_ become booleans. */
export function camel<T = any>(row: Record<string, unknown> | undefined): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = /^(is_|display_|totp_enabled)/.test(k) ? Boolean(v) : v;
  }
  return out as T;
}
export const camelAll = <T = any>(rows: Record<string, unknown>[]) => rows.map((r) => camel<T>(r));
