import type { FastifyInstance, FastifyRequest } from 'fastify';
import { all, get, run, now, camelAll, camel } from './db.ts';
import { cfg } from './config.ts';
import { emit, Ev } from './events.ts';
import { ApiError, assertNotPaused, intParam, ok } from './http.ts';
import { parseThreadRef } from './source/xenforo.ts';

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
  if (k.length < min) throw new ApiError(400, 'KEYWORD_TOO_SHORT', `Nhập tối thiểu ${min} ký tự.`, 'inline');
  return k;
}

function record(kind: Kind, keyword: string, resultCount: number) {
  const createdAt = now();
  // Searching the same thing again moves it to the top instead of adding a duplicate row.
  run('DELETE FROM search_history WHERE kind = ? AND keyword = ? COLLATE NOCASE', kind, keyword);
  const r = run('INSERT INTO search_history(kind, keyword, result_count, created_at) VALUES(?,?,?,?)', kind, keyword, resultCount, createdAt);
  const item = { id: Number(r.lastInsertRowid), keyword, resultCount, createdAt };
  emit(HISTORY_EVENT[kind], item, undefined, kind.startsWith('post') ? 'search-post' : 'search-comment');
}

/* ---------------- posts ---------------- */

interface PostSearchBody {
  page?: number;
  keyword: string;
  isSearchByAuthor?: boolean;
  sortDescendingField?: 'createdAt' | 'commentCount';
  isExactMatch?: boolean;
}

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

export function searchPosts(b: PostSearchBody) {
  const w = postWhere(b);
  const size = cfg().search.pageSize;
  const page = intParam(b.page, 1);
  if (!w) return { items: [], total: 0, page, pageSize: size, nextPage: null };
  const order = b.sortDescendingField === 'commentCount' ? 't.comment_count DESC, t.created_at DESC' : 't.created_at DESC';
  const rows = all(
    `SELECT t.id, t.title, t.author, t.forum_id, COALESCE(fo.name, '') forum_name, t.url, t.created_at, t.last_post_at,
            t.comment_count, t.synced_comment_count, t.is_deleted
     FROM thread t ${w.join} LEFT JOIN forum fo ON fo.id = t.forum_id
     WHERE ${w.where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...w.params,
    size,
    (page - 1) * size,
  );
  const total = countPosts(b);
  return {
    items: camelAll(rows),
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
  if (!ref) throw new ApiError(400, 'INVALID_THREAD', 'Không nhận ra link hoặc ID bài viết.', 'inline');
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

export function searchComments(b: CommentSearchBody, byAuthor: boolean) {
  const size = cfg().search.pageSize;
  const page = intParam(b.page, 1);
  const w = commentWhere(b, byAuthor);
  if (!w) return { items: [], total: 0, page, pageSize: size, nextPage: null };
  const rows = all(
    `SELECT c.id, c.thread_id, c.post_no, c.page, c.author, c.content, c.created_at, c.url,
            c.edit_count, c.edited_at, c.deleted_at, t.title thread_title, t.is_deleted thread_is_deleted
     FROM comment c ${w.join} LEFT JOIN thread t ON t.id = c.thread_id
     WHERE ${w.where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    ...w.params,
    size,
    (page - 1) * size,
  );
  const total = countComments(b, byAuthor);
  return { items: camelAll(rows), total, page, pageSize: size, nextPage: page * size < total ? page + 1 : null };
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
        const body: any = await res.json();
        const ids: number[] = (body.results ?? body.data ?? body).map((r: any) => Number(r.id ?? r.threadId)).filter(Boolean);
        if (ids.length) {
          const rows = all(`SELECT id, title, author, comment_count FROM thread WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
          const byId = new Map(rows.map((r: any) => [r.id, r]));
          return { source: 'semantic', items: camelAll(ids.map((id) => byId.get(id)).filter(Boolean) as any) };
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
  return { source: 'lexical', items: camelAll(rows) };
}

/* ---------------- history ---------------- */

function history(kind: Kind, cursor: unknown) {
  const c = intParam(cursor, Number.MAX_SAFE_INTEGER);
  const rows = all<{ id: number; keyword: string; result_count: number; created_at: string }>(
    'SELECT id, keyword, result_count, created_at FROM search_history WHERE kind = ? AND id < ? ORDER BY id DESC LIMIT 20',
    kind,
    c,
  );
  return { items: camelAll(rows), nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}

export function registerSearch(app: FastifyInstance) {
  app.post<{ Body: PostSearchBody }>('/api/posts/search', async (req) => {
    assertNotPaused(req, 'searchPost');
    const body = { ...req.body, keyword: validate(req.body?.keyword) };
    const r = searchPosts(body);
    if ((body.page ?? 1) <= 1) record(body.isSearchByAuthor ? 'post_author' : 'post_keyword', body.keyword, r.total);
    return ok(r.items, { total: r.total, page: r.page, pageSize: r.pageSize, nextPage: r.nextPage });
  });

  app.post<{ Body: PostSearchBody }>('/api/posts/search/count', async (req) => {
    const body = { ...req.body, keyword: String(req.body?.keyword ?? '').trim() };
    return ok({ total: body.keyword ? countPosts(body) : 0 });
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
    const r = await suggestions(q, intParam(req.query.topK, cfg().search.semanticTopK, 1, 30));
    return ok(r.items, { source: r.source });
  });

  const commentSearch = (byAuthor: boolean) => async (req: FastifyRequest<{ Body: CommentSearchBody }>) => {
    assertNotPaused(req, 'searchComment');
    const body = { ...req.body, keyword: validate(req.body?.keyword) };
    const r = searchComments(body, byAuthor);
    if ((body.page ?? 1) <= 1) record(byAuthor ? 'comment_author' : 'comment_keyword', body.keyword, r.total);
    return ok(r.items, { total: r.total, page: r.page, pageSize: r.pageSize, nextPage: r.nextPage });
  };
  app.post('/api/comments/search', commentSearch(false));
  app.post('/api/comments/search-by-author', commentSearch(true));

  app.post<{ Body: CommentSearchBody }>('/api/comments/search/count', async (req) => {
    const body = { ...req.body, keyword: String(req.body?.keyword ?? '').trim() };
    return ok({ total: body.keyword ? countComments(body, !!body.isSearchByAuthor) : 0 });
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
    run('DELETE FROM search_history WHERE kind = ?', req.params.kind);
    return ok(true);
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req) => {
    const t = get('SELECT t.*, f.name forum_name FROM thread t LEFT JOIN forum f ON f.id=t.forum_id WHERE t.id=?', Number(req.params.id));
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'Chưa có bài này trong kho.');
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
