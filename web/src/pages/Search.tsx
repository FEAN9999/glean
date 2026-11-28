import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiErr, type Envelope } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useLatest } from '../lib/load';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDate, fmtNum, parseThreadInput } from '../lib/format';
import { Empty, ExternalLink, Highlight, PausedNotice, Sentinel, Spinner, Status, useUi } from '../components/ui';
import { useAskSite, useCreateScrape } from '../components/Scrape';
import { ALL, SiteTag, useSites } from '../lib/site';
import { CommentChanges } from '../components/CommentHistory';

type Scope = 'posts' | 'comments';
type Mode = 'tu-khoa' | 'nguoi-dang-bai';

interface RowSite {
  code: string;
  name: string;
}
interface PostItem {
  id: number;
  site: RowSite;
  title: string;
  author: string;
  forumId: number;
  forumName: string;
  url: string;
  createdAt: string;
  lastPostAt: string | null;
  commentCount: number;
  syncedCommentCount: number;
  viewCount: number;
  likeCount: number;
  isDeleted: boolean;
}

type PostSort = 'createdAt' | 'commentCount' | 'viewCount' | 'likeCount';
const POST_SORTS: PostSort[] = ['commentCount', 'viewCount', 'likeCount'];
const postSort = (v: string | null): PostSort => (POST_SORTS.find((s) => s === v) ?? 'createdAt');
interface CommentItem {
  id: number;
  site: RowSite;
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
/** A thread whose title is close to the keyword. */
interface Suggestion {
  id: number;
  site: RowSite;
  title: string;
  author: string;
  commentCount: number;
}

/** The site a search goes to: the one named in the URL (a thread-scoped search), else the picker's choice. */
export function searchSiteOf(params: URLSearchParams, selected: string): string {
  return params.get('trang') ?? selected;
}

/** Request options for a search on `site`. */
const quietAt = (site: string) => ({ quiet: true, site });

/** Says which site a thread link in the scope sent the search to. */
function SearchingIn({ site }: { site: RowSite | null }) {
  const { t } = useI18n();
  if (!site) return null;
  return (
    <p className="muted" role="status" style={{ marginTop: 0 }}>
      {t(`Đang tìm trong trang ${site.name}`, `Searching in ${site.name}`)}
    </p>
  );
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
  const list = historyPath(scope, byAuthor);
  const [shownList, setShownList] = useState(list);
  if (shownList !== list) {
    setShownList(list);
    setItems([]);
    setCursor(null);
    setDone(false);
  }

  const load = useCallback(
    (reset: boolean) => {
      if (loading.current) return;
      loading.current = true;
      const c = reset ? '' : cursor ? `?cursor=${cursor}` : '';
      api
        .get<HistoryItem[]>(historyPath(scope, byAuthor) + c, { quiet: true })
        .then(
          (r) => {
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
          },
          () => setDone(true),
        )
        .finally(() => {
          loading.current = false;
        });
    },
    [scope, byAuthor, cursor],
  );
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, byAuthor]);
  useEvent<HistoryItem>(historyEvent(scope, byAuthor), (m) =>
    setItems((xs) => [m.data, ...xs.filter((x) => x.id !== m.data.id && x.keyword.toLowerCase() !== m.data.keyword.toLowerCase())]),
    { site: '*' },
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
      <Sentinel onVisible={() => load(false)} disabled={done} />
    </section>
  );
}

export function SearchPage({ scope }: { scope: Scope }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const navigate = useNavigate();
  const createScrape = useCreateScrape();
  const askSite = useAskSite();
  const { selected } = useSites();
  const { mode = 'tu-khoa' } = useParams<{ mode: Mode }>();
  const byAuthor = mode === 'nguoi-dang-bai';
  const [params, setParams] = useSearchParams();
  const base = scope === 'posts' ? '/bai-viet' : '/binh-luan';
  const trang = params.get('trang');
  const site = searchSiteOf(params, selected);
  const merged = site === ALL;
  // Keeps a thread-scoped search on its site when the search's own links change the query.
  const withTrang = (qs: string) => (trang ? `${qs}${qs ? '&' : '?'}trang=${encodeURIComponent(trang)}` : qs);

  // The URL is the source of truth: the global search box and the filters only change it.
  const q = (params.get('q') ?? '').trim();
  const exact = params.get('exact') === '1';
  const sort: PostSort = scope === 'posts' ? postSort(params.get('sort')) : 'createdAt';
  const thread = scope === 'comments' ? (params.get('thread') ?? '') : '';
  const changed = scope === 'comments' && params.get('changed') === '1';

  const [inThread, setInThread] = useState(!!thread);
  const [threadDraft, setThreadDraft] = useState(thread);
  const [shownThread, setShownThread] = useState(thread);
  if (shownThread !== thread) {
    setShownThread(thread);
    setInThread(!!thread);
    setThreadDraft(thread);
  }
  const [items, setItems] = useState<(PostItem | CommentItem)[]>([]);
  const [total, setTotal] = useState(0);
  const [otherScopeTotal, setOtherScopeTotal] = useState<number | null>(null);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [other, setOther] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<Suggestion[]>([]);
  const [meta, setMeta] = useState<{ count: number; at: string | null } | null>(null);
  // A new query or filter clears the results shown for the previous one.
  const query = `${q}|${byAuthor}|${scope}|${exact}|${sort}|${thread}|${changed}|${site}`;
  const [shownQuery, setShownQuery] = useState(query);
  // The query whose search last finished, and the page "Show more" is loading.
  const [answered, setAnswered] = useState('');
  const [morePage, setMorePage] = useState<number | null>(null);
  // The site a thread link in the scope pointed to, when it is not the one searched.
  const [threadSite, setThreadSite] = useState<RowSite | null>(null);
  if (shownQuery !== query) {
    setShownQuery(query);
    setItems([]);
    setTotal(0);
    setSearched(null);
    setOther(null);
    setOtherScopeTotal(null);
    setSuggest([]);
    setThreadSite(null);
    setError('');
    setMorePage(null);
  }
  // A query that cannot be searched is answered here, without asking the server.
  const inputError =
    q && q.length < 3
      ? t('Nhập tối thiểu 3 ký tự.', 'Type at least 3 characters.')
      : q && thread && parseThreadInput(thread) == null
        ? t('Không nhận ra link hoặc ID bài viết trong phạm vi tìm.', 'The thread link or ID in the scope is not recognised.')
        : '';
  const busy = (!!q && !inputError && answered !== query) || morePage !== null;

  useEffect(() => {
    // The counts come from one store: with every site chosen there is nothing to ask.
    if (merged) return;
    if (scope === 'posts')
      api.get<{ postCount: number; postUpdatedAt: string | null }>('/posts/search/meta', quietAt(site)).then((r) => setMeta({ count: r.data.postCount, at: r.data.postUpdatedAt })).catch(() => {});
    else api.get<{ commentCount: number; commentUpdatedAt: string | null }>('/comments/search/meta', quietAt(site)).then((r) => setMeta({ count: r.data.commentCount, at: r.data.commentUpdatedAt })).catch(() => {});
  }, [scope, site, merged]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v == null || v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const lastRun = useRef({ key: '', at: 0 });
  const latest = useLatest();
  // Searches page `page` of the current query. It sets no state before the answer arrives, so the
  // effect below can call it; a query that cannot be searched never reaches it (see inputError).
  const run = useCallback(
    (page: number, site: string) => {
      const key = `${query}|${page}`;
      if (lastRun.current.key === key && Date.now() - lastRun.current.at < 600) return;
      lastRun.current = { key, at: Date.now() };
      // A newer run drops the answers of one still loading, so they cannot overwrite its results.
      const isLatest = latest();
      // The server takes the text as typed: a link also tells it which site the thread is on.
      const threadId = thread || null;
      const opts = quietAt(site);
      const search: Promise<Envelope<(PostItem | CommentItem)[]>> =
        scope === 'posts'
          ? api.post<PostItem[]>('/posts/search', { page, keyword: q, isSearchByAuthor: byAuthor, sortDescendingField: sort, isExactMatch: exact }, opts)
          : api.post<CommentItem[]>(
              byAuthor ? '/comments/search-by-author' : '/comments/search',
              { page, keyword: q, isExactMatch: exact, threadId, onlyChanged: changed },
              opts,
            );
      search
        .then(async (r) => {
          if (!isLatest()) return;
          setItems((xs) => (page === 1 ? r.data : [...xs, ...r.data]));
          setTotal(r.total ?? 0);
          setNextPage((r.nextPage as number | null) ?? null);
          setSearched(q);
          setError('');
          if (page === 1) setThreadSite((r.site as RowSite | undefined) ?? null);
          if (page !== 1) return;
          // the other tab's count, so both tabs can show a number
          api
            .post<{ total: number }>(scope === 'posts' ? '/comments/search/count' : '/posts/search/count', { keyword: q, isSearchByAuthor: byAuthor, isExactMatch: exact }, opts)
            .then((c) => isLatest() && setOtherScopeTotal(c.data.total))
            .catch(() => {});
          if (!r.total) {
            const c = await api.post<{ total: number }>(
              scope === 'posts' ? '/posts/search/count' : '/comments/search/count',
              { keyword: q, isSearchByAuthor: !byAuthor, isExactMatch: exact, threadId, onlyChanged: changed },
              opts,
            );
            if (!isLatest()) return;
            setOther(c.data.total);
          }
          if (scope === 'posts' && !byAuthor) {
            api
              .get<Suggestion[]>(`/posts/search/suggestions?q=${encodeURIComponent(q)}&topK=8`, opts)
              .then((s) => isLatest() && setSuggest(s.data))
              .catch(() => {});
          }
        })
        .catch((err) => {
          if (isLatest()) setError((err as ApiErr).message);
        })
        .finally(() => {
          if (!isLatest()) return;
          setAnswered(query);
          setMorePage(null);
        });
    },
    // setMorePage is stable; listing it is what the React Compiler lint wants once the component reads threadSite
    [query, byAuthor, changed, exact, q, scope, sort, thread, latest, setMorePage],
  );

  // Run whenever the query or a filter in the URL changes.
  useEffect(() => {
    if (q && !inputError) run(1, site);
  }, [run, q, inputError, site]);

  const pick = (k: string) => setParam('q', k);
  const switchMode = (kw: string) => navigate(withTrang(`${base}/${byAuthor ? 'tu-khoa' : 'nguoi-dang-bai'}?q=${encodeURIComponent(kw)}`));
  // The ID the site dialog was opened for (open, or cancelled): Enter and blur must not ask again.
  const askedFor = useRef('');
  const applyThread = async () => {
    const v = threadDraft.trim();
    if (!v) {
      // leaving the thread also leaves the site it pinned the search to
      const next = new URLSearchParams(params);
      next.delete('thread');
      next.delete('trang');
      setParams(next, { replace: true });
    } else if (parseThreadInput(v) != null) {
      // A bare ID with every site chosen: say which site it is on.
      if (merged && /^\d+$/.test(v)) {
        if (askedFor.current === v) return;
        askedFor.current = v;
        const code = await askSite(t('Một ID bài viết chưa nói bài ở trang nào.', 'A thread ID does not say which site the thread is on.'));
        if (code == null) return;
        const next = new URLSearchParams(params);
        next.set('thread', v);
        next.set('trang', code);
        setParams(next, { replace: true });
      } else setParam('thread', v);
    }
  };

  const sieve = async (threadId: number, rowSite: string) => {
    try {
      await createScrape(String(threadId), scope === 'posts' ? 'search-post' : 'search-comment', { site: rowSite, askNavigate: true });
    } catch (err) {
      toast((err as ApiErr).message, 'error');
    }
  };

  const tabQuery = (s: Scope) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (exact) p.set('exact', '1');
    if (s === scope) {
      if (sort !== 'createdAt') p.set('sort', sort);
      if (thread) p.set('thread', thread);
      if (changed) p.set('changed', '1');
    }
    if (trang) p.set('trang', trang);
    const str = p.toString();
    return str ? `?${str}` : '';
  };
  const count = (s: Scope) => (!searched ? null : s === scope ? total : otherScopeTotal);
  const shownMeta = merged ? null : meta;
  const synced = shownMeta ? (shownMeta.at ? t(`dữ liệu đồng bộ ${fmtAgo(shownMeta.at)}`, `data synced ${fmtAgo(shownMeta.at)}`) : t('chưa đồng bộ lần nào', 'not synced yet')) : '';

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
            : shownMeta
              ? `${scope === 'posts' ? t(`Kho có ${fmtNum(shownMeta.count)} bài viết`, `${fmtNum(shownMeta.count)} threads in the archive`) : t(`Kho có ${fmtNum(shownMeta.count)} bình luận`, `${fmtNum(shownMeta.count)} comments in the archive`)} · ${synced}`
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
            <select className="pick" aria-label={t('Sắp xếp', 'Sort')} value={sort} onChange={(e) => setParam('sort', postSort(e.target.value) === 'createdAt' ? null : e.target.value)}>
              <option value="createdAt">{t('Mới nhất', 'Newest')}</option>
              <option value="commentCount">{t('Nhiều bình luận nhất', 'Most comments')}</option>
              <option value="viewCount">{t('Nhiều lượt xem nhất', 'Most views')}</option>
              <option value="likeCount">{t('Nhiều like nhất', 'Most likes')}</option>
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
            void applyThread();
          }}
        >
          <span>{t('Link hoặc ID bài viết', 'Thread link or ID')}</span>
          <input className="input" value={threadDraft} onChange={(e) => {
              askedFor.current = '';
              setThreadDraft(e.target.value);
            }} onBlur={() => void applyThread()} placeholder="…/threads/ten-bai.12345/" autoFocus={!thread} />
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
          {(inputError || error) && (
            <p className="error-text" role="alert" style={{ marginTop: 0 }}>
              {inputError || error}
            </p>
          )}
          <SearchingIn site={threadSite} />
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
                      {merged && <SiteTag code={p.site.code} />}
                      <button className="link-btn muted" onClick={() => navigate(`/bai-viet/nguoi-dang-bai?q=${encodeURIComponent(p.author)}&exact=1`)}>
                        {byAuthor ? <Highlight text={p.author} q={searched ?? ''} /> : p.author}
                      </button>
                      <span>{p.forumName}</span>
                      <span>{fmtDate(p.createdAt, false)}</span>
                      <span>{t(`${fmtNum(p.commentCount)} bình luận`, `${fmtNum(p.commentCount)} comments`)}</span>
                      <span>{t(`${fmtNum(p.viewCount)} lượt xem`, `${fmtNum(p.viewCount)} views`)}</span>
                      <span>{t(`${fmtNum(p.likeCount)} like`, `${fmtNum(p.likeCount)} likes`)}</span>
                      <Link className="link-btn muted" to={`/binh-luan/tu-khoa?thread=${p.id}&trang=${p.site.code}`}>
                        {t('Tìm bình luận trong bài', 'Search its comments')}
                      </Link>
                    </span>
                  </div>
                  {p.isDeleted ? (
                    <Status tone="bad">{t('Đã xóa · còn bản lưu', 'Deleted · copy kept')}</Status>
                  ) : (
                    <button className="btn btn-primary" onClick={() => void sieve(p.id, p.site.code)}>
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
                      {merged && <SiteTag code={c.site.code} />}
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
                    <CommentChanges id={c.id} editCount={c.editCount} editedAt={c.editedAt} deletedAt={c.deletedAt} site={c.site.code} />
                    <span className="row-actions" style={{ paddingTop: 2 }}>
                      <ExternalLink href={c.url} className="link-btn">
                        {t('Xem bình luận', 'View comment')}
                      </ExternalLink>
                      <button className="link-btn" onClick={() => void sieve(c.threadId, c.site.code)}>
                        {t('Sàng bài này', 'Sieve this thread')}
                      </button>
                    </span>
                  </div>
                </div>
              ))}

          {nextPage && (
            <button
              className="more-btn"
              disabled={busy}
              onClick={() => {
                setMorePage(nextPage);
                run(nextPage, site);
              }}
            >
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
                <button key={`${s.site.code}:${s.id}`} className="line" style={{ padding: '10px 0' }} onClick={() => pick(s.title)}>
                  <span className="line-text">
                    <span className="line-title">{s.title}</span>
                    <span className="line-sub">
                      {merged && (
                        <>
                          <SiteTag code={s.site.code} />{' '}
                        </>
                      )}
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
