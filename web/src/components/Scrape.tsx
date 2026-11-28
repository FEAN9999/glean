import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { singleFlight } from '../lib/load';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtNum, fmtTime } from '../lib/format';
import { ALL, useSites } from '../lib/site';
import { Dialog, Donut, Mesh, useUi } from './ui';

export const ScrapeStatus = { None: 0, Waiting: 1, Processing: 2, Completed: 3, Failed: 4, NotProcessed: 5 } as const;

export interface Scrape {
  id: number;
  threadId: number;
  threadTitle: string | null;
  threadUrl: string;
  source: string;
  status: number;
  totalPages: number;
  currentPage: number;
  totalImages: number;
  totalVideos: number;
  totalComments: number;
  totalLinks: number;
  imagesBeforeLastPage: number;
  videosBeforeLastPage: number;
  commentsBeforeLastPage: number;
  linksBeforeLastPage: number;
  downloadedImages: number;
  handlingSeconds: number | null;
  isThreadDeleted: boolean;
  isMarkedDeleted: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  syncedCommentCount?: number;
  failedImages?: number;
  donePages?: number[];
  /** Items kept from earlier runs whose posts are no longer on the forum (detail endpoint only). */
  missingCounts?: { images: number; videos: number; links: number; comments: number };
  /** The site the job belongs to (archive rows only). */
  site?: { code: string; name: string };
}

/** The detail page of job `id` of site `code`: job ids repeat across sites, so the link names the site. */
export const scrapePath = (id: number, code: string) => `/sang/${id}?trang=${encodeURIComponent(code)}`;

export function useStatusLabel() {
  const { t } = useI18n();
  return (s: number) =>
    ({
      [ScrapeStatus.Waiting]: t('Đang chờ', 'Queued'),
      [ScrapeStatus.Processing]: t('Đang sàng', 'Sieving'),
      [ScrapeStatus.Completed]: t('Xong', 'Done'),
      [ScrapeStatus.Failed]: t('Thất bại', 'Failed'),
      [ScrapeStatus.NotProcessed]: t('Chưa xử lý', 'Not processed'),
    })[s] ?? t('Không rõ', 'Unknown');
}

/** Creates a sieve job; tells about an old domain. `opts.site` names the site a bare ID belongs to. Returns the job. */
export function useCreateScrape() {
  const { t } = useI18n();
  const { toast } = useUi();
  const navigate = useNavigate();
  return useCallback(
    async (input: string, source: string, opts: { navigate?: boolean; askNavigate?: boolean; site?: string } = {}) => {
      const r = await api.post<{
        scrape: Scrape;
        reused: boolean;
        rerun: boolean;
        domainWarning: null | { host: string; knownOldDomain: true; currentHost: string };
        site: { code: string; name: string };
      }>('/scrapes/create-scrape', { url: input, source }, { quiet: true, site: opts.site });
      const { scrape, reused, rerun, domainWarning, site } = r.data;
      const to = scrapePath(scrape.id, site.code);
      if (domainWarning) {
        toast(
          t(
            `Link dùng tên miền cũ ${domainWarning.host}. Diễn đàn đã chuyển sang ${domainWarning.currentHost}; Glean tự đổi sang tên miền mới.`,
            `The link uses the old domain ${domainWarning.host}. The forum moved to ${domainWarning.currentHost}; Glean uses the new one.`,
          ),
        );
      }
      if (opts.navigate) navigate(to);
      else if (opts.askNavigate)
        toast(
          rerun
            ? t('Bài này đã sàng trước đây. Glean sàng lại vào lượt cũ, giữ những gì đã lưu.', 'This thread was sieved before. Glean sieves it again into the same job, keeping what it saved.')
            : reused
              ? t('Bài này đã có trong hàng đợi.', 'This thread is already queued.')
              : t(`Đã đưa bài vào hàng đợi sàng của ${site.name}`, `Thread added to the sieve queue of ${site.name}`),
          'info',
          { label: t('Xem tiến trình', 'View progress'), run: () => navigate(to) },
        );
      return scrape;
    },
    [navigate, t, toast],
  );
}

/* ---------------- asking which site a bare thread ID is on ---------------- */

interface SiteAsk {
  reason: string;
  resolve: (code: string | null) => void;
}
let pendingAsk: SiteAsk | null = null;
const askListeners = new Set<() => void>();
const setAsk = (a: SiteAsk | null) => {
  pendingAsk = a;
  askListeners.forEach((l) => l());
};

/** Opens the "which site?" dialog; resolves with the chosen site's code, or null when cancelled. */
export function useAskSite(): (reason: string) => Promise<string | null> {
  return useCallback(
    (reason: string) =>
      new Promise<string | null>((resolve) => {
        pendingAsk?.resolve(null);
        setAsk({ reason, resolve });
      }),
    [],
  );
}

/** The dialog `useAskSite` opens; mounted once, in the Shell. */
export function SiteAskHost() {
  const { t } = useI18n();
  const { sites } = useSites();
  const ask = useSyncExternalStore(
    (l) => {
      askListeners.add(l);
      return () => {
        askListeners.delete(l);
      };
    },
    () => pendingAsk,
  );
  if (!ask) return null;
  const close = (code: string | null) => {
    ask.resolve(code);
    setAsk(null);
  };
  return (
    <Dialog title={t('Bài này thuộc trang nào?', 'Which site is this thread on?')} onClose={() => close(null)}>
      <p className="muted" style={{ margin: 0 }}>
        {ask.reason}
      </p>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={() => close(null)}>
          {t('Hủy', 'Cancel')}
        </button>
        {sites.map((s, i) => (
          <button key={s.code} className="btn btn-primary" onClick={() => close(s.code)} autoFocus={i === 0}>
            {s.name}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export interface LiveProgress {
  downloaded?: number;
  total?: number;
}

/** Data of the UpdateScrapeProcess event: a page of the thread was read. */
export interface PageProgress {
  scrapeId: number;
  page: number;
  currentPage: number;
  totalPages: number;
}
/** Data of the UpdateDownloadImageProcess event. */
export interface ImageProgress {
  scrapeId: number;
  downloaded: number;
  total: number;
}

/** Waiting + processing jobs, kept live by realtime events. `items` is null until the first load. */
export function useScrapeQueue() {
  const [items, setItems] = useState<Scrape[] | null>(null);
  const [live, setLive] = useState<Record<number, LiveProgress>>({});

  // Single-flight: a bulk re-sieve sends one NewScrape per job. A failed load keeps what is shown:
  // an empty list here would claim nothing is queued.
  const load = useMemo(() => singleFlight(() => api.get<Scrape[]>('/scrapes/unprocessed', { quiet: true }).then((r) => setItems(r.data))), []);
  useEffect(load, [load]);
  useEvent([Ev.NewScrape, Ev.FinishScrape, Ev.Reconnected], load);
  useEvent<Scrape>(Ev.UpdateScrape, (m) => {
    setItems((xs) => {
      if (!xs) return xs;
      const s = m.data;
      if (s.status >= ScrapeStatus.Completed || s.isMarkedDeleted) return xs.filter((x) => x.id !== s.id);
      return xs.map((x) => (x.id === s.id ? { ...x, ...s } : x));
    });
  });
  useEvent<PageProgress>(Ev.UpdateScrapeProcess, (m) =>
    setItems((xs) => xs?.map((x) => (x.id === m.data.scrapeId ? { ...x, currentPage: m.data.currentPage, totalPages: m.data.totalPages } : x)) ?? xs),
  );
  useEvent<ImageProgress>(Ev.UpdateDownloadImageProcess, (m) => setLive((l) => ({ ...l, [m.data.scrapeId]: { downloaded: m.data.downloaded, total: m.data.total } })));

  const processing = items?.find((x) => x.status === ScrapeStatus.Processing) ?? null;
  const waiting = items?.filter((x) => x.status === ScrapeStatus.Waiting) ?? [];
  return { items, processing, waiting, live, reload: load };
}

/** Pages scanned / being scanned / left for a running job (for the donut and its legend). */
export function pageSplit(s: Scrape, lp?: LiveProgress) {
  const total = s.totalPages;
  if (lp?.total) return { total, done: total, current: 0, left: 0 };
  const done = Math.min(s.currentPage, total);
  const current = done < total ? 1 : 0;
  return { total, done, current, left: Math.max(0, total - done - current) };
}

export const scrapeTitle = (s: Pick<Scrape, 'threadTitle' | 'threadId'>, t: (vi: string, en: string) => string) =>
  s.threadTitle ?? t(`Bài #${s.threadId}`, `Thread #${s.threadId}`);

/**
 * What a job found out about its thread: still on the forum (true), deleted there (false), or
 * nothing (null). Only a completed job knows; a failed one never got an answer it can vouch for.
 */
export const threadOnForum = (s: Pick<Scrape, 'status' | 'isThreadDeleted'>): boolean | null =>
  s.status === ScrapeStatus.Completed ? !s.isThreadDeleted : null;

/** The job Glean is working on right now: donut, page strip and download bar. */
export function NowSieving({ s, lp }: { s: Scrape; lp?: LiveProgress }) {
  const { t } = useI18n();
  // The queue is one site's: the chosen one.
  const { selected } = useSites();
  const sp = pageSplit(s, lp);
  return (
    <div className="job-now">
      <Donut total={sp.total || 1} done={sp.done} current={sp.current} label={t(`${sp.done} trên ${sp.total} trang đã quét`, `${sp.done} of ${sp.total} pages scanned`)}>
        {sp.total ? `${sp.done}/${sp.total}` : '…'}
      </Donut>
      <div className="job-now-text">
        <Link to={scrapePath(s.id, s.site?.code ?? selected)} className="result-title">
          {scrapeTitle(s, t)}
        </Link>
        <span className="row-meta plain">
          {t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)}
          {s.startedAt && t(` · bắt đầu ${fmtTime(s.startedAt)}`, ` · started ${fmtTime(s.startedAt)}`)}
          {t(` · đã thấy ${fmtNum(s.totalImages)} ảnh`, ` · ${fmtNum(s.totalImages)} images found`)}
        </span>
        {s.totalPages > 0 ? (
          <Mesh total={s.totalPages} done={sp.done} current={new Set(sp.current ? [sp.done + 1] : [])} max={200} label={t(`Trang ${sp.done} / ${sp.total}`, `Page ${sp.done} of ${sp.total}`)} />
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>
            {t('Đang mở trang đầu…', 'Opening the first page…')}
          </span>
        )}
        {lp?.total ? (
          <div className="progress">
            <div>
              <span>{t('Tải ảnh', 'Downloading images')}</span>
              <span className="muted num">
                {fmtNum(lp.downloaded)} / {fmtNum(lp.total)}
              </span>
            </div>
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${(100 * (lp.downloaded ?? 0)) / lp.total}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Sieve input used on the queue page. */
export function SieveForm({ autoFocus }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const create = useCreateScrape();
  const askSite = useAskSite();
  const { selected } = useSites();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try {
      let site: string | undefined;
      if (selected === ALL && /^\d+$/.test(value.trim())) {
        const code = await askSite(t('Số ID cần biết bài thuộc trang nào.', 'A bare ID needs to know which site the thread is on.'));
        if (!code) return;
        site = code;
      }
      await create(value, 'direct', { askNavigate: true, site });
      setValue('');
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="sieve-form">
        <label htmlFor="sieve-input" className="sr-only">
          {t('Link hoặc ID bài viết', 'Thread link or ID')}
        </label>
        <input
          id="sieve-input"
          className="input input-lg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('Dán link bài viết hoặc nhập ID', 'Paste a thread link or type its ID')}
          autoFocus={autoFocus}
          autoComplete="off"
        />
        <button className="btn btn-primary btn-xl" disabled={busy || !value.trim()}>
          {busy ? t('Đang thêm…', 'Adding…') : t('Sàng bài này', 'Sieve thread')}
        </button>
      </div>
      <div className="sieve-hint" role={error ? 'alert' : undefined}>
        {error ? (
          <span style={{ color: 'var(--bad-ink)' }}>{error}</span>
        ) : (
          t(
            'Ví dụ: …/threads/ten-bai-viet.12345/ hoặc 12345. Có thể đưa nhiều bài vào, Glean xử lý lần lượt.',
            'Example: …/threads/thread-title.12345/ or 12345. You can queue several threads; Glean works through them in order.',
          )
        )}
      </div>
    </form>
  );
}
