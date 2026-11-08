import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtNum } from '../lib/format';
import { Empty, Mesh, useUi } from './ui';

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
                `Link dùng tên miền cũ ${domainWarning.host}. Diễn đàn đã chuyển sang ${domainWarning.currentHost}; Sàng tự đổi sang tên miền mới.`,
                `The link uses the old domain ${domainWarning.host}. The forum moved to ${domainWarning.currentHost}; Sàng uses the new one.`,
              )
            : t(
                `Link thuộc ${domainWarning.host}, khác nguồn đang cấu hình (${domainWarning.currentHost}). Sàng dùng ID bài với nguồn hiện tại.`,
                `The link belongs to ${domainWarning.host}, not the configured source (${domainWarning.currentHost}). Sàng uses the thread ID with the current source.`,
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

interface LiveProgress {
  downloaded?: number;
  total?: number;
}

/** Live queue of waiting + processing jobs with page mesh and download progress. */
export function ScrapeQueue({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const label = useStatusLabel();
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

  if (!items) return null;
  if (!items.length)
    return compact ? (
      <p className="muted" style={{ margin: 0 }}>
        {t('Hàng đợi trống.', 'The queue is empty.')}
      </p>
    ) : (
      <Empty title={t('Hàng đợi trống', 'Nothing queued')}>
        {t('Dán link bài viết ở trên để bắt đầu sàng. Có thể đưa nhiều bài vào cùng lúc, Sàng xử lý lần lượt.', 'Paste a thread link above to start. You can queue several threads; Sàng works through them in order.')}
      </Empty>
    );

  const waiting = items.filter((x) => x.status === ScrapeStatus.Waiting);
  return (
    <ul className="rows">
      {items.map((s) => {
        const lp = live[s.id];
        const pos = s.status === ScrapeStatus.Waiting ? waiting.findIndex((w) => w.id === s.id) + 1 : 0;
        return (
          <li key={s.id} className="row">
            <div className="hstack" style={{ justifyContent: 'space-between' }}>
              <Link to={`/sang/${s.id}`} className="row-title">
                {s.threadTitle ?? t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)}
              </Link>
              <span className={`tag ${s.status === ScrapeStatus.Processing ? 'tag-straw' : ''}`}>{label(s.status)}</span>
            </div>
            {s.status === ScrapeStatus.Waiting ? (
              <div className="row-meta">
                <span>{t(`Thứ tự ${pos} / ${waiting.length} đang chờ`, `Position ${pos} of ${waiting.length} queued`)}</span>
                <span>{t('Thêm', 'Added')} {fmtAgo(s.createdAt)}</span>
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {s.totalPages > 0 && !(lp && lp.total) && (
                  <>
                    <Mesh total={s.totalPages} done={s.currentPage} current={new Set([s.currentPage + 1])} size={compact ? 'sm' : 'md'} max={compact ? 60 : 200} />
                    <span className="row-meta">
                      {t(`Quét trang ${s.currentPage}/${s.totalPages}`, `Scanned page ${s.currentPage} of ${s.totalPages}`)}
                    </span>
                  </>
                )}
                {lp?.total ? (
                  <>
                    <div className="bar" aria-hidden="true">
                      <span style={{ width: `${(100 * (lp.downloaded ?? 0)) / lp.total}%` }} />
                    </div>
                    <span className="row-meta">
                      {t(`Tải ảnh ${fmtNum(lp.downloaded)}/${fmtNum(lp.total)}`, `Downloading image ${fmtNum(lp.downloaded)} of ${fmtNum(lp.total)}`)}
                    </span>
                  </>
                ) : null}
                {s.totalPages === 0 && <span className="row-meta">{t('Đang mở trang đầu…', 'Opening the first page…')}</span>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Sieve input used on the sieve page. */
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
      <div className="sieve-box">
        <label htmlFor="sieve-input" className="sr-only">
          {t('Link hoặc ID bài viết', 'Thread link or ID')}
        </label>
        <input
          id="sieve-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('Dán link bài viết hoặc nhập ID', 'Paste a thread link or type its ID')}
          autoFocus={autoFocus}
          autoComplete="off"
        />
        <button className="btn btn-primary" disabled={busy || !value.trim()}>
          {busy ? t('Đang thêm…', 'Adding…') : t('Sàng bài này', 'Sieve thread')}
        </button>
      </div>
      <div className="sieve-hint" role={error ? 'alert' : undefined}>
        {error ? <span style={{ color: 'var(--rust)' }}>{error}</span> : t('Ví dụ: …/threads/ten-bai-viet.12345/ hoặc 12345', 'Example: …/threads/thread-title.12345/ or 12345')}
      </div>
    </form>
  );
}
