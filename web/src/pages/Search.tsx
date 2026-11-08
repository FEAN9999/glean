import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDate, fmtNum, parseThreadInput } from '../lib/format';
import { Empty, ExternalLink, Highlight, PausedNotice, Sentinel, Spinner, useUi } from '../components/ui';
import { useCreateScrape } from '../components/Scrape';

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
          return [...xs.filter((x) => x.id > top), ...r.data];
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
    <aside aria-labelledby="h-hist">
      <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 id="h-hist" className="section-title" style={{ margin: 0, fontSize: 18 }}>
          {byAuthor ? t('Người đã tìm', 'Recent authors') : t('Đã tìm gần đây', 'Recent searches')}
        </h2>
        {items.length > 0 && (
          <button className="link-btn muted" style={{ fontSize: 13 }} onClick={() => void clear()}>
            {t('Xóa lịch sử', 'Clear history')}
          </button>
        )}
      </div>
      {!items.length && done && <p className="muted" style={{ fontSize: 14 }}>{t('Chưa có lượt tìm nào.', 'No searches yet.')}</p>}
      <ul className="rows">
        {items.map((h) => (
          <li key={h.id} className="row" style={{ padding: '8px 0', gap: 2 }}>
            <button className="link-btn" style={{ textAlign: 'left', textDecoration: 'none', fontWeight: 500 }} onClick={() => onPick(h.keyword)}>
              {h.keyword}
            </button>
            <span className="row-meta" style={{ fontSize: 12.5 }}>
              <span>{t(`${fmtNum(h.resultCount)} kết quả`, `${fmtNum(h.resultCount)} results`)}</span>
              <span>{fmtAgo(h.createdAt)}</span>
            </span>
          </li>
        ))}
      </ul>
      <Sentinel onVisible={() => void load(false)} disabled={done} />
    </aside>
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

  const [keyword, setKeyword] = useState(params.get('q') ?? '');
  const [exact, setExact] = useState(params.get('exact') === '1');
  const [sort, setSort] = useState<'createdAt' | 'commentCount'>((params.get('sort') as any) === 'commentCount' ? 'commentCount' : 'createdAt');
  const [threadScope, setThreadScope] = useState(params.get('thread') ?? '');
  const [inThread, setInThread] = useState(!!params.get('thread'));

  const [items, setItems] = useState<(PostItem | CommentItem)[]>([]);
  const [total, setTotal] = useState(0);
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

  const lastRun = useRef({ key: '', at: 0 });
  const run = useCallback(
    async (q: string, page: number, opts?: { exact?: boolean; sort?: string; thread?: string }) => {
      const kw = q.trim();
      const key = `${kw}|${page}|${byAuthor}|${scope}`;
      if (lastRun.current.key === key && Date.now() - lastRun.current.at < 600) return;
      lastRun.current = { key, at: Date.now() };
      setError('');
      if (kw.length < 3) {
        setError(t('Nhập tối thiểu 3 ký tự.', 'Type at least 3 characters.'));
        return;
      }
      const ex = opts?.exact ?? exact;
      const so = opts?.sort ?? sort;
      const th = opts?.thread ?? (inThread ? threadScope : '');
      if (scope === 'comments' && th && parseThreadInput(th) == null) {
        setError(t('Không nhận ra link hoặc ID bài viết trong phạm vi tìm.', 'The thread link or ID in the scope is not recognised.'));
        return;
      }
      setBusy(true);
      if (page === 1) {
        setOther(null);
        setSuggest([]);
      }
      try {
        let r;
        if (scope === 'posts') {
          r = await api.post<PostItem[]>('/posts/search', { page, keyword: kw, isSearchByAuthor: byAuthor, sortDescendingField: so, isExactMatch: ex }, { quiet: true });
        } else {
          r = await api.post<CommentItem[]>(
            byAuthor ? '/comments/search-by-author' : '/comments/search',
            { page, keyword: kw, isExactMatch: ex, threadId: th ? parseThreadInput(th) : null },
            { quiet: true },
          );
        }
        setItems((xs) => (page === 1 ? r.data : [...xs, ...r.data]));
        setTotal(r.total ?? 0);
        setNextPage((r.nextPage as number | null) ?? null);
        setSearched(kw);
        if (page === 1) {
          const next = new URLSearchParams();
          next.set('q', kw);
          if (ex) next.set('exact', '1');
          if (scope === 'posts' && so === 'commentCount') next.set('sort', so);
          if (scope === 'comments' && th) next.set('thread', th);
          setParams(next, { replace: true });
          if (!r.total) {
            const c = await api.post<{ total: number }>(
              scope === 'posts' ? '/posts/search/count' : '/comments/search/count',
              { keyword: kw, isSearchByAuthor: !byAuthor, isExactMatch: ex, threadId: th ? parseThreadInput(th) : null },
              { quiet: true },
            );
            setOther(c.data.total);
          }
          if (scope === 'posts' && !byAuthor) {
            api
              .get(`/posts/search/suggestions?q=${encodeURIComponent(kw)}&topK=8`, { quiet: true })
              .then((s) => setSuggest(s.data))
              .catch(() => {});
          }
        }
      } catch (err) {
        const e = err as ApiErr;
        if (e.code === 'FEATURE_PAUSED') setError(e.message);
        else setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [byAuthor, exact, inThread, scope, setParams, sort, t, threadScope],
  );

  // Deep link: ?q= runs the search on open, and again when the mode tab changes.
  useEffect(() => {
    setItems([]);
    setSearched(null);
    setOther(null);
    const q = params.get('q');
    if (q) {
      setKeyword(q);
      void run(q, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, mode]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(keyword, 1);
  };

  const switchMode = (q: string) => navigate(`${base}/${byAuthor ? 'tu-khoa' : 'nguoi-dang-bai'}?q=${encodeURIComponent(q)}`);

  const sieve = async (threadId: number) => {
    try {
      await createScrape(String(threadId), scope === 'posts' ? 'search-post' : 'search-comment', { askNavigate: true });
    } catch (err) {
      toast((err as ApiErr).message, 'error');
    }
  };

  const title = scope === 'posts' ? t('Tìm bài viết', 'Find posts') : t('Tìm bình luận', 'Find comments');

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        {meta && (
          <p className="page-lede">
            {scope === 'posts'
              ? t(`Kho có ${fmtNum(meta.count)} bài viết.`, `${fmtNum(meta.count)} threads in the archive.`)
              : t(`Kho có ${fmtNum(meta.count)} bình luận.`, `${fmtNum(meta.count)} comments in the archive.`)}{' '}
            {meta.at ? t(`Dữ liệu được đồng bộ lúc ${fmtDate(meta.at)}.`, `Last synced ${fmtDate(meta.at)}.`) : t('Chưa đồng bộ lần nào.', 'Not synced yet.')}
          </p>
        )}
      </header>

      <PausedNotice feature={scope === 'posts' ? 'searchPost' : 'searchComment'} />

      <div className="seg" role="tablist" aria-label={t('Chế độ tìm', 'Search mode')} style={{ marginBottom: 16 }}>
        <Link role="tab" aria-selected={!byAuthor} className={!byAuthor ? 'on' : ''} to={`${base}/tu-khoa${keyword ? `?q=${encodeURIComponent(keyword)}` : ''}`}>
          {t('Theo từ khóa', 'By keyword')}
        </Link>
        <Link role="tab" aria-selected={byAuthor} className={byAuthor ? 'on' : ''} to={`${base}/nguoi-dang-bai${keyword ? `?q=${encodeURIComponent(keyword)}` : ''}`}>
          {t('Theo người đăng', 'By author')}
        </Link>
      </div>

      <div className="search-layout">
        <div>
          <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
            <div className="sieve-box" style={{ borderWidth: 1 }}>
              <label htmlFor="q" className="sr-only">
                {byAuthor ? t('Tên người đăng', 'Author name') : t('Từ khóa', 'Keyword')}
              </label>
              <input
                id="q"
                style={{ height: 54, fontSize: 17 }}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={
                  byAuthor
                    ? t('Tên người đăng, ví dụ meoXanh', 'Author name, e.g. meoXanh')
                    : scope === 'posts'
                      ? t('Từ khóa trong tiêu đề bài viết', 'Words in the thread title')
                      : t('Từ khóa trong nội dung bình luận', 'Words in the comment text')
                }
                autoComplete="off"
              />
              <button className="btn btn-primary" disabled={busy}>
                {busy ? t('Đang tìm…', 'Searching…') : t('Tìm', 'Search')}
              </button>
            </div>
            <div className="hstack" style={{ gap: 20 }}>
              <div className="seg" aria-label={t('Cách khớp', 'Matching')}>
                <button type="button" className={!exact ? 'on' : ''} onClick={() => setExact(false)}>
                  {byAuthor ? t('Tên chứa', 'Name contains') : t('Chứa các từ', 'Contains words')}
                </button>
                <button type="button" className={exact ? 'on' : ''} onClick={() => setExact(true)}>
                  {byAuthor ? t('Đúng tên', 'Exact name') : t('Đúng cụm từ', 'Exact phrase')}
                </button>
              </div>
              {scope === 'posts' && (
                <label className="hstack" style={{ gap: 8, fontSize: 14 }}>
                  <span className="muted">{t('Sắp xếp', 'Sort')}</span>
                  <select className="select" style={{ width: 'auto', height: 36 }} value={sort} onChange={(e) => setSort(e.target.value as any)}>
                    <option value="createdAt">{t('Mới đăng nhất', 'Newest first')}</option>
                    <option value="commentCount">{t('Nhiều bình luận nhất', 'Most comments')}</option>
                  </select>
                </label>
              )}
              {scope === 'comments' && (
                <label className="check" style={{ fontSize: 14 }}>
                  <input type="checkbox" checked={inThread} onChange={(e) => setInThread(e.target.checked)} />
                  {t('Chỉ trong một bài', 'Within one thread')}
                </label>
              )}
            </div>
            {scope === 'comments' && inThread && (
              <label className="field" style={{ maxWidth: 520 }}>
                <span>{t('Link hoặc ID bài viết', 'Thread link or ID')}</span>
                <input className="input" value={threadScope} onChange={(e) => setThreadScope(e.target.value)} placeholder="…/threads/ten-bai.12345/" />
                <small>
                  {threadScope
                    ? parseThreadInput(threadScope)
                      ? t(`Tìm trong bài #${parseThreadInput(threadScope)}`, `Searching thread #${parseThreadInput(threadScope)}`)
                      : t('Chưa nhận ra ID bài.', 'No thread ID recognised yet.')
                    : t('Để trống để tìm toàn bộ kho.', 'Leave empty to search everything.')}
                </small>
              </label>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
          </form>

          <div style={{ marginTop: 28 }}>
            {busy && !items.length && <Spinner label={scope === 'comments' ? t('Đang quét dữ liệu bình luận…', 'Scanning comments…') : t('Đang tìm…', 'Searching…')} />}
            {busy && !items.length && scope === 'comments' && <p className="muted">{t('Đang quét dữ liệu bình luận…', 'Scanning comments…')}</p>}

            {searched && !busy && total === 0 && (
              <>
                {other ? (
                  <div className="notice notice-straw" role="status">
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
                      : t('Thử ít từ hơn, hoặc đồng bộ thêm dữ liệu ở mục Đồng bộ thủ công.', 'Try fewer words, or pull more data from Manual sync.')}
                  </Empty>
                )}
              </>
            )}

            {items.length > 0 && (
              <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
                {t(`Đang hiển thị ${fmtNum(items.length)} / ${fmtNum(total)} kết quả`, `Showing ${fmtNum(items.length)} of ${fmtNum(total)} results`)}
              </p>
            )}

            <ul className="rows">
              {scope === 'posts'
                ? (items as PostItem[]).map((p) => (
                    <li key={p.id} className="row">
                      <ExternalLink href={p.url} className="row-title">
                        {byAuthor ? p.title : <Highlight text={p.title} q={searched ?? ''} />}
                      </ExternalLink>
                      <div className="row-meta">
                        <button className="link-btn" style={{ fontSize: 13.5 }} onClick={() => navigate(`/bai-viet/nguoi-dang-bai?q=${encodeURIComponent(p.author)}&exact=1`)}>
                          {byAuthor ? <Highlight text={p.author} q={searched ?? ''} /> : p.author}
                        </button>
                        <span>{p.forumName}</span>
                        <span>{fmtDate(p.createdAt)}</span>
                        <span>{t(`${fmtNum(p.commentCount)} bình luận`, `${fmtNum(p.commentCount)} comments`)}</span>
                        {p.isDeleted && <span className="tag tag-rust">{t('Đã bị xóa trên diễn đàn', 'Deleted on the forum')}</span>}
                      </div>
                      <div className="row-actions">
                        <button className="btn btn-sm" onClick={() => void sieve(p.id)}>
                          {t('Lọc ảnh', 'Sieve images')}
                        </button>
                        <Link className="btn btn-sm btn-ghost" to={`/binh-luan/tu-khoa?thread=${p.id}`}>
                          {t('Tìm bình luận trong bài', 'Search its comments')}
                        </Link>
                      </div>
                    </li>
                  ))
                : (items as CommentItem[]).map((c) => (
                    <li key={c.id} className="row">
                      <div className="row-meta">
                        <button className="link-btn" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }} onClick={() => navigate(`/binh-luan/nguoi-dang-bai?q=${encodeURIComponent(c.author)}&exact=1`)}>
                          {byAuthor ? <Highlight text={c.author} q={searched ?? ''} /> : c.author}
                        </button>
                        <span>{fmtDate(c.createdAt)}</span>
                        <span>
                          #{c.postNo}, {t(`trang ${c.page}`, `page ${c.page}`)}
                        </span>
                      </div>
                      <div className="row-body">{byAuthor ? c.content : <Highlight text={c.content} q={searched ?? ''} />}</div>
                      <div className="row-meta">
                        <span>
                          {t('Trong', 'In')} <strong style={{ fontWeight: 500, color: 'var(--text)' }}>{c.threadTitle ?? `#${c.threadId}`}</strong>
                        </span>
                        {!!c.threadIsDeleted && <span className="tag tag-rust">{t('Bài đã bị xóa', 'Thread deleted')}</span>}
                      </div>
                      <div className="row-actions">
                        <ExternalLink href={c.url} className="btn btn-sm">
                          {t('Xem bình luận', 'View comment')}
                        </ExternalLink>
                        <button className="btn btn-sm btn-ghost" onClick={() => void sieve(c.threadId)}>
                          {t('Lọc ảnh bài này', 'Sieve this thread')}
                        </button>
                      </div>
                    </li>
                  ))}
            </ul>

            {nextPage && (
              <button className="btn" style={{ marginTop: 20 }} disabled={busy} onClick={() => void run(searched ?? keyword, nextPage)}>
                {busy ? t('Đang tải…', 'Loading…') : t('Trang tiếp theo', 'Next page')}
              </button>
            )}

            {suggest.length > 0 && (
              <section className="section" aria-labelledby="h-sug" style={{ marginTop: 40 }}>
                <h2 id="h-sug" className="section-title" style={{ fontSize: 18 }}>
                  {t('Bài có thể liên quan', 'Possibly related')}
                </h2>
                <ul className="rows">
                  {suggest.map((s) => (
                    <li key={s.id} className="row" style={{ padding: '10px 0' }}>
                      <button
                        className="link-btn"
                        style={{ textAlign: 'left', textDecoration: 'none', fontWeight: 500 }}
                        onClick={() => {
                          setKeyword(s.title);
                          void run(s.title, 1);
                        }}
                      >
                        {s.title}
                      </button>
                      <span className="row-meta" style={{ fontSize: 12.5 }}>
                        <span>{s.author}</span>
                        <span>{t(`${fmtNum(s.commentCount)} bình luận`, `${fmtNum(s.commentCount)} comments`)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>

        <History
          scope={scope}
          byAuthor={byAuthor}
          onPick={(k) => {
            setKeyword(k);
            void run(k, 1);
          }}
        />
      </div>
    </div>
  );
}
