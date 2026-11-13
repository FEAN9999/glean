import { all, now, run } from './db.ts';
import type { ParsedPost } from './source/xenforo.ts';

/**
 * Keeping the comment archive honest: noticing comments that disappeared from the forum.
 * Edits are recorded where comments are written (`upsertComments` in sync.ts).
 */

/** Text compared for edits: runs of whitespace count as one space. */
export const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Stored ids inside [lo, hi] (null = unbounded) that were not seen. */
export function findMissingIds(stored: number[], seen: number[], lo: number | null, hi: number | null): number[] {
  const s = new Set(seen);
  return stored.filter((id) => (lo == null || id >= lo) && (hi == null || id <= hi) && !s.has(id));
}

export type ReconcileSkip = null | 'empty-page' | 'missing-id' | 'too-many';

/**
 * After reading a contiguous run of pages of a thread, marks stored comments that should be on
 * those pages but are not as deleted on the forum. Works on post ids, which survive page shifts.
 *
 * Refuses to mark anything when the pages look unreliable (an empty page usually means an error
 * or anti-bot page; a post without a real id cannot be placed) or when the result looks like a
 * parser failure rather than moderation (more than 2 and more than half of the range missing).
 */
export function reconcileDeletions(
  threadId: number,
  pages: ParsedPost[][],
  o: { startsAtFirstPage: boolean; endsAtLastPage: boolean },
): { deleted: number; skipped: ReconcileSkip } {
  if (!pages.length || pages.some((p) => p.length === 0)) return { deleted: 0, skipped: 'empty-page' };
  if (pages.some((p) => p.some((x) => !x.postId))) return { deleted: 0, skipped: 'missing-id' };

  const lo = o.startsAtFirstPage ? null : Math.min(...pages[0].map((p) => p.postId));
  const hi = o.endsAtLastPage ? null : Math.max(...pages[pages.length - 1].map((p) => p.postId));
  // Comments stored under a synthesized id (threadId * 100000 + postNo) cannot be placed by id.
  const stored = all<{ id: number }>(
    'SELECT id FROM comment WHERE thread_id=? AND deleted_at IS NULL AND id <> thread_id * 100000 + post_no',
    threadId,
  ).map((r) => r.id);
  const inRange = stored.filter((id) => (lo == null || id >= lo) && (hi == null || id <= hi));
  const missing = findMissingIds(inRange, pages.flat().map((p) => p.postId), lo, hi);

  if (missing.length > 2 && missing.length > inRange.length / 2) return { deleted: 0, skipped: 'too-many' };
  if (missing.length) {
    run(`UPDATE comment SET deleted_at=? WHERE id IN (${missing.map(() => '?').join(',')})`, now(), ...missing);
  }
  return { deleted: missing.length, skipped: null };
}
