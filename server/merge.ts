/** Lists from several sites shown as one: search results and the Archive with `x-glean-site: *`. */

/** Rows `skip` to `skip + take` of the lists taken together in `cmp` order. Each list is sorted by `cmp`. */
export function mergeTop<T>(lists: T[][], cmp: (a: T, b: T) => number, skip: number, take: number): T[] {
  return lists.flat().sort(cmp).slice(skip, skip + take);
}

/** Larger first. */
export const desc = (a: number | string, b: number | string) => (a < b ? 1 : a > b ? -1 : 0);

/** Newest first; at the same time, by site code, then the higher id first. */
export function newestFirst(a: { id: number; createdAt: string; site: { code: string } }, b: typeof a) {
  return desc(a.createdAt, b.createdAt) || desc(b.site.code, a.site.code) || b.id - a.id;
}

/** The first row of each list, then the second of each, and so on. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}
