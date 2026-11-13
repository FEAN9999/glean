import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import { all, get, run } from './db.ts';
import { findMissingIds, normalizeText, reconcileDeletions } from './archive.ts';
import { upsertComments } from './sync.ts';
import type { ParsedPost } from './source/xenforo.ts';

loadConfig(0);

const post = (postId: number, text = `bình luận ${postId}`, extra: Partial<ParsedPost> = {}): ParsedPost => ({
  postId,
  postNo: postId % 1000,
  author: 'An',
  createdAt: '2026-11-01T00:00:00.000Z',
  text,
  url: `http://x.test/posts/${postId}`,
  images: [],
  videos: [],
  links: [],
  editedAt: null,
  ...extra,
});

let nextThread = 1;
/** A thread with the given comment ids already stored (all on page 1). */
function seedThread(ids: number[]) {
  const threadId = nextThread++;
  run(
    `INSERT INTO thread(id, forum_id, title, author, url, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
    threadId,
    1,
    `Chủ đề ${threadId}`,
    'An',
    'http://x.test',
    '2026-11-01T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  );
  upsertComments(threadId, 1, ids.map((id) => post(id)));
  return threadId;
}
const deletedIds = (threadId: number) =>
  all<{ id: number }>('SELECT id FROM comment WHERE thread_id=? AND deleted_at IS NOT NULL ORDER BY id', threadId).map((r) => r.id);

test('normalizeText collapses whitespace', () => {
  assert.equal(normalizeText('  a  b\n\n c\t'), 'a b c');
});

test('findMissingIds respects open bounds', () => {
  assert.deepEqual(findMissingIds([1, 2, 3, 4], [2, 4], null, null), [1, 3]);
  assert.deepEqual(findMissingIds([1, 2, 3, 4], [2, 4], 2, 4), [3]);
  assert.deepEqual(findMissingIds([1, 2, 3, 4], [3], 3, null), [4]);
});

test('edit stores the previous version', () => {
  const t = seedThread([10]);
  const before = get<{ updated_at: string }>('SELECT updated_at FROM comment WHERE id=10')!;
  const r = upsertComments(t, 1, [post(10, 'nội dung mới', { editedAt: '2026-11-02T00:00:00.000Z' })]);
  assert.deepEqual(r, { added: 0, edited: 1 });
  const c = get<any>('SELECT content, edit_count, edited_at FROM comment WHERE id=10')!;
  assert.equal(c.content, 'nội dung mới');
  assert.equal(c.edit_count, 1);
  assert.equal(c.edited_at, '2026-11-02T00:00:00.000Z');
  const revs = all<any>('SELECT content, captured_at, replaced_at FROM comment_revision WHERE comment_id=10');
  assert.equal(revs.length, 1);
  assert.equal(revs[0].content, 'bình luận 10');
  assert.equal(revs[0].captured_at, before.updated_at);
  assert.ok(revs[0].replaced_at);
});

test('whitespace-only change is not an edit', () => {
  const t = seedThread([]);
  upsertComments(t, 1, [post(20, 'a  b\n c')]);
  const r = upsertComments(t, 1, [post(20, 'a b c')]);
  assert.deepEqual(r, { added: 0, edited: 0 });
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM comment_revision WHERE comment_id=20')!.n, 0);
  assert.equal(get<{ edit_count: number }>('SELECT edit_count FROM comment WHERE id=20')!.edit_count, 0);
});

test('marks comments missing from a re-read range as deleted', () => {
  const t = seedThread([101, 102, 103, 104, 105]);
  const r = reconcileDeletions(t, [[post(101), post(102)], [post(104), post(105)]], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(r, { deleted: 1, skipped: null });
  assert.deepEqual(deletedIds(t), [103]);
});

test('comments outside a closed range are left alone', () => {
  const t = seedThread([201, 202, 203, 204, 205, 206]);
  // re-read the middle: 203..205 seen, 204 gone; 201, 202 and 206 are outside the range
  const r = reconcileDeletions(t, [[post(203), post(205)]], { startsAtFirstPage: false, endsAtLastPage: false });
  assert.deepEqual(r, { deleted: 1, skipped: null });
  assert.deepEqual(deletedIds(t), [204]);
});

test('a reappearing comment loses its deleted mark', () => {
  const t = seedThread([301, 302, 303]);
  reconcileDeletions(t, [[post(301), post(303)]], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(deletedIds(t), [302]);
  upsertComments(t, 1, [post(301), post(302), post(303)]);
  assert.deepEqual(deletedIds(t), []);
});

test('skips when a page has no posts', () => {
  const t = seedThread([401, 402, 403]);
  const r = reconcileDeletions(t, [[post(401)], []], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(r, { deleted: 0, skipped: 'empty-page' });
  assert.deepEqual(deletedIds(t), []);
});

test('skips when a seen post has no real id', () => {
  const t = seedThread([501, 502, 503]);
  const r = reconcileDeletions(t, [[post(501), post(0)]], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(r, { deleted: 0, skipped: 'missing-id' });
  assert.deepEqual(deletedIds(t), []);
});

test('skips when too many would be marked', () => {
  const t = seedThread([601, 602, 603, 604, 605, 606, 607, 608, 609, 610]);
  const r = reconcileDeletions(t, [[post(601)]], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(r, { deleted: 0, skipped: 'too-many' });
  assert.deepEqual(deletedIds(t), []);
});

test('fallback ids are never marked deleted', () => {
  const t = seedThread([701, 702]);
  // a comment stored before its real id was known: id = threadId * 100000 + postNo
  upsertComments(t, 1, [{ ...post(0), postNo: 7 }]);
  const fallbackId = t * 100000 + 7;
  assert.ok(get('SELECT id FROM comment WHERE id=?', fallbackId));
  const r = reconcileDeletions(t, [[post(701), post(702)]], { startsAtFirstPage: true, endsAtLastPage: true });
  assert.deepEqual(r, { deleted: 0, skipped: null });
  assert.deepEqual(deletedIds(t), []);
});
