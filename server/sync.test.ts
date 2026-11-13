import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg, loadConfig, updateConfig } from './config.ts';
import { all, get, run } from './db.ts';
import { commentSyncStartPage, syncCommentsForum, syncThreadComments, threadsNeedingComments, upsertComments } from './sync.ts';
import type { ParsedPost, ParsedThreadPage } from './source/xenforo.ts';

loadConfig(0);

const post = (postId: number, text = `bình luận ${postId}`): ParsedPost => ({
  postId,
  postNo: postId - 1000,
  author: 'An',
  createdAt: '2026-11-01T00:00:00.000Z',
  text,
  url: `http://x.test/posts/${postId}`,
  images: [],
  videos: [],
  links: [],
  editedAt: null,
});

function addThread(id: number, forumId: number, o: { commentCount: number; synced: number; lastPostAt: string }) {
  run(
    `INSERT INTO thread(id, forum_id, title, author, url, created_at, last_post_at, comment_count, synced_comment_count, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,
    forumId,
    `Chủ đề ${id}`,
    'An',
    'http://x.test',
    '2026-11-01T00:00:00.000Z',
    o.lastPostAt,
    o.commentCount,
    o.synced,
    '2026-11-01T00:00:00.000Z',
  );
}

test('commentSyncStartPage', () => {
  assert.equal(commentSyncStartPage({ syncedCount: 45, perPage: 20, storedMaxPage: 3, recheckPages: 2 }), 2);
  assert.equal(commentSyncStartPage({ syncedCount: 45, perPage: 20, storedMaxPage: 3, recheckPages: 0 }), 3);
  assert.equal(commentSyncStartPage({ syncedCount: 0, perPage: 20, storedMaxPage: 0, recheckPages: 2 }), 1);
  assert.equal(commentSyncStartPage({ syncedCount: 20, perPage: 20, storedMaxPage: 1, recheckPages: 2 }), 1);
});

test('re-check settings default to 2 pages and 48 hours', () => {
  assert.equal(cfg().sync.comments.recheckPages, 2);
  assert.equal(cfg().sync.comments.recheckWithinHours, 48);
});

test('threadsNeedingComments includes recently active threads', () => {
  const at = new Date('2026-11-13T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(at.getTime() - h * 3600_000).toISOString();
  // ids kept apart from other test files: some runners (bun) share one database across files
  addThread(21, 9, { commentCount: 5, synced: 0, lastPostAt: hoursAgo(200) }); // needs comments
  addThread(22, 9, { commentCount: 2, synced: 3, lastPostAt: hoursAgo(1) }); // complete, recently active
  addThread(23, 9, { commentCount: 2, synced: 3, lastPostAt: hoursAgo(100) }); // complete, quiet
  assert.deepEqual(threadsNeedingComments(9, 40, at).sort(), [21, 22]);
  updateConfig({ sync: { comments: { recheckPages: 0 } } } as any, 0);
  try {
    assert.deepEqual(threadsNeedingComments(9, 40, at), [21]);
  } finally {
    updateConfig({ sync: { comments: { recheckPages: 2 } } } as any, 0);
  }
});

test('threadsNeedingComments puts threads missing comments before re-checks', () => {
  const at = new Date('2026-11-13T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(at.getTime() - h * 3600_000).toISOString();
  addThread(11, 10, { commentCount: 2, synced: 3, lastPostAt: hoursAgo(1) }); // complete, re-check only
  addThread(12, 10, { commentCount: 5, synced: 0, lastPostAt: hoursAgo(30) }); // needs comments
  assert.deepEqual(threadsNeedingComments(10, 1, at), [12]);
});

test('syncThreadComments re-reads stored pages and detects edits and deletions', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } } as any, 0);
  try {
    // 6 posts on 3 pages are stored; on the forum 1003 was edited and 1006 deleted.
    addThread(50, 1, { commentCount: 5, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
    upsertComments(50, 1, [post(1001), post(1002)]);
    upsertComments(50, 2, [post(1003), post(1004)]);
    upsertComments(50, 3, [post(1005), post(1006)]);
    const forum: Record<number, ParsedPost[]> = {
      1: [post(1001), post(1002)],
      2: [post(1003, 'đã sửa'), post(1004)],
      3: [post(1005)],
    };
    const asked: number[] = [];
    const fetchPage = async (_id: number, page: number): Promise<ParsedThreadPage> => {
      asked.push(page);
      return { title: 'Chủ đề 50', forumId: 1, totalPages: 3, posts: forum[page] };
    };
    const r = await syncThreadComments(50, 2, { trigger: 'manual', shouldStop: () => false, fetchPage });
    assert.deepEqual(r, { added: 0, edited: 1, deleted: 1, skipped: null });
    assert.deepEqual(asked, [2, 3]);
    assert.deepEqual(all<{ id: number }>('SELECT id FROM comment WHERE thread_id=50 AND deleted_at IS NOT NULL').map((x) => x.id), [1006]);
    assert.equal(get<{ edit_count: number }>('SELECT edit_count FROM comment WHERE id=1003')!.edit_count, 1);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } } as any, 0);
  }
});

test('a skipped deletion check shows up in the sync log', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } } as any, 0);
  try {
    addThread(60, 20, { commentCount: 3, synced: 4, lastPostAt: '2026-11-13T00:00:00.000Z' });
    upsertComments(60, 1, [post(2001), post(2002)]);
    upsertComments(60, 2, [post(2003), post(2004)]);
    // page 2 comes back empty (a glitch, not a deletion): nothing may be marked deleted
    const fetchPage = async (_id: number, page: number): Promise<ParsedThreadPage> => ({
      title: 'Chủ đề 60',
      forumId: 20,
      totalPages: 2,
      posts: page === 1 ? [post(2001), post(2002)] : [],
    });
    await syncCommentsForum({ id: 20, name: 'F' }, [60], 5, { trigger: 'manual', shouldStop: () => false, fetchPage });
    assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=60 AND deleted_at IS NOT NULL')!.n, 0);
    const actions = all<{ action: string }>('SELECT action FROM sync_history_item WHERE thread_id=60').map((x) => x.action);
    assert.deepEqual(actions, ['check-skipped']);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } } as any, 0);
  }
});
