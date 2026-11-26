import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg, loadConfig, updateConfig } from './config.ts';
import Fastify, { type FastifyReply } from 'fastify';
import { all, get, run } from './db.ts';
import { addClient, Ev, removeClient } from './events.ts';
import { commentSyncStartPage, registerSync, syncCommentsForum, syncPostsForum, syncThreadComments, threadsNeedingComments, upsertComments, upsertThread } from './sync.ts';
import type { ListedThread, ParsedPost, ParsedThreadPage } from './source/xenforo.ts';

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
  updateConfig({ sync: { comments: { recheckPages: 0 } } }, 0);
  try {
    assert.deepEqual(threadsNeedingComments(9, 40, at), [21]);
  } finally {
    updateConfig({ sync: { comments: { recheckPages: 2 } } }, 0);
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
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } }, 0);
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
    assert.deepEqual(r, { added: 0, edited: 1, liked: 0, deleted: 1, skipped: null });
    assert.deepEqual(asked, [1, 2, 3]);
    assert.deepEqual(all<{ id: number }>('SELECT id FROM comment WHERE thread_id=50 AND deleted_at IS NOT NULL').map((x) => x.id), [1006]);
    assert.equal(get<{ edit_count: number }>('SELECT edit_count FROM comment WHERE id=1003')!.edit_count, 1);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } }, 0);
  }
});

test('a skipped deletion check shows up in the sync log', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } }, 0);
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
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } }, 0);
  }
});

const listed = (id: number): ListedThread => ({
  id,
  title: `Bài ${id}`,
  author: 'An',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastPostAt: '2026-11-01T00:00:00.000Z',
  replies: 0,
  url: `http://x.test/threads/${id}`,
});

test('posts sync skips a page that keeps failing and reads the rest', async () => {
  updateConfig({ scraper: { batchDelayMs: 0 } }, 0);
  try {
    const lines: string[] = [];
    const synced: number[] = [];
    const fetchListPage = async (_forum: number, page: number) => {
      if (page === 2) throw new Error('The operation was aborted due to timeout');
      return { threads: [listed(3000 + page)], totalPages: 3 };
    };
    const n = await syncPostsForum({ id: 30, name: 'F30' }, 1, 'all', {
      trigger: 'manual',
      shouldStop: () => false,
      fetchListPage,
      log: (l) => lines.push(l[0]),
      onPage: (p) => synced.push(p.synced),
    });
    assert.equal(n, 2);
    assert.deepEqual(all<{ id: number }>('SELECT id FROM thread WHERE forum_id=30 ORDER BY id').map((r) => r.id), [3001, 3003]);
    assert.ok(lines.some((l) => /trang 2\b.*bỏ qua/i.test(l)), lines.join('\n'));
    assert.deepEqual(synced, [1, 2]);
    const h = get<{ error: string | null; sync_count: number }>('SELECT error, sync_count FROM sync_history WHERE forum=30')!;
    assert.equal(h.sync_count, 2);
    assert.match(h.error ?? '', /trang 2\b/);
  } finally {
    updateConfig({ scraper: { batchDelayMs: 150 } }, 0);
  }
});

// Regression: ISSUE-003 — failure text stayed Vietnamese in the English UI
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md
test('a skipped page is logged and noted in the history in both languages', async () => {
  updateConfig({ scraper: { batchDelayMs: 0 } }, 0);
  try {
    const lines: (readonly [vi: string, en: string])[] = [];
    const fetchListPage = async (_forum: number, page: number) => {
      if (page === 2) throw new Error('timeout');
      return { threads: [listed(3700 + page)], totalPages: 3 };
    };
    await syncPostsForum({ id: 37, name: 'F37' }, 1, 'all', { trigger: 'manual', shouldStop: () => false, fetchListPage, log: (l) => lines.push(l) });
    assert.ok(
      lines.some(([vi, en]) => vi === '[F37] trang 2: lỗi — timeout. Bỏ qua, chạy tiếp.' && en === '[F37] page 2: error: timeout. Skipped, the run goes on.'),
      JSON.stringify(lines),
    );
    const h = get<{ error: string | null }>('SELECT error FROM sync_history WHERE forum=37')!;
    assert.equal(
      h.error,
      JSON.stringify({ vi: 'Bỏ qua [F37] trang 2 vì lỗi — chạy lại để lấy phần này.', en: 'Skipped [F37] page 2 because of errors. Run the sync again to fetch this part.' }),
    );
  } finally {
    updateConfig({ scraper: { batchDelayMs: 150 } }, 0);
  }
});

test('the manual sync log is written in both languages', async () => {
  const app = Fastify();
  registerSync(app);
  // a forum id that is not configured: the run has nothing to read and finishes at once, without the network
  const r = await app.inject({ method: 'POST', url: '/api/manual-syncs/start', payload: { type: 'posts', pageFrom: 1, pageTo: 1, forums: [999999] } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().data.logs.at(-1).line, JSON.stringify({ vi: 'Hoàn tất: 0 bản ghi.', en: 'Done: 0 records.' }));
});

test('posts sync stops after 3 failed pages in a row', async () => {
  updateConfig({ scraper: { batchDelayMs: 0 } }, 0);
  try {
    let calls = 0;
    const fetchListPage = async (_forum: number, page: number) => {
      calls++;
      if (page >= 2) throw new Error('forum down');
      return { threads: [listed(3100 + page)], totalPages: 10 };
    };
    await assert.rejects(syncPostsForum({ id: 31, name: 'F31' }, 1, 'all', { trigger: 'manual', shouldStop: () => false, fetchListPage }), /forum down/);
    assert.equal(calls, 4);
    assert.ok(get('SELECT id FROM thread WHERE id=3101'), 'the page read before the failures is kept');
  } finally {
    updateConfig({ scraper: { batchDelayMs: 150 } }, 0);
  }
});

test('comments sync skips a thread that fails and reads the rest', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } }, 0);
  try {
    addThread(70, 32, { commentCount: 0, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
    addThread(71, 32, { commentCount: 0, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
    const fetchPage = async (id: number): Promise<ParsedThreadPage> => {
      if (id === 70) throw new Error('The operation was aborted due to timeout');
      return { title: 'Chủ đề 71', forumId: 32, totalPages: 1, posts: [post(4001)] };
    };
    const n = await syncCommentsForum({ id: 32, name: 'F32' }, [70, 71], 5, { trigger: 'manual', shouldStop: () => false, fetchPage });
    assert.equal(n, 1);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id=71')!.n, 1);
    const h = get<{ error: string | null }>('SELECT error FROM sync_history WHERE forum=32')!;
    assert.match(h.error ?? '', /70/);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } }, 0);
  }
});

test('the manual sync "complete" event no longer says it is running', async () => {
  const events: { type: number; data: { running: boolean; saving: number; result: string | null } }[] = [];
  const reply = { raw: { write: (s: string) => s.startsWith('data:') && events.push(JSON.parse(s.slice(5))) } };
  const client = addClient(reply as unknown as FastifyReply, ['manual-sync']);
  try {
    const app = Fastify();
    registerSync(app);
    // a forum id that is not configured: the run has nothing to read and finishes at once, without the network
    const r = await app.inject({ method: 'POST', url: '/api/manual-syncs/start', payload: { type: 'posts', pageFrom: 1, pageTo: 1, forums: [999999] } });
    assert.equal(r.statusCode, 200);
    const done = events.find((e) => e.type === Ev.ManualSyncComplete);
    assert.ok(done, 'a complete event was sent');
    assert.equal(done.data.running, false);
    assert.equal(done.data.saving, 0);
    assert.equal(done.data.result, 'completed');
  } finally {
    removeClient(client);
  }
});

test('comments sync reads several threads at once, up to concurrentThreads', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 }, sync: { comments: { concurrentThreads: 3 } } }, 0);
  try {
    const ids = [80, 81, 82, 83, 84, 85];
    for (const id of ids) addThread(id, 33, { commentCount: 0, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
    let inFlight = 0;
    let most = 0;
    const fetchPage = async (id: number): Promise<ParsedThreadPage> => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { title: `Chủ đề ${id}`, forumId: 33, totalPages: 1, posts: [post(5000 + id)] };
    };
    const n = await syncCommentsForum({ id: 33, name: 'F33' }, ids, 5, { trigger: 'manual', shouldStop: () => false, fetchPage });
    assert.equal(n, 6);
    assert.equal(most, 3);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM comment WHERE thread_id BETWEEN 80 AND 85')!.n, 6);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 }, sync: { comments: { concurrentThreads: 3 } } }, 0);
  }
});

test('parallel comments sync stops taking threads once failures pile up', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 }, sync: { comments: { concurrentThreads: 2 } } }, 0);
  try {
    const ids = Array.from({ length: 20 }, (_, i) => 90 + i);
    for (const id of ids) addThread(id, 34, { commentCount: 0, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
    let calls = 0;
    const fetchPage = async (): Promise<ParsedThreadPage> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('forum down');
    };
    await assert.rejects(syncCommentsForum({ id: 34, name: 'F34' }, ids, 5, { trigger: 'manual', shouldStop: () => false, fetchPage }), /forum down/);
    assert.ok(calls <= 4, `stopped early, made ${calls} calls`);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 }, sync: { comments: { concurrentThreads: 3 } } }, 0);
  }
});

test('threadsNeedingComments with no limit returns every thread still to sync', () => {
  const at = new Date('2026-11-13T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(at.getTime() - h * 3600_000).toISOString();
  for (let id = 120; id < 130; id++) addThread(id, 35, { commentCount: 3, synced: 0, lastPostAt: hoursAgo(200) }); // missing comments
  addThread(130, 35, { commentCount: 2, synced: 3, lastPostAt: hoursAgo(200) }); // complete and quiet: skipped
  addThread(131, 35, { commentCount: 2, synced: 3, lastPostAt: hoursAgo(1) }); // complete but active: re-read
  const ids = threadsNeedingComments(35, Infinity, at);
  assert.equal(ids.length, 11);
  assert.ok(!ids.includes(130));
  assert.ok(ids.includes(131));
});

test('upsertThread stores views; a views-only change is saved but not counted as an update', () => {
  const listed: ListedThread = {
    id: 9201,
    title: 'Chủ đề 9201',
    author: 'An',
    createdAt: '2026-11-01T00:00:00.000Z',
    lastPostAt: '2026-11-02T00:00:00.000Z',
    replies: 3,
    views: 10,
    url: 'http://x.test/threads/t.9201/',
  };
  assert.equal(upsertThread(listed, 1).action, 'new');
  assert.equal(get<{ v: number }>('SELECT view_count v FROM thread WHERE id=9201')!.v, 10);
  assert.deepEqual(upsertThread({ ...listed, views: 25 }, 1), { action: null, delta: 0 });
  assert.equal(get<{ v: number }>('SELECT view_count v FROM thread WHERE id=9201')!.v, 25);
});

test('upsertComments keeps per-post likes and sums them on the thread', () => {
  addThread(9202, 1, { commentCount: 1, synced: 0, lastPostAt: '2026-11-02T00:00:00.000Z' });
  upsertComments(9202, 1, [{ ...post(92001), likes: 3 }, { ...post(92002), likes: 4 }]);
  assert.equal(get<{ n: number }>('SELECT like_count n FROM thread WHERE id=9202')!.n, 7);
  upsertComments(9202, 1, [{ ...post(92001), likes: 3 }, { ...post(92002), likes: 1 }]);
  assert.equal(get<{ n: number }>('SELECT like_count n FROM comment WHERE id=92002')!.n, 1);
  assert.equal(get<{ n: number }>('SELECT like_count n FROM thread WHERE id=9202')!.n, 4);
});

/** Thread 9301 with 10 posts stored on 5 pages; on the forum the first post now has 5 likes. */
async function readThread9301(ctx: { fromFirstPage?: boolean }) {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } }, 0);
  try {
    if (!get('SELECT 1 FROM thread WHERE id=9301')) {
      addThread(9301, 1, { commentCount: 9, synced: 0, lastPostAt: '2026-11-13T00:00:00.000Z' });
      for (let page = 1; page <= 5; page++) upsertComments(9301, page, [post(93000 + page * 2 - 1), post(93000 + page * 2)]);
    }
    const asked: number[] = [];
    const fetchPage = async (_id: number, page: number): Promise<ParsedThreadPage> => {
      asked.push(page);
      const posts = [post(93000 + page * 2 - 1), post(93000 + page * 2)];
      if (page === 1) posts[0] = { ...posts[0], likes: 5 };
      return { title: 'Chủ đề 9301', forumId: 1, totalPages: 5, posts };
    };
    await syncThreadComments(9301, 2, { trigger: 'manual', shouldStop: () => false, fetchPage, ...ctx });
    return asked;
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } }, 0);
  }
}

test('a re-check also re-reads page 1, so the first post keeps its likes current', async () => {
  assert.deepEqual(await readThread9301({}), [1, 4, 5]);
  assert.equal(get<{ n: number }>('SELECT like_count n FROM thread WHERE id=9301')!.n, 5);
});

test('fromFirstPage re-reads every page of a thread', async () => {
  assert.deepEqual(await readThread9301({ fromFirstPage: true }), [1, 2, 3, 4, 5]);
});

test('manual comments sync from page 1 reads complete threads too', async () => {
  const app = Fastify();
  registerSync(app);
  const r = await app.inject({
    method: 'POST',
    url: '/api/manual-syncs/start',
    payload: { type: 'comments', allPages: true, onlyMissing: true, fromFirstPage: true, forums: [999999] },
  });
  assert.equal(r.statusCode, 200);
  const o = r.json().data.options;
  assert.equal(o.fromFirstPage, true);
  assert.equal(o.onlyMissing, false);
});

test('the comments sync log says how many comments had their likes updated', async () => {
  updateConfig({ source: { postsPerPage: 2 }, scraper: { batchDelayMs: 0 } }, 0);
  try {
    addThread(9401, 36, { commentCount: 2, synced: 3, lastPostAt: '2026-11-13T00:00:00.000Z' });
    upsertComments(9401, 1, [{ ...post(94001), likes: 1 }, { ...post(94002), likes: 2 }]);
    upsertComments(9401, 2, [{ ...post(94003), likes: 0 }]);
    // on the forum two of the three comments gained likes
    const pages: Record<number, ParsedPost[]> = {
      1: [{ ...post(94001), likes: 5 }, { ...post(94002), likes: 2 }],
      2: [{ ...post(94003), likes: 1 }],
    };
    const fetchPage = async (_id: number, page: number): Promise<ParsedThreadPage> => ({ title: 'Chủ đề 9401', forumId: 36, totalPages: 2, posts: pages[page] });
    const lines: string[] = [];
    await syncCommentsForum({ id: 36, name: 'F36' }, [9401], 5, { trigger: 'manual', shouldStop: () => false, fetchPage, fromFirstPage: true, log: (l) => lines.push(l[0]) });
    const line = lines.find((l) => l.includes('bài 9401'));
    assert.match(line ?? '', /\+0 bình luận, 2 bình luận cập nhật like/);
  } finally {
    updateConfig({ source: { postsPerPage: 20 }, scraper: { batchDelayMs: 150 } }, 0);
  }
});
