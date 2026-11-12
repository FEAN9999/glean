import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDuration, fmtNum } from '../lib/format';
import { Empty, PausedNotice, Sentinel, useUi } from '../components/ui';
import { NowSieving, ScrapeStatus, SieveForm, scrapeTitle, useScrapeQueue, type Scrape } from '../components/Scrape';

interface ProxyState {
  enabled: boolean;
  total: number;
  alive: number;
  healthy: boolean;
}
interface Overview {
  threads: number;
  comments: number;
  deletedThreads: number;
  scrapes: number;
  images: number;
  forums: { id: number; name: string; threads: number }[];
}

function useProxyState() {
  const [st, setSt] = useState<ProxyState | null>(null);
  useEffect(() => {
    api.get<ProxyState>('/scrapes/check-proxy', { quiet: true }).then((r) => setSt(r.data)).catch(() => {});
  }, []);
  useEvent(Ev.ProxyStatus, (m) => setSt(m.data));
  return st;
}

export function ProxyNotice() {
  const { t } = useI18n();
  const st = useProxyState();
  if (!st || st.healthy) return null;
  return (
    <div className="notice notice-rust" role="status" style={{ marginBottom: 20 }}>
      {t(
        `Proxy bị gián đoạn, đang kết nối lại… (${st.alive}/${st.total} proxy hoạt động)`,
        `Proxies are down, reconnecting… (${st.alive}/${st.total} working)`,
      )}
    </div>
  );
}

function useOverview() {
  const [ov, setOv] = useState<Overview | null>(null);
  const load = useCallback(() => {
    api.get<Overview>('/systems/overview', { quiet: true }).then((r) => setOv(r.data)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEvent([Ev.FinishScrape, Ev.AutoSyncFinished], load);
  return ov;
}

/* ---------------- Kho: everything sieved so far ---------------- */

function LibraryRow({ s }: { s: Scrape }) {
  const { t } = useI18n();
  const failed = s.status === ScrapeStatus.Failed;
  const sub = s.isThreadDeleted
    ? t('Đã xóa trên diễn đàn · còn bản lưu', 'Deleted on the forum · archived copy kept')
    : failed
      ? `${t('Thất bại', 'Failed')}${s.error ? ` · ${s.error}` : ''}`
      : t(`Bài #${s.threadId}`, `Thread #${s.threadId}`);
  return (
    <Link to={`/sang/${s.id}`} className="gtr lib-row">
      <span className="thumb" aria-hidden="true" />
      <span className="line-text">
        <span className="gt-title">{scrapeTitle(s, t)}</span>
        <span className="line-sub" style={s.isThreadDeleted || failed ? { color: 'var(--bad-ink)' } : undefined}>
          {sub}
        </span>
      </span>
      <span className="r num wide-only">{fmtNum(s.totalPages)}</span>
      <span className="r num">{fmtNum(s.totalImages)}</span>
      <span className="r num wide-only">{fmtNum(s.totalVideos)}</span>
      <span className="r num">{fmtNum(s.totalComments)}</span>
      <span className="muted wide-only" style={{ fontSize: 13 }}>
        {fmtAgo(s.finishedAt ?? s.createdAt)}
      </span>
    </Link>
  );
}

export function SievePage() {
  const { t } = useI18n();
  const ov = useOverview();
  const [retention, setRetention] = useState<number | null>(null);
  const [items, setItems] = useState<Scrape[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async (reset: boolean, cur: number | null) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.get<Scrape[]>(`/scrapes/processed${!reset && cur ? `?cursor=${cur}` : ''}`, { quiet: true });
      setItems((xs) => (reset ? r.data : [...xs, ...r.data]));
      setCursor((r.nextCursor as number) ?? null);
      setDone(!r.nextCursor);
    } catch (e) {
      if ((e as ApiErr).status) setDone(true);
    } finally {
      busy.current = false;
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load(true, null);
    api
      .get('/systems/config', { quiet: true })
      .then((r) => setRetention(r.data?.scraper?.retentionHours ?? null))
      .catch(() => {});
  }, [load]);
  useEvent(Ev.FinishScrape, () => void load(true, null));
  useEvent(Ev.UpdateScrape, (m) => {
    if (m.data?.isMarkedDeleted) setItems((xs) => xs.filter((x) => x.id !== m.data.id));
  });

  const maxForum = Math.max(1, ...(ov?.forums.map((f) => f.threads) ?? [0]));

  return (
    <div className="page">
      <header className="page-head tight">
        <h1 className="page-title">{t('Kho', 'Archive')}</h1>
        {ov && (
          <p className="page-lede">
            {t(
              `${fmtNum(ov.threads)} bài viết · ${fmtNum(ov.comments)} bình luận · ${fmtNum(ov.images)} ảnh đã lưu`,
              `${fmtNum(ov.threads)} threads · ${fmtNum(ov.comments)} comments · ${fmtNum(ov.images)} saved images`,
            )}
          </p>
        )}
      </header>

      <div className="tabs" role="tablist" aria-label={t('Nhóm trong kho', 'Archive views')}>
        <button role="tab" aria-selected="true" className="on">
          {t('Đã sàng', 'Sieved')}
          {ov && <span className="count">{fmtNum(ov.scrapes)}</span>}
        </button>
      </div>

      <div className="cols">
        <section className="col-main gtable-scroll" aria-label={t('Các bài đã sàng', 'Sieved threads')} style={{ paddingTop: 10 }}>
          {loaded && !items.length ? (
            <Empty title={t('Chưa có lượt sàng nào', 'No finished jobs yet')}>
              {t('Dán link bài viết vào ô tìm ở trên, hoặc mở Hàng đợi sàng. Lượt sàng xong sẽ xuất hiện ở đây.', 'Paste a thread link into the box above, or open the sieve queue. Finished jobs show up here.')}
            </Empty>
          ) : (
            <div className="gtable lib-table">
              <div className="gtr lib-row head" aria-hidden="true">
                <span />
                <span>{t('Bài viết', 'Thread')}</span>
                <span className="r wide-only">{t('Trang', 'Pages')}</span>
                <span className="r">{t('Ảnh', 'Images')}</span>
                <span className="r wide-only">Video</span>
                <span className="r">{t('Bình luận', 'Comments')}</span>
                <span className="wide-only">{t('Sàng lúc', 'Sieved')}</span>
              </div>
              {items.map((s) => (
                <LibraryRow key={s.id} s={s} />
              ))}
            </div>
          )}
          <Sentinel onVisible={() => void load(false, cursor)} disabled={done || !loaded} />
        </section>

        <aside className="col-side" style={{ paddingTop: 24, gap: 4 }} aria-labelledby="h-forums">
          <h2 id="h-forums" className="section-title">
            {t('Theo chuyên mục', 'By section')}
          </h2>
          <p className="section-sub" style={{ paddingBottom: 6 }}>
            {t('Số bài viết trong kho', 'Threads in the archive')}
          </p>
          {ov?.forums.map((f) => (
            <div key={f.id} className="forum-stat">
              <div>
                <span style={{ fontWeight: 400 }}>{f.name}</span>
                <span className="muted num" style={{ fontSize: 13 }}>
                  {t(`${fmtNum(f.threads)} bài`, `${fmtNum(f.threads)} threads`)}
                </span>
              </div>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${(100 * f.threads) / maxForum}%` }} />
              </div>
            </div>
          ))}
          {retention != null && (
            <p className="section-sub" style={{ paddingTop: 14 }}>
              {retention > 0
                ? t(`Dữ liệu sàng tự xóa sau ${fmtNum(retention)} giờ. Đổi trong Cài đặt › Sàng.`, `Sieved data is deleted after ${fmtNum(retention)} hours. Change it in Settings › Sieve.`)
                : t('Dữ liệu sàng được giữ mãi. Đổi trong Cài đặt › Sàng.', 'Sieved data is kept forever. Change it in Settings › Sieve.')}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------------- Hàng đợi sàng: feed, running job, waiting list ---------------- */

function useSourceLabel() {
  const { t } = useI18n();
  return (src: string) =>
    ({
      home: t('từ ô tìm', 'from the search box'),
      direct: t('từ Hàng đợi', 'from the queue'),
      'search-post': t('từ Tìm bài viết', 'from thread search'),
      'search-comment': t('từ Tìm bình luận', 'from comment search'),
    })[src] ?? '';
}

export function QueuePage() {
  const { t } = useI18n();
  const { toast } = useUi();
  const sourceLabel = useSourceLabel();
  const { items, processing, waiting, live } = useScrapeQueue();
  const proxy = useProxyState();
  const [recent, setRecent] = useState<Scrape[] | null>(null);
  const [cfg, setCfg] = useState<{ concurrentPages: number; concurrentImageDownloads: number } | null>(null);

  const loadRecent = useCallback(() => {
    api
      .get<Scrape[]>('/scrapes/processed?size=5', { quiet: true })
      .then((r) => setRecent(r.data))
      .catch(() => setRecent([]));
  }, []);
  useEffect(() => {
    loadRecent();
    api
      .get('/systems/config', { quiet: true })
      .then((r) => setCfg(r.data?.scraper ?? null))
      .catch(() => {});
  }, [loadRecent]);
  useEvent(Ev.FinishScrape, loadRecent);

  const drop = async (s: Scrape) => {
    try {
      await api.del(`/scrapes/${s.id}/mark-delete`);
      toast(t('Đã bỏ bài khỏi hàng đợi.', 'Removed from the queue.'));
    } catch {
      /* toast shown by client */
    }
  };

  return (
    <div className="page">
      <header className="page-head tight">
        <h1 className="page-title">{t('Hàng đợi sàng', 'Sieve queue')}</h1>
        <p className="page-lede">
          {t('Glean đi qua từng trang của chủ đề, giữ lại ảnh, video, liên kết và bình luận.', 'Glean walks every page of a thread, keeping images, videos, links and comments.')}
        </p>
      </header>
      <PausedNotice feature="scrape" />
      <ProxyNotice />
      <SieveForm autoFocus />

      <div className="cols pad-top">
        <section className="col-main" aria-labelledby="h-now">
          <h2 id="h-now" className="section-title">
            {t('Đang xử lý', 'Working on')}
          </h2>
          {processing ? (
            <NowSieving s={processing} lp={live[processing.id]} />
          ) : (
            items && (
              <Empty title={t('Không có lượt nào đang chạy', 'Nothing is running')}>
                {t('Dán link bài viết ở trên để bắt đầu sàng.', 'Paste a thread link above to start.')}
              </Empty>
            )
          )}

          <h2 className="section-title" style={{ borderTop: '1px solid var(--line)', paddingTop: 22, paddingBottom: 4 }}>
            {t('Đang chờ', 'Waiting')}
            {waiting.length > 0 && <span className="muted num"> {waiting.length}</span>}
          </h2>
          {items && !waiting.length && <p className="muted" style={{ margin: '8px 0 0' }}>{t('Không có bài nào đang chờ.', 'Nothing is waiting.')}</p>}
          {waiting.map((s, i) => (
            <div key={s.id} className="line">
              <span className="qnum">{i + 1}</span>
              <span className="line-text">
                <Link to={`/sang/${s.id}`} className="line-title" style={{ textDecoration: 'none' }}>
                  {scrapeTitle(s, t)}
                </Link>
                <span className="line-sub">
                  {t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)} · {t('thêm', 'added')} {fmtAgo(s.createdAt)} {sourceLabel(s.source)}
                </span>
              </span>
              <button className="btn-danger" onClick={() => void drop(s)}>
                {t('Bỏ', 'Remove')}
              </button>
            </div>
          ))}
        </section>

        <aside className="col-side" style={{ gap: 4 }}>
          <h2 className="section-title" style={{ paddingBottom: 2 }}>
            {t('Vừa xong', 'Just finished')}
          </h2>
          {recent && !recent.length && <p className="muted" style={{ margin: 0 }}>{t('Chưa có lượt nào xong.', 'Nothing finished yet.')}</p>}
          {recent?.map((s) => (
            <Link key={s.id} to={`/sang/${s.id}`} className="line" style={{ padding: '10px 0' }}>
              <span className="line-text">
                <span className="line-title ellipsis">{scrapeTitle(s, t)}</span>
                <span className="line-sub" style={s.status === ScrapeStatus.Failed ? { color: 'var(--bad-ink)' } : undefined}>
                  {s.status === ScrapeStatus.Failed ? t('Thất bại', 'Failed') : t(`${fmtNum(s.totalImages)} ảnh`, `${fmtNum(s.totalImages)} images`)} · {fmtAgo(s.finishedAt ?? s.createdAt)}
                </span>
              </span>
              <span className="line-value">{fmtDuration(s.handlingSeconds)}</span>
            </Link>
          ))}

          <h2 className="section-title" style={{ padding: '26px 0 2px' }}>
            {t('Kết nối', 'Connection')}
          </h2>
          <div className="kv">
            <span>Proxy</span>
            <span>
              {!proxy
                ? '—'
                : proxy.enabled
                  ? t(`Đang bật · ${proxy.alive}/${proxy.total} hoạt động`, `On · ${proxy.alive}/${proxy.total} working`)
                  : t('Đang tắt', 'Off')}
            </span>
          </div>
          <div className="kv">
            <span>{t('Quét song song', 'In parallel')}</span>
            <span>
              {cfg
                ? t(`${fmtNum(cfg.concurrentPages)} trang · ${fmtNum(cfg.concurrentImageDownloads)} ảnh`, `${fmtNum(cfg.concurrentPages)} pages · ${fmtNum(cfg.concurrentImageDownloads)} images`)
                : '—'}
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
