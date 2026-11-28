import type { FastifyInstance, FastifyRequest } from 'fastify';
import { all, get, now, camelAll, camel, mainAll, mainRun } from './db.ts';
import { cfg } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, assertNotPaused, intParam, ok } from './http.ts';
import { parseThreadRef } from './source/xenforo.ts';
import { currentSite, forEachSite, requestSite, siteForLink, siteInfo, siteRequired, withSite } from './site.ts';
import { desc, interleave, mergeTop, newestFirst } from './merge.ts';

/**
 * Full-text search over synced threads/comments (SQLite FTS5, diacritic-insensitive tokenizer)
 * with two match modes:
 *  - exact ("khớp từ"): the keyword must appear as a phrase, accents respected.
 *  - contains ("chứa từ"): every word must appear (prefix match, accents ignored).
 */

type Kind = 'post_keyword' | 'post_author' | 'comment_keyword' | 'comment_author';

const HISTORY_EVENT: Record<Kind, number> = {
  post_keyword: Ev.NewSearch,
  post_author: Ev.NewSearchByAuthor,
  comment_keyword: Ev.NewCommentSearch,
  comment_author: Ev.NewCommentSearchByAuthor,
};

function tokens(q: string) {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function ftsQuery(q: string, exact: boolean) {
  const t = tokens(q);
  if (!t.length) return null;
  if (exact) return `"${t.join(' ')}"`;
  return t.map((w) => `"${w}"*`).join(' AND ');
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function validate(keyword: string) {
  const min = cfg().search.minKeywordLength;
  const k = String(keyword ?? '').trim();
  if (k.length < min) throw new ApiError(400, 'KEYWORD_TOO_SHORT', [`Nhập tối thiểu ${min} ký tự.`, `Type at least ${min} characters.`], 'inline');
  return k;
}

function record(kind: Kind, keyword: string, resultCount: number) {
  const createdAt = now();
  // Searching the same thing again moves it to the top instead of adding a duplicate row.
  mainRun('DELETE FROM search_history WHERE kind = ? AND keyword = ? COLLATE NOCASE', kind, keyword);
  const r = mainRun('INSERT INTO search_history(kind, keyword, result_count, created_at) VALUES(?,?,?,?)', kind, keyword, resultCount, createdAt);
  const item = { id: Number(r.lastInsertRowid), keyword, resultCount, createdAt };
  emit(HISTORY_EVENT[kind], item, undefined, kind.startsWith('post') ? 'search-post' : 'search-comment');
}

/** Which rows a search returns; by default the page asked for. */
type Win = { limit: number; offset: number };

type SiteTag = { code: string; name: string };
type Hit = Record<string, unknown> & { id: number; createdAt: string; site: SiteTag };

/** The rows of the current site, each naming it. */
function tagged<T extends Record<string, unknown>>(rows: Record<string, unknown>[]) {
  const s = currentSite();
  const site: SiteTag = { code: s.code, name: s.name };
  return camelAll<T>(rows).map((r) => ({ ...r, site }));
}

/** With `*`, a site whose search is paused stops the search, and the message names it. */
async function assertNoSitePaused(feature: 'searchPost' | 'searchComment') {
  await forEachSite((s) => {
    const flag = cfg().maintenance[feature];
    if (flag.isPaused)
      throw new ApiError(503, 'FEATURE_PAUSED', flag.message || [`Tính năng đang tạm dừng ở trang ${s.name}.`, `This feature is paused on the site ${s.name}.`], 'banner');
  });
}

/**
 * With `*`: the same search in every site. The first `page × pageSize` rows of each are merged in
 * `cmp` order and the page is cut from them; the total is the sum of the sites.
 */
async function searchEverySite<T extends Hit>(page: number, search: (win: Win) => { items: T[]; total: number }, cmp: (a: T, b: T) => number) {
  const size = cfg().search.pageSize;
  const per = await forEachSite(() => search({ limit: page * size, offset: 0 }));
  const total = per.reduce((n, p) => n + p.value.total, 0);
  const items = mergeTop(
    per.map((p) => p.value.items),
    cmp,
    (page - 1) * size,
    size,
  );
  return { items, total, page, pageSize: size, nextPage: page * size < total ? page + 1 : null };
}

const sumOverSites = async (count: () => number) => (await forEachSite(count)).reduce((n, p) => n + p.value, 0);

/* ---------------- posts ---------------- */

interface PostSearchBody {
  page?: number;
  keyword: string;
  isSearchByAuthor?: boolean;
  sortDescendingField?: 'createdAt' | 'commentCount' | 'viewCount' | 'likeCount';
  isExactMatch?: boolean;
}

const SORT_COLUMN: Record<string, string> = { commentCount: 't.comment_count', viewCount: 't.view_count', likeCount: 't.like_count' };

function postWhere(b: PostSearchBody) {
  const keyword = b.keyword.trim();
  if (b.isSearchByAuthor) {
    return b.isExactMatch
      ? { where: 't.author = ? COLLATE NOCASE', params: [keyword], join: '' }
      : { where: "t.author LIKE ? ESCAPE '\\'", params: [`%${likeEscape(keyword)}%`], join: '' };
  }
  const q = ftsQuery(keyword, !!b.isExactMatch);
  if (!q) return null;
  const extra = b.isExactMatch ? " AND t.title_lc LIKE ? ESCAPE '\\'" : '';
  return {
    join: 'JOIN thread_fts f ON f.rowid = t.id',
    where: `thread_fts MATCH ?${extra}`,
    params: b.isExactMatch ? [q, `%${likeEscape(keyword.toLowerCase())}%`] : [q],
  };
}

function countPosts(b: PostSearchBody) {
  const w = postWhere(b);
  if (!w) return 0;
  return get<{ n: number }>(`SELECT COUNT(*) n FROM thread t ${w.join} WHERE ${w.where}`, ...w.params)!.n;
}

type PostHit = Hit & { commentCount: number; viewCount: number; likeCount: number };

/** The column a post search sorts by first, as a row field; null for the newest first. */
const sortField = (b: PostSearchBody) => (Object.hasOwn(SORT_COLUMN, b.sortDescendingField ?? '') ? (b.sortDescendingField as 'commentCount' | 'viewCount' | 'likeCount') : null);

/** The order of a merged post search: the chosen column, then newest first (the same order as the SQL below). */
const postOrder = (b: PostSearchBody) => {
  const f = sortField(b);
  return (x: PostHit, y: PostHit) => (f ? desc(x[f], y[f]) : 0) || newestFirst(x, y);
};

export function searchPosts(b: PostSearchBody, win?: Win) {
  const w = postWhere(b);
  const size = cfg().search.pageSize;
  const page = intParam(b.page, 1);
  if (!w) return { items: [] as PostHit[], total: 0, page, pageSize: size, nextPage: null };
  const f = sortField(b);
  const order = f ? `${SORT_COLUMN[f]} DESC, t.created_at DESC, t.id DESC` : 't.created_at DESC, t.id DESC';
  const { limit, offset } = win ?? { limit: size, offset: (page - 1) * size };
  const rows = all(
    `SELECT t.id, t.title, t.author, t.forum_id, COALESCE(fo.name, '') forum_name, t.url, t.created_at, t.last_post_at,
            t.comment_count, t.synced_comment_count, t.view_count, t.like_count, t.is_deleted
     FROM thread t ${w.join} LEFT JOIN forum fo ON fo.id = t.forum_id
     WHERE ${w.where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const total = countPosts(b);
  return {
    items: tagged<PostHit>(rows),
    total,
    page,
    pageSize: size,
    nextPage: page * size < total ? page + 1 : null,
  };
}

/* ---------------- comments ---------------- */

interface CommentSearchBody {
  page?: number;
  keyword: string;
  isExactMatch?: boolean;
  threadId?: number | string | null;
  isSearchByAuthor?: boolean;
  /** Only comments edited or deleted on the forum. */
  onlyChanged?: boolean;
}

function resolveThreadId(v: CommentSearchBody['threadId']) {
  if (v == null || v === '') return null;
  const ref = parseThreadRef(String(v));
  if (!ref) throw new ApiError(400, 'INVALID_THREAD', ['Không nhận ra link hoặc ID bài viết.', 'Not a thread link or ID.'], 'inline');
  return ref.threadId;
}

function commentWhere(b: CommentSearchBody, byAuthor: boolean) {
  const keyword = b.keyword.trim();
  const threadId = resolveThreadId(b.threadId);
  const scope = threadId ? { sql: ' AND c.thread_id = ?', params: [threadId] } : { sql: '', params: [] as number[] };
  if (b.onlyChanged) scope.sql += ' AND (c.edit_count > 0 OR c.deleted_at IS NOT NULL)';
  if (byAuthor) {
    return b.isExactMatch
      ? { join: '', where: `c.author = ? COLLATE NOCASE${scope.sql}`, params: [keyword, ...scope.params] }
      : { join: '', where: `c.author LIKE ? ESCAPE '\\'${scope.sql}`, params: [`%${likeEscape(keyword)}%`, ...scope.params] };
  }
  const q = ftsQuery(keyword, !!b.isExactMatch);
  if (!q) return null;
  const extra = b.isExactMatch ? " AND c.content_lc LIKE ? ESCAPE '\\'" : '';
  return {
    join: 'JOIN comment_fts f ON f.rowid = c.id',
    where: `comment_fts MATCH ?${extra}${scope.sql}`,
    params: [q, ...(b.isExactMatch ? [`%${likeEscape(keyword.toLowerCase())}%`] : []), ...scope.params],
  };
}

function countComments(b: CommentSearchBody, byAuthor: boolean) {
  const w = commentWhere(b, byAuthor);
  if (!w) return 0;
  return get<{ n: number }>(`SELECT COUNT(*) n FROM comment c ${w.join} WHERE ${w.where}`, ...w.params)!.n;
}

export function searchComments(b: CommentSearchBody, byAuthor: boolean, win?: Win) {
  const size = cfg().search.pageSize;
  const page = intParam(b.page, 1);
  const w = commentWhere(b, byAuthor);
  if (!w) return { items: [] as Hit[], total: 0, page, pageSize: size, nextPage: null };
  const { limit, offset } = win ?? { limit: size, offset: (page - 1) * size };
  const rows = all(
    `SELECT c.id, c.thread_id, c.post_no, c.page, c.author, c.content, c.created_at, c.url,
            c.edit_count, c.edited_at, c.deleted_at, t.title thread_title, t.is_deleted thread_is_deleted
     FROM comment c ${w.join} LEFT JOIN thread t ON t.id = c.thread_id
     WHERE ${w.where} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const total = countComments(b, byAuthor);
  return { items: tagged<Hit>(rows), total, page, pageSize: size, nextPage: page * size < total ? page + 1 : null };
}

/* ---------------- suggestions (related titles) ---------------- */

async function suggestions(q: string, topK: number) {
  const url = cfg().search.semanticSearchUrl;
  if (url) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&top_k=${topK}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        type Hit = { id?: unknown; threadId?: unknown };
        const body = (await res.json()) as Hit[] | { results?: Hit[]; data?: Hit[] };
        const hits = Array.isArray(body) ? body : (body.results ?? body.data ?? []);
        const ids: number[] = hits.map((r) => Number(r.id ?? r.threadId)).filter(Boolean);
        if (ids.length) {
          const rows = all<{ id: number; title: string; author: string; comment_count: number }>(
            `SELECT id, title, author, comment_count FROM thread WHERE id IN (${ids.map(() => '?').join(',')})`,
            ...ids,
          );
          const byId = new Map(rows.map((r) => [r.id, r]));
          return { source: 'semantic', items: tagged(ids.map((id) => byId.get(id)).filter((r) => r !== undefined)) };
        }
      }
    } catch {
      /* fall back to lexical relatedness */
    }
  }
  // Lexical fallback: any-word match ranked by bm25, excluding titles that contain every word.
  const t = tokens(q).filter((w) => w.length >= 2);
  if (!t.length) return { source: 'lexical', items: [] };
  const anyQ = t.map((w) => `"${w}"*`).join(' OR ');
  const allQ = t.map((w) => `"${w}"*`).join(' AND ');
  const rows = all(
    `SELECT t.id, t.title, t.author, t.comment_count FROM thread_fts f JOIN thread t ON t.id = f.rowid
     WHERE thread_fts MATCH ? AND t.id NOT IN (SELECT rowid FROM thread_fts WHERE thread_fts MATCH ?)
     ORDER BY bm25(thread_fts), t.comment_count DESC LIMIT ?`,
    anyQ,
    allQ,
    topK,
  );
  return { source: 'lexical', items: tagged(rows) };
}

/* ---------------- history ---------------- */

function history(kind: Kind, cursor: unknown) {
  const c = intParam(cursor, Number.MAX_SAFE_INTEGER);
  const rows = mainAll<{ id: number; keyword: string; result_count: number; created_at: string }>(
    'SELECT id, keyword, result_count, created_at FROM search_history WHERE kind = ? AND id < ? ORDER BY id DESC LIMIT 20',
    kind,
    c,
  );
  return { items: camelAll(rows), nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}

export function registerSearch(app: FastifyInstance) {
  app.post<{ Body: PostSearchBody }>('/api/posts/search', async (req) => {
    const every = requestSite(req) === null;
    if (every) await assertNoSitePaused('searchPost');
    else assertNotPaused(req, 'searchPost');
    const body = { ...req.body, keyword: validate(req.body?.keyword) };
    const r = every ? await searchEverySite(intParam(body.page, 1), (win) => searchPosts(body, win), postOrder(body)) : searchPosts(body);
    if ((body.page ?? 1) <= 1) record(body.isSearchByAuthor ? 'post_author' : 'post_keyword', body.keyword, r.total);
    return ok(r.items, { total: r.total, page: r.page, pageSize: r.pageSize, nextPage: r.nextPage });
  });

  app.post<{ Body: PostSearchBody }>('/api/posts/search/count', async (req) => {
    const body = { ...req.body, keyword: String(req.body?.keyword ?? '').trim() };
    const count = () => countPosts(body);
    return ok({ total: !body.keyword ? 0 : requestSite(req) === null ? await sumOverSites(count) : count() });
  });

  app.get('/api/posts/search/meta', async () => {
    const r = get<{ n: number }>('SELECT COUNT(*) n FROM thread')!;
    const last = get<{ at: string | null }>("SELECT MAX(sync_finished_at) at FROM sync_history WHERE type='posts' AND error IS NULL")!;
    return ok({ postCount: r.n, postUpdatedAt: last.at });
  });

  app.get<{ Querystring: { cursor?: string } }>('/api/posts/search/recent-keywords', async (req) => {
    const h = history('post_keyword', req.query.cursor);
    return ok(h.items, { nextCursor: h.nextCursor });
  });
  app.get<{ Querystring: { cursor?: string } }>('/api/posts/search/recent-authors', async (req) => {
    const h = history('post_author', req.query.cursor);
    return ok(h.items, { nextCursor: h.nextCursor });
  });

  app.get<{ Querystring: { q?: string; topK?: string } }>('/api/posts/search/suggestions', async (req) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return ok([], { source: 'none' });
    const topKOf = () => intParam(req.query.topK, cfg().search.semanticTopK, 1, 30);
    if (requestSite(req) !== null) {
      const r = await suggestions(q, topKOf());
      return ok(r.items, { source: r.source });
    }
    // `*`: each site's own suggestions, taken from the sites in turn.
    const per = await forEachSite(async () => {
      const topK = topKOf();
      return { topK, ...(await suggestions(q, topK)) };
    });
    const sources = new Set(per.map((p) => p.value.source));
    return ok(interleave(per.map((p) => p.value.items)).slice(0, Math.max(...per.map((p) => p.value.topK))), {
      source: sources.size === 1 ? [...sources][0] : 'mixed',
    });
  });

  /**
   * The site a comment search runs in. A thread link goes to the site of its domain, whichever site
   * the request is for; an ID, or no thread, to the request's site. Null with `*` and no thread:
   * every site; `*` with an ID is refused, since the thread could be on any site.
   */
  const searchTarget = (req: FastifyRequest, threadId: CommentSearchBody['threadId']) => {
    const id = resolveThreadId(threadId) && String(threadId).trim();
    const target = (id ? siteForLink(id) : null) ?? requestSite(req);
    if (target) return { target, extra: target === requestSite(req) ? {} : { site: siteInfo(target) } };
    if (id) throw siteRequired();
    return null;
  };

  const commentSearch = (byAuthor: boolean) => async (req: FastifyRequest<{ Body: CommentSearchBody }>) => {
    const t = searchTarget(req, req.body?.threadId);
    if (t) withSite(t.target, () => assertNotPaused(req, 'searchComment'));
    else await assertNoSitePaused('searchComment');
    const body = { ...req.body, keyword: validate(req.body?.keyword) };
    const r = t
      ? withSite(t.target, () => searchComments(body, byAuthor))
      : await searchEverySite(intParam(body.page, 1), (win) => searchComments(body, byAuthor, win), newestFirst);
    if ((body.page ?? 1) <= 1) record(byAuthor ? 'comment_author' : 'comment_keyword', body.keyword, r.total);
    return ok(r.items, { total: r.total, page: r.page, pageSize: r.pageSize, nextPage: r.nextPage, ...t?.extra });
  };
  app.post('/api/comments/search', commentSearch(false));
  app.post('/api/comments/search-by-author', commentSearch(true));

  app.post<{ Body: CommentSearchBody }>('/api/comments/search/count', async (req) => {
    const t = searchTarget(req, req.body?.threadId);
    const body = { ...req.body, keyword: String(req.body?.keyword ?? '').trim() };
    const count = () => countComments(body, !!body.isSearchByAuthor);
    return ok({ total: !body.keyword ? 0 : t ? withSite(t.target, count) : await sumOverSites(count) }, t?.extra);
  });

  app.get('/api/comments/search/meta', async () => {
    const r = get<{ n: number }>('SELECT COUNT(*) n FROM comment')!;
    const last = get<{ at: string | null }>("SELECT MAX(sync_finished_at) at FROM sync_history WHERE type='comments' AND error IS NULL")!;
    return ok({ commentCount: r.n, commentUpdatedAt: last.at });
  });

  app.get<{ Querystring: { cursor?: string } }>('/api/comments/recent-keywords', async (req) => {
    const h = history('comment_keyword', req.query.cursor);
    return ok(h.items, { nextCursor: h.nextCursor });
  });
  app.get<{ Querystring: { cursor?: string } }>('/api/comments/recent-authors', async (req) => {
    const h = history('comment_author', req.query.cursor);
    return ok(h.items, { nextCursor: h.nextCursor });
  });

  app.delete<{ Params: { kind: Kind } }>('/api/search-history/:kind', async (req) => {
    mainRun('DELETE FROM search_history WHERE kind = ?', req.params.kind);
    return ok(true);
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req) => {
    const t = get('SELECT t.*, f.name forum_name FROM thread t LEFT JOIN forum f ON f.id=t.forum_id WHERE t.id=?', Number(req.params.id));
    if (!t) throw new ApiError(404, 'NOT_FOUND', ['Chưa có bài này trong kho.', 'This thread is not in the archive yet.']);
    return ok(camel(t));
  });

  /** Earlier versions of an edited comment, newest first. */
  app.get<{ Params: { id: string } }>('/api/comments/:id/revisions', async (req) =>
    ok(
      camelAll(
        all('SELECT id, content, captured_at, replaced_at FROM comment_revision WHERE comment_id=? ORDER BY id DESC', Number(req.params.id)),
      ),
    ),
  );
}
