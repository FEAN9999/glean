import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDate, fmtDuration, fmtNum } from '../lib/format';
import { Empty, Mesh, PausedNotice, Sentinel, useConfirm, useUi } from '../components/ui';
import { ScrapeQueue, ScrapeStatus, SieveForm, useStatusLabel, type Scrape } from '../components/Scrape';

interface ProxyState {
  enabled: boolean;
  total: number;
  alive: number;
  healthy: boolean;
}

export function ProxyNotice() {
  const { t } = useI18n();
  const [st, setSt] = useState<ProxyState | null>(null);
  useEffect(() => {
    api.get<ProxyState>('/scrapes/check-proxy', { quiet: true }).then((r) => setSt(r.data)).catch(() => {});
  }, []);
  useEvent(Ev.ProxyStatus, (m) => setSt(m.data));
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

function ProcessedRow({ s, onChanged }: { s: Scrape; onChanged: () => void }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const label = useStatusLabel();
  const { ask, node } = useConfirm();

  const retry = async () => {
    try {
      await api.post(`/scrapes/${s.id}/retry`);
      toast(t('Đã đưa lại vào hàng đợi.', 'Queued again.'));
      onChanged();
    } catch {
      /* toast shown by client */
    }
  };
  const remove = async () => {
    const yes = await ask(
      t('Xóa lượt sàng này?', 'Delete this sieve job?'),
      t('Ảnh đã tải về của lượt này sẽ bị xóa khỏi máy. Bình luận đã đồng bộ vẫn giữ trong kho.', 'Downloaded images of this job are removed from disk. Synced comments stay in the archive.'),
      t('Xóa lượt sàng', 'Delete job'),
      true,
    );
    if (!yes) return;
    await api.del(`/scrapes/${s.id}/mark-delete`);
    toast(t('Đã xóa lượt sàng.', 'Sieve job deleted.'));
    onChanged();
  };

  return (
    <li className="row">
      <div className="hstack" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Link to={`/sang/${s.id}`} className="row-title" style={{ flex: 1, minWidth: 0 }}>
          {s.threadTitle ?? t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)}
        </Link>
        <div style={{ width: 120, flexShrink: 0 }} aria-hidden="true">
          {s.totalPages > 0 && <Mesh total={s.totalPages} done={s.status === ScrapeStatus.Completed ? s.totalPages : 0} size="sm" max={48} />}
        </div>
      </div>
      <div className="row-meta">
        {s.status === ScrapeStatus.Failed ? (
          <span className="tag tag-rust">{label(s.status)}</span>
        ) : (
          <>
            <span>{t(`${fmtNum(s.totalPages)} trang`, `${fmtNum(s.totalPages)} pages`)}</span>
            <span>{t(`${fmtNum(s.totalImages)} ảnh`, `${fmtNum(s.totalImages)} images`)}</span>
            <span>{t(`${fmtNum(s.totalVideos)} video`, `${fmtNum(s.totalVideos)} videos`)}</span>
            <span>{t(`${fmtNum(s.totalComments)} bình luận`, `${fmtNum(s.totalComments)} comments`)}</span>
            <span>{t(`${fmtNum(s.totalLinks)} liên kết`, `${fmtNum(s.totalLinks)} links`)}</span>
          </>
        )}
        <span>
          {fmtAgo(s.createdAt)}
          {s.handlingSeconds != null && t(`, xử lý ${fmtDuration(s.handlingSeconds)}`, `, took ${fmtDuration(s.handlingSeconds)}`)}
        </span>
        {s.isThreadDeleted && <span className="tag tag-rust">{t('Đã bị xóa trên diễn đàn', 'Deleted on the forum')}</span>}
      </div>
      {s.error && <p className="error-text" style={{ margin: 0 }}>{s.error}</p>}
      {s.expiresAt && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t(`Dữ liệu sẽ bị xóa lúc ${fmtDate(s.expiresAt)}`, `Data will be deleted at ${fmtDate(s.expiresAt)}`)}
        </p>
      )}
      <div className="row-actions">
        <button className="btn btn-sm" onClick={() => void retry()}>
          {t('Sàng lại', 'Sieve again')}
        </button>
        <button className="btn btn-sm btn-ghost btn-danger" onClick={() => void remove()}>
          {t('Xóa', 'Delete')}
        </button>
      </div>
      {node}
    </li>
  );
}

export function SievePage() {
  const { t } = useI18n();
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
  }, [load]);
  useEvent(Ev.FinishScrape, () => void load(true, null));

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Sàng ảnh & video', 'Sieve images & video')}</h1>
        <p className="page-lede">
          {t(
            'Đưa một chủ đề vào, Sàng đi qua từng trang, giữ lại ảnh, video, liên kết và bình luận có giá trị. Ảnh được tải về máy nên vẫn xem được khi bài gốc bị xóa.',
            'Feed in a thread and Sàng walks every page, keeping images, videos, links and worthwhile comments. Images are stored locally, so they survive if the thread is deleted.',
          )}
        </p>
      </header>
      <PausedNotice feature="scrape" />
      <ProxyNotice />
      <SieveForm autoFocus />

      <section className="section" aria-labelledby="h-q" style={{ marginTop: 40 }}>
        <h2 id="h-q" className="section-title">
          {t('Hàng đợi', 'Queue')}
        </h2>
        <ScrapeQueue />
      </section>

      <section className="section" aria-labelledby="h-p">
        <h2 id="h-p" className="section-title">
          {t('Đã sàng', 'Sieved')}
        </h2>
        {loaded && !items.length && <Empty title={t('Chưa có lượt sàng nào', 'No finished jobs yet')}>{t('Lượt sàng xong sẽ xuất hiện ở đây.', 'Finished jobs show up here.')}</Empty>}
        <ul className="rows">
          {items.map((s) => (
            <ProcessedRow key={s.id} s={s} onChanged={() => void load(true, null)} />
          ))}
        </ul>
        <Sentinel onVisible={() => void load(false, cursor)} disabled={done || !loaded} />
      </section>
    </div>
  );
}
