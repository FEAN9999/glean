import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtNum, fmtTime } from '../lib/format';
import { Donut, Mesh, useUi } from './ui';

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
}

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

/** Creates a sieve job; handles the domain-change warning. Returns the job id. */
export function useCreateScrape() {
  const { t } = useI18n();
  const { toast } = useUi();
  const navigate = useNavigate();
  return useCallback(
    async (input: string, source: string, opts: { navigate?: boolean; askNavigate?: boolean } = {}) => {
      const r = await api.post<{ scrape: Scrape; reused: boolean; domainWarning: null | { host: string; knownOldDomain: boolean; currentHost: string } }>(
        '/scrapes/create-scrape',
        { url: input, source },
        { quiet: true },
      );
      const { scrape, reused, domainWarning } = r.data;
      if (domainWarning) {
        toast(
          domainWarning.knownOldDomain
            ? t(
                `Link dùng tên miền cũ ${domainWarning.host}. Diễn đàn đã chuyển sang ${domainWarning.currentHost}; Glean tự đổi sang tên miền mới.`,
                `The link uses the old domain ${domainWarning.host}. The forum moved to ${domainWarning.currentHost}; Glean uses the new one.`,
              )
            : t(
                `Link thuộc ${domainWarning.host}, khác nguồn đang cấu hình (${domainWarning.currentHost}). Glean dùng ID bài với nguồn hiện tại.`,
                `The link belongs to ${domainWarning.host}, not the configured source (${domainWarning.currentHost}). Glean uses the thread ID with the current source.`,
              ),
        );
      }
      if (opts.navigate) navigate(`/sang/${scrape.id}`);
      else if (opts.askNavigate)
        toast(
          reused ? t('Bài này đã có trong hàng đợi.', 'This thread is already queued.') : t('Đã đưa bài vào hàng đợi sàng.', 'Thread added to the sieve queue.'),
          'info',
          { label: t('Xem tiến trình', 'View progress'), run: () => navigate(`/sang/${scrape.id}`) },
        );
      return scrape;
    },
    [navigate, t, toast],
  );
}

export interface LiveProgress {
  downloaded?: number;
  total?: number;
}

/** Waiting + processing jobs, kept live by realtime events. `items` is null until the first load. */
export function useScrapeQueue() {
  const [items, setItems] = useState<Scrape[] | null>(null);
  const [live, setLive] = useState<Record<number, LiveProgress>>({});

  const load = useCallback(() => {
    api
      .get<Scrape[]>('/scrapes/unprocessed', { quiet: true })
      .then((r) => setItems(r.data))
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  useEvent([Ev.NewScrape, Ev.FinishScrape], load);
  useEvent(Ev.UpdateScrape, (m) => {
    setItems((xs) => {
      if (!xs) return xs;
      const s = m.data as Scrape;
      if (s.status >= ScrapeStatus.Completed || s.isMarkedDeleted) return xs.filter((x) => x.id !== s.id);
      return xs.map((x) => (x.id === s.id ? { ...x, ...s } : x));
    });
  });
  useEvent(Ev.UpdateScrapeProcess, (m) =>
    setItems((xs) => xs?.map((x) => (x.id === m.data.scrapeId ? { ...x, currentPage: m.data.currentPage, totalPages: m.data.totalPages } : x)) ?? xs),
  );
  useEvent(Ev.UpdateDownloadImageProcess, (m) => setLive((l) => ({ ...l, [m.data.scrapeId]: { downloaded: m.data.downloaded, total: m.data.total } })));

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

/** The job Glean is working on right now: donut, page strip and download bar. */
export function NowSieving({ s, lp }: { s: Scrape; lp?: LiveProgress }) {
  const { t } = useI18n();
  const sp = pageSplit(s, lp);
  return (
    <div className="job-now">
      <Donut total={sp.total || 1} done={sp.done} current={sp.current} label={t(`${sp.done} trên ${sp.total} trang đã quét`, `${sp.done} of ${sp.total} pages scanned`)}>
        {sp.total ? `${sp.done}/${sp.total}` : '…'}
      </Donut>
      <div className="job-now-text">
        <Link to={`/sang/${s.id}`} className="result-title">
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
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try {
      await create(value, 'direct', { askNavigate: true });
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
