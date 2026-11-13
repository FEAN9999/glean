import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDate, fmtNum, parseThreadInput } from '../lib/format';
import { Empty, ExternalLink, Highlight, PausedNotice, Sentinel, Spinner, Status, useUi } from '../components/ui';
import { useCreateScrape } from '../components/Scrape';
import { CommentChanges } from '../components/CommentHistory';

type Scope = 'posts' | 'comments';
type Mode = 'tu-khoa' | 'nguoi-dang-bai';

interface PostItem {
  id: number;
  title: string;
  author: string;
  forumId: number;
  forumName: string;
  url: string;
  createdAt: string;
  lastPostAt: string | null;
  commentCount: number;
  syncedCommentCount: number;
  isDeleted: boolean;
}
interface CommentItem {
  id: number;
  threadId: number;
  postNo: number;
  page: number;
  author: string;
  content: string;
  createdAt: string;
  url: string;
  threadTitle: string | null;
  threadIsDeleted: number | null;
  editCount: number;
  editedAt: string | null;
  deletedAt: string | null;
}
interface HistoryItem {
  id: number;
  keyword: string;
  resultCount: number;
  createdAt: string;
}

function historyPath(scope: Scope, byAuthor: boolean) {
  if (scope === 'posts') return byAuthor ? '/posts/search/recent-authors' : '/posts/search/recent-keywords';
  return byAuthor ? '/comments/recent-authors' : '/comments/recent-keywords';
}
function historyEvent(scope: Scope, byAuthor: boolean) {
  if (scope === 'posts') return byAuthor ? Ev.NewSearchByAuthor : Ev.NewSearch;
  return byAuthor ? Ev.NewCommentSearchByAuthor : Ev.NewCommentSearch;
}

function History({ scope, byAuthor, onPick }: { scope: Scope; byAuthor: boolean; onPick: (k: string) => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const loading = useRef(false);

  const load = useCallback(
    async (reset: boolean) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const c = reset ? '' : cursor ? `?cursor=${cursor}` : '';
        const r = await api.get<HistoryItem[]>(historyPath(scope, byAuthor) + c, { quiet: true });
        // keep live items that arrived (via realtime) while this page was loading
        setItems((xs) => {
          if (!reset) return [...xs, ...r.data];
          const top = r.data[0]?.id ?? 0;
          const live = xs.filter((x) => x.id > top);
          const seen = new Set(live.map((x) => x.keyword.toLowerCase()));
          return [...live, ...r.data.filter((x) => !seen.has(x.keyword.toLowerCase()))];
        });
        setCursor(r.nextCursor as number | null);
        setDone(!r.nextCursor);
      } catch {
        setDone(true);
      } finally {
        loading.current = false;
      }
    },
    [scope, byAuthor, cursor],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDone(false);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, byAuthor]);
  useEvent(historyEvent(scope, byAuthor), (m) =>
    setItems((xs) => [m.data as HistoryItem, ...xs.filter((x) => x.id !== m.data.id && x.keyword.toLowerCase() !== m.data.keyword.toLowerCase())]),
  );

  const clear = async () => {
    const kind = `${scope === 'posts' ? 'post' : 'comment'}_${byAuthor ? 'author' : 'keyword'}`;
    await api.del(`/search-history/${kind}`);
    setItems([]);
    setDone(true);
  };

  return (
    <section aria-labelledby="h-hist">
      <div className="section-head" style={{ alignItems: 'baseline' }}>
        <h2 id="h-hist" className="section-title" style={{ paddingBottom: 2 }}>
          {byAuthor ? t('Người đã tìm', 'Recent authors') : t('Đã tìm gần đây', 'Recent searches')}
        </h2>
        {items.length > 0 && (
          <button className="link-btn muted" style={{ fontSize: 13 }} onClick={() => void clear()}>
            {t('Xóa lịch sử', 'Clear history')}
          </button>
        )}
      </div>
      {!items.length && done && <p className="muted" style={{ margin: '6px 0 0' }}>{t('Chưa có lượt tìm nào.', 'No searches yet.')}</p>}
      {items.map((h) => (
        <button key={h.id} className="line" style={{ padding: '10px 0' }} onClick={() => onPick(h.keyword)}>
          <span className="line-text">
            <span className="line-title ellipsis">{h.keyword}</span>
            <span className="line-sub">{fmtAgo(h.createdAt)}</span>
          </span>
          <span className="line-value">{t(`${fmtNum(h.resultCount)} kết quả`, `${fmtNum(h.resultCount)} results`)}</span>
        </button>
      ))}
      <Sentinel onVisible={() => void load(false)} disabled={done} />
    </section>
  );
}

export function SearchPage({ scope }: { scope: Scope }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const navigate = useNavigate();
  const createScrape = useCreateScrape();
  const { mode = 'tu-khoa' } = useParams<{ mode: Mode }>();
  const byAuthor = mode === 'nguoi-dang-bai';
  const [params, setParams] = useSearchParams();
  const base = scope === 'posts' ? '/bai-viet' : '/binh-luan';

  // The URL is the source of truth: the global search box and the filters only change it.
  const q = (params.get('q') ?? '').trim();
  const exact = params.get('exact') === '1';
  const sort: 'createdAt' | 'commentCount' = scope === 'posts' && params.get('sort') === 'commentCount' ? 'commentCount' : 'createdAt';
  const thread = scope === 'comments' ? (params.get('thread') ?? '') : '';
  const changed = scope === 'comments' && params.get('changed') === '1';

  const [inThread, setInThread] = useState(!!thread);
  const [threadDraft, setThreadDraft] = useState(thread);
  const [items, setItems] = useState<(PostItem | CommentItem)[]>([]);
  const [total, setTotal] = useState(0);
  const [otherScopeTotal, setOtherScopeTotal] = useState<number | null>(null);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [other, setOther] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<{ id: number; title: string; author: string; commentCount: number }[]>([]);
  const [meta, setMeta] = useState<{ count: number; at: string | null } | null>(null);

  useEffect(() => {
    if (scope === 'posts')
      api.get('/posts/search/meta', { quiet: true }).then((r) => setMeta({ count: r.data.postCount, at: r.data.postUpdatedAt })).catch(() => {});
    else api.get('/comments/search/meta', { quiet: true }).then((r) => setMeta({ count: r.data.commentCount, at: r.data.commentUpdatedAt })).catch(() => {});
  }, [scope]);

  useEffect(() => {
    setInThread(!!thread);
    setThreadDraft(thread);
  }, [thread]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v == null || v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const lastRun = useRef({ key: '', at: 0 });
  const run = useCallback(
    async (page: number) => {
      const key = `${q}|${page}|${byAuthor}|${scope}|${exact}|${sort}|${thread}|${changed}`;
      if (lastRun.current.key === key && Date.now() - lastRun.current.at < 600) return;
      lastRun.current = { key, at: Date.now() };
      setError('');
      if (q.length < 3) {
        setError(t('Nhập tối thiểu 3 ký tự.', 'Type at least 3 characters.'));
        return;
      }
      const threadId = thread ? parseThreadInput(thread) : null;
      if (thread && threadId == null) {
        setError(t('Không nhận ra link hoặc ID bài viết trong phạm vi tìm.', 'The thread link or ID in the scope is not recognised.'));
        return;
      }
      setBusy(true);
      if (page === 1) {
        setOther(null);
        setSuggest([]);
        setOtherScopeTotal(null);
      }
      try {
        const r =
          scope === 'posts'
            ? await api.post<PostItem[]>('/posts/search', { page, keyword: q, isSearchByAuthor: byAuthor, sortDescendingField: sort, isExactMatch: exact }, { quiet: true })
            : await api.post<CommentItem[]>(
                byAuthor ? '/comments/search-by-author' : '/comments/search',
                { page, keyword: q, isExactMatch: exact, threadId, onlyChanged: changed },
                { quiet: true },
              );
        setItems((xs) => (page === 1 ? r.data : [...xs, ...r.data]));
        setTotal(r.total ?? 0);
        setNextPage((r.nextPage as number | null) ?? null);
        setSearched(q);
        if (page === 1) {
          // the other tab's count, so both tabs can show a number
          api
            .post<{ total: number }>(scope === 'posts' ? '/comments/search/count' : '/posts/search/count', { keyword: q, isSearchByAuthor: byAuthor, isExactMatch: exact }, { quiet: true })
            .then((c) => setOtherScopeTotal(c.data.total))
            .catch(() => {});
          if (!r.total) {
            const c = await api.post<{ total: number }>(
              scope === 'posts' ? '/posts/search/count' : '/comments/search/count',
              { keyword: q, isSearchByAuthor: !byAuthor, isExactMatch: exact, threadId, onlyChanged: changed },
              { quiet: true },
            );
            setOther(c.data.total);
          }
          if (scope === 'posts' && !byAuthor) {
            api
              .get(`/posts/search/suggestions?q=${encodeURIComponent(q)}&topK=8`, { quiet: true })
              .then((s) => setSuggest(s.data))
              .catch(() => {});
          }
        }
      } catch (err) {
        setError((err as ApiErr).message);
      } finally {
        setBusy(false);
      }
    },
    [byAuthor, changed, exact, q, scope, sort, t, thread],
  );

  // Run whenever the query or a filter in the URL changes.
  useEffect(() => {
    setItems([]);
    setTotal(0);
    setSearched(null);
    setOther(null);
    setOtherScopeTotal(null);
    setError('');
    if (q) void run(1);
  }, [run, q]);

  const pick = (k: string) => setParam('q', k);
  const switchMode = (kw: string) => navigate(`${base}/${byAuthor ? 'tu-khoa' : 'nguoi-dang-bai'}?q=${encodeURIComponent(kw)}`);
  const applyThread = () => {
    const v = threadDraft.trim();
    if (!v) setParam('thread', null);
    else if (parseThreadInput(v) != null) setParam('thread', v);
  };

  const sieve = async (threadId: number) => {
    try {
      await createScrape(String(threadId), scope === 'posts' ? 'search-post' : 'search-comment', { askNavigate: true });
    } catch (err) {
      toast((err as ApiErr).message, 'error');
    }
  };

  const tabQuery = (s: Scope) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (exact) p.set('exact', '1');
    if (s === scope) {
      if (sort === 'commentCount') p.set('sort', sort);
      if (thread) p.set('thread', thread);
      if (changed) p.set('changed', '1');
    }
    const str = p.toString();
    return str ? `?${str}` : '';
  };
  const count = (s: Scope) => (!searched ? null : s === scope ? total : otherScopeTotal);
  const synced = meta ? (meta.at ? t(`dữ liệu đồng bộ ${fmtAgo(meta.at)}`, `data synced ${fmtAgo(meta.at)}`) : t('chưa đồng bộ lần nào', 'not synced yet')) : '';

  return (
    <div className="page">
      <header className="page-head tight">
        <h1 className="page-title">
          {searched
            ? t(`Kết quả cho "${searched}"`, `Results for "${searched}"`)
            : scope === 'posts'
              ? t('Tìm bài viết', 'Find threads')
              : t('Tìm bình luận', 'Find comments')}
        </h1>
        <p className="page-lede">
          {searched
            ? `${t(`${fmtNum(total)} kết quả`, `${fmtNum(total)} results`)}${synced ? ` · ${synced}` : ''}`
            : meta
              ? `${scope === 'posts' ? t(`Kho có ${fmtNum(meta.count)} bài viết`, `${fmtNum(meta.count)} threads in the archive`) : t(`Kho có ${fmtNum(meta.count)} bình luận`, `${fmtNum(meta.count)} comments in the archive`)} · ${synced}`
              : ''}
        </p>
      </header>

      <PausedNotice feature={scope === 'posts' ? 'searchPost' : 'searchComment'} />

      <div className="tabs-bar">
        <nav className="tabs" aria-label={t('Loại kết quả', 'Result type')}>
          {(['posts', 'comments'] as const).map((s) => (
            <Link key={s} to={`/${s === 'posts' ? 'bai-viet' : 'binh-luan'}/${mode}${tabQuery(s)}`} className={s === scope ? 'on' : ''} aria-current={s === scope ? 'page' : undefined}>
              {s === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')}
              {count(s) != null && <span className="count">{fmtNum(count(s))}</span>}
            </Link>
          ))}
        </nav>
        <div className="filters">
          <select className="pick" aria-label={t('Cách khớp', 'Matching')} value={exact ? '1' : '0'} onChange={(e) => setParam('exact', e.target.value === '1' ? '1' : null)}>
            <option value="0">{byAuthor ? t('Tên chứa', 'Name contains') : t('Chứa các từ', 'Contains words')}</option>
            <option value="1">{byAuthor ? t('Đúng tên', 'Exact name') : t('Đúng cụm từ', 'Exact phrase')}</option>
          </select>
          <select
            className="pick"
            aria-label={t('Chế độ tìm', 'Search mode')}
            value={mode}
            onChange={(e) => navigate(`${base}/${e.target.value}${params.toString() ? `?${params}` : ''}`)}
          >
            <option value="tu-khoa">{t('Theo từ khóa', 'By keyword')}</option>
            <option value="nguoi-dang-bai">{t('Theo người đăng', 'By author')}</option>
          </select>
          {scope === 'posts' && (
            <select className="pick" aria-label={t('Sắp xếp', 'Sort')} value={sort} onChange={(e) => setParam('sort', e.target.value === 'commentCount' ? 'commentCount' : null)}>
              <option value="createdAt">{t('Mới nhất', 'Newest')}</option>
              <option value="commentCount">{t('Nhiều bình luận nhất', 'Most comments')}</option>
            </select>
          )}
          {scope === 'comments' && (
            <label className="check pick" style={{ backgroundImage: 'none', paddingRight: 14, display: 'inline-flex' }}>
              <input
                type="checkbox"
                checked={inThread}
                onChange={(e) => {
                  setInThread(e.target.checked);
                  if (!e.target.checked) setParam('thread', null);
                }}
              />
              {t('Chỉ trong một bài', 'Within one thread')}
            </label>
          )}
          {scope === 'comments' && (
            <label className="check pick" style={{ backgroundImage: 'none', paddingRight: 14, display: 'inline-flex' }}>
              <input type="checkbox" checked={changed} onChange={(e) => setParam('changed', e.target.checked ? '1' : null)} />
              {t('Chỉ bình luận đã sửa/xóa', 'Only edited/deleted comments')}
            </label>
          )}
        </div>
      </div>

      {scope === 'comments' && inThread && (
        <form
          className="field"
          style={{ maxWidth: 520, paddingTop: 18 }}
          onSubmit={(e) => {
            e.preventDefault();
            applyThread();
          }}
        >
          <span>{t('Link hoặc ID bài viết', 'Thread link or ID')}</span>
          <input className="input" value={threadDraft} onChange={(e) => setThreadDraft(e.target.value)} onBlur={applyThread} placeholder="…/threads/ten-bai.12345/" autoFocus={!thread} />
          <small>
            {threadDraft
              ? parseThreadInput(threadDraft)
                ? t(`Tìm trong bài #${parseThreadInput(threadDraft)}. Nhấn Enter để áp dụng.`, `Searching thread #${parseThreadInput(threadDraft)}. Press Enter to apply.`)
                : t('Chưa nhận ra ID bài.', 'No thread ID recognised yet.')
              : t('Để trống để tìm toàn bộ kho.', 'Leave empty to search everything.')}
          </small>
        </form>
      )}

      <div className="cols">
        <section className="col-main" style={{ paddingTop: 24 }} aria-live="polite">
          {error && (
            <p className="error-text" role="alert" style={{ marginTop: 0 }}>
              {error}
            </p>
          )}
          {busy && !items.length && <Spinner label={scope === 'comments' ? t('Đang quét dữ liệu bình luận…', 'Scanning comments…') : t('Đang tìm…', 'Searching…')} />}

          {!q && (
            <Empty title={t('Gõ từ khóa vào ô tìm ở trên', 'Type into the search box above')}>
              {byAuthor
                ? t('Đang tìm theo tên người đăng.', 'Searching by author name.')
                : scope === 'posts'
                  ? t('Tìm theo tiêu đề bài viết. Dán link bài viết thay vì từ khóa để đưa bài vào hàng đợi sàng.', 'Searches thread titles. Paste a thread link instead to queue it for sieving.')
                  : t('Tìm trong nội dung bình luận đã đồng bộ về kho.', 'Searches the text of comments synced into the archive.')}
            </Empty>
          )}

          {searched && !busy && total === 0 && (
            <>
              {other ? (
                <div className="notice notice-straw" role="status" style={{ alignItems: 'center' }}>
                  <span>
                    {byAuthor
                      ? t(`Có thể bạn đang tìm nhầm mục: tìm theo từ khóa có ${fmtNum(other)} kết quả.`, `Wrong mode? Searching by keyword finds ${fmtNum(other)} results.`)
                      : t(`Có thể bạn đang tìm nhầm mục: tìm theo người đăng có ${fmtNum(other)} kết quả.`, `Wrong mode? Searching by author finds ${fmtNum(other)} results.`)}
                  </span>
                  <button className="btn btn-sm" onClick={() => switchMode(searched)}>
                    {t('Xem kết quả đó', 'Show those results')}
                  </button>
                </div>
              ) : (
                <Empty title={t(`Không có kết quả cho "${searched}"`, `No results for "${searched}"`)}>
                  {exact
                    ? t('Thử chuyển sang "Chứa các từ" để khớp rộng hơn.', 'Try "Contains words" for a looser match.')
                    : t('Thử ít từ hơn, hoặc đồng bộ thêm dữ liệu ở mục Đồng bộ.', 'Try fewer words, or pull more data from Sync.')}
                </Empty>
              )}
            </>
          )}

          {items.length > 0 && (
            <div className="section-head" style={{ alignItems: 'baseline', paddingBottom: 6 }}>
              <h2 className="section-title">{scope === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')}</h2>
              <span className="muted" style={{ fontSize: 13 }}>
                {t(`Đang hiển thị ${fmtNum(items.length)} / ${fmtNum(total)}`, `Showing ${fmtNum(items.length)} of ${fmtNum(total)}`)}
              </span>
            </div>
          )}

          {scope === 'posts'
            ? (items as PostItem[]).map((p) => (
                <div key={p.id} className="result">
                  <div className="result-text">
                    <ExternalLink href={p.url} className="result-title">
                      {byAuthor ? p.title : <Highlight text={p.title} q={searched ?? ''} />}
                    </ExternalLink>
                    <span className="row-meta">
                      <button className="link-btn muted" onClick={() => navigate(`/bai-viet/nguoi-dang-bai?q=${encodeURIComponent(p.author)}&exact=1`)}>
                        {byAuthor ? <Highlight text={p.author} q={searched ?? ''} /> : p.author}
                      </button>
                      <span>{p.forumName}</span>
                      <span>{fmtDate(p.createdAt, false)}</span>
                      <span>{t(`${fmtNum(p.commentCount)} bình luận`, `${fmtNum(p.commentCount)} comments`)}</span>
                      <Link className="link-btn muted" to={`/binh-luan/tu-khoa?thread=${p.id}`}>
                        {t('Tìm bình luận trong bài', 'Search its comments')}
                      </Link>
                    </span>
                  </div>
                  {p.isDeleted ? (
                    <Status tone="bad">{t('Đã xóa · còn bản lưu', 'Deleted · copy kept')}</Status>
                  ) : (
                    <button className="btn btn-primary" onClick={() => void sieve(p.id)}>
                      {t('Sàng bài này', 'Sieve thread')}
                    </button>
                  )}
                </div>
              ))
            : (items as CommentItem[]).map((c) => (
                <div key={c.id} className="comment">
                  <span className="avatar" aria-hidden="true">
                    {c.author?.[0] ?? '?'}
                  </span>
                  <div className="comment-text">
                    <span className="row-body">{byAuthor ? c.content : <Highlight text={c.content} q={searched ?? ''} />}</span>
                    <span className="row-meta comment-meta">
                      <button className="link-btn muted" onClick={() => navigate(`/binh-luan/nguoi-dang-bai?q=${encodeURIComponent(c.author)}&exact=1`)}>
                        {byAuthor ? <Highlight text={c.author} q={searched ?? ''} /> : c.author}
                      </button>
                      <span>{t(`#${c.postNo} trang ${c.page}`, `#${c.postNo} page ${c.page}`)}</span>
                      <span>{fmtDate(c.createdAt)}</span>
                      <span>
                        {t('trong', 'in')} {c.threadTitle ?? `#${c.threadId}`}
                      </span>
                      {!!c.threadIsDeleted && <span style={{ color: 'var(--bad-ink)' }}>{t('bài đã bị xóa', 'thread deleted')}</span>}
                    </span>
                    <CommentChanges id={c.id} editCount={c.editCount} editedAt={c.editedAt} deletedAt={c.deletedAt} />
                    <span className="row-actions" style={{ paddingTop: 2 }}>
                      <ExternalLink href={c.url} className="link-btn">
                        {t('Xem bình luận', 'View comment')}
                      </ExternalLink>
                      <button className="link-btn" onClick={() => void sieve(c.threadId)}>
                        {t('Sàng bài này', 'Sieve this thread')}
                      </button>
                    </span>
                  </div>
                </div>
              ))}

          {nextPage && (
            <button className="more-btn" disabled={busy} onClick={() => void run(nextPage)}>
              {busy
                ? t('Đang tải…', 'Loading…')
                : t(`Xem thêm ${fmtNum(Math.max(0, total - items.length))} kết quả`, `Show ${fmtNum(Math.max(0, total - items.length))} more`)}
            </button>
          )}
        </section>

        <aside className="col-side" style={{ paddingTop: 24 }}>
          <History scope={scope} byAuthor={byAuthor} onPick={pick} />
          {suggest.length > 0 && (
            <section aria-labelledby="h-sug" style={{ paddingTop: 26 }}>
              <h2 id="h-sug" className="section-title" style={{ paddingBottom: 2 }}>
                {t('Có thể liên quan', 'Possibly related')}
              </h2>
              {suggest.map((s) => (
                <button key={s.id} className="line" style={{ padding: '10px 0' }} onClick={() => pick(s.title)}>
                  <span className="line-text">
                    <span className="line-title">{s.title}</span>
                    <span className="line-sub">
                      {s.author} · {t(`${fmtNum(s.commentCount)} bình luận`, `${fmtNum(s.commentCount)} comments`)}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
