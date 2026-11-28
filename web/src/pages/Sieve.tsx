import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { unpack, useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtDuration, fmtNum } from '../lib/format';
import { Empty, PausedNotice, Sentinel, useConfirm, useUi } from '../components/ui';
import { NowSieving, ScrapeStatus, SieveForm, scrapePath, scrapeTitle, useScrapeQueue, type Scrape } from '../components/Scrape';
import { ALL, SiteTag, useSites } from '../lib/site';
import type { AppConfig } from '../../../server/config';

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
  useEvent<ProxyState>(Ev.ProxyStatus, (m) => setSt(m.data));
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

/** The chosen site's overview; `on` false (every site at once) asks nothing, as the overview is one site's. */
function useOverview(on: boolean) {
  const [ov, setOv] = useState<Overview | null>(null);
  const load = useCallback(() => {
    if (!on) return;
    api.get<Overview>('/systems/overview', { quiet: true }).then((r) => setOv(r.data)).catch(() => {});
  }, [on]);
  useEffect(load, [load]);
  useEvent([Ev.FinishScrape, Ev.AutoSyncFinished, Ev.Reconnected], load);
  return ov;
}

/* ---------------- Kho: everything sieved so far ---------------- */

/** A row of the archive: each names its site, since job ids repeat across sites. */
type ArchiveRow = Scrape & { site: { code: string; name: string } };

/** A copy of `set` with `ids` added (`on`) or removed. */
export function withIds<T>(set: ReadonlySet<T>, ids: T[], on: boolean): Set<T> {
  const next = new Set(set);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** What a chosen row is remembered by: its site and its id. */
export const pickKey = (s: { id: number; site: { code: string } }) => `${s.site.code}:${s.id}`;

/** The chosen rows' ids by site, in the order chosen: each site's request gets only its own ids. */
export function groupPicks(keys: Iterable<string>): Record<string, number[]> {
  const bySite: Record<string, number[]> = {};
  for (const key of keys) {
    const at = key.lastIndexOf(':');
    (bySite[key.slice(0, at)] ??= []).push(Number(key.slice(at + 1)));
  }
  return bySite;
}

const siteOfPick = (key: string) => key.slice(0, key.lastIndexOf(':'));

function LibraryRow({ s, merged }: { s: ArchiveRow; merged: boolean }) {
  const { t, lang } = useI18n();
  const failed = s.status === ScrapeStatus.Failed;
  const sub = s.isThreadDeleted
    ? t('Đã xóa trên diễn đàn · còn bản lưu', 'Deleted on the forum · archived copy kept')
    : failed
      ? `${t('Thất bại', 'Failed')}${s.error ? ` · ${unpack(s.error, lang)}` : ''}`
      : t(`Bài #${s.threadId}`, `Thread #${s.threadId}`);
  return (
    <Link to={scrapePath(s.id, s.site.code)} className="gtr lib-row">
      <span className="thumb" aria-hidden="true" />
      <span className="line-text">
        <span className="gt-title">{scrapeTitle(s, t)}</span>
        <span className="line-sub" style={s.isThreadDeleted || failed ? { color: 'var(--bad-ink)' } : undefined}>
          {merged && (
            <>
              <SiteTag code={s.site.code} />{' '}
            </>
          )}
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
  const { toast } = useUi();
  const { ask, node } = useConfirm();
  const navigate = useNavigate();
  const { selected, nameOf } = useSites();
  // Every site at once: the overview, the sections and the retention are each one site's, so they are not shown.
  const merged = selected === ALL;
  const ov = useOverview(!merged);
  const [retention, setRetention] = useState<number | null>(null);
  const [items, setItems] = useState<ArchiveRow[]>([]);
  // Finished jobs of each site listed, from the list's last answer.
  const [bySite, setBySite] = useState<Record<string, number> | null>(null);
  const total = bySite ? Object.values(bySite).reduce((n, x) => n + x, 0) : null;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  // One site: the last row's id. Every site: the opaque cursor the last page returned, sent back as it is.
  const [cursor, setCursor] = useState<number | string | null>(null);
  const [done, setDone] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const reloadAfter = useRef(false);

  const load = useCallback(async (reset: boolean, cur: number | string | null) => {
    if (busy.current) {
      // A job finished while a page was loading: reload from the top once that load is done.
      if (reset) reloadAfter.current = true;
      return;
    }
    busy.current = true;
    let next: { top: boolean; cur: number | string | null } | null = { top: reset, cur };
    while (next) {
      const { top, cur: from } = next;
      next = null;
      try {
        const r = await api.get<ArchiveRow[]>(`/scrapes/processed${!top && from ? `?cursor=${encodeURIComponent(from)}` : ''}`, { quiet: true });
        setItems((xs) => (top ? r.data : [...xs, ...r.data]));
        setCursor((r.nextCursor as number | string | null) ?? null);
        if (r.totalBySite) setBySite(r.totalBySite as Record<string, number>);
        setDone(!r.nextCursor);
        setError(null);
      } catch (e) {
        setError((e as ApiErr).message);
        if ((e as ApiErr).status) setDone(true);
      }
      setLoaded(true);
      if (reloadAfter.current) {
        reloadAfter.current = false;
        next = { top: true, cur: null };
      }
    }
    busy.current = false;
  }, []);

  useEffect(() => {
    void load(true, null);
    if (merged) return;
    api
      .get<AppConfig>('/systems/config', { quiet: true })
      .then((r) => setRetention(r.data?.scraper?.retentionHours ?? null))
      .catch(() => {});
  }, [load, merged]);
  useEvent([Ev.FinishScrape, Ev.Reconnected], () => void load(true, null));
  useEvent<Scrape>(Ev.UpdateScrape, (m) => {
    if (!m.data?.isMarkedDeleted) return;
    const key = pickKey({ id: m.data.id, site: { code: m.site ?? selected } });
    setItems((xs) => xs.filter((x) => pickKey(x) !== key));
    setPicked((xs) => (xs.has(key) ? withIds(xs, [key], false) : xs));
  });

  const maxForum = Math.max(1, ...(ov?.forums.map((f) => f.threads) ?? [0]));
  // Picks outlive a reload of the list (each finished job reloads it from the top), so a pick further
  // down is still sent. A pick that no longer qualifies is skipped by the server and counted.
  const shownChosen = items.filter((s) => picked.has(pickKey(s))).length;
  const allShownChosen = items.length > 0 && shownChosen === items.length;
  const pick = (key: string, on: boolean) => setPicked((xs) => withIds(xs, [key], on));

  /** Re-sieving is one site's request: one per site, summed up in one toast. */
  const requeue = async (jobs: { site: string; sel: { ids: number[] } | { all: true } }[]) => {
    setSending(true);
    // Quiet: the toast below names a site that failed, next to what the others queued.
    const answers = await Promise.allSettled(
      jobs.map((j) => api.post<{ queued: number; skipped: number }>('/scrapes/retry-many', j.sel, { quiet: true, site: j.site })),
    );
    let queued = 0;
    let skipped = 0;
    const sent = new Set<string>();
    let failedNote = '';
    answers.forEach((a, i) => {
      const site = jobs[i].site;
      if (a.status === 'fulfilled') {
        queued += a.value.data.queued;
        skipped += a.value.data.skipped;
        sent.add(site);
      } else {
        const why = (a.reason as ApiErr).message;
        failedNote += t(` Không sàng lại được ở ${nameOf(site)}: ${why}`, ` Could not sieve again on ${nameOf(site)}: ${why}`);
      }
    });
    const skippedNote = skipped ? t(` Bỏ qua ${fmtNum(skipped)} bài đang chờ hoặc đã xóa.`, ` Skipped ${fmtNum(skipped)} queued or deleted.`) : '';
    const lead = queued
      ? t(`Đã đưa ${fmtNum(queued)} bài vào hàng đợi sàng.`, `Queued ${fmtNum(queued)} threads to sieve again.`)
      : failedNote
        ? ''
        : t('Không có bài nào được đưa vào hàng đợi.', 'Nothing was queued.');
    toast(
      (lead + skippedNote + failedNote).trim(),
      failedNote ? 'error' : 'info',
      queued ? { label: t('Xem hàng đợi', 'View queue'), run: () => navigate('/hang-doi') } : undefined,
    );
    // A site that failed keeps its picks, to try again.
    setPicked((xs) => new Set([...xs].filter((key) => !sent.has(siteOfPick(key)))));
    if (sent.size) void load(true, null);
    setSending(false);
  };
  const requeueAll = async () => {
    // Count afresh: jobs may have been deleted or queued since the list loaded.
    let fresh = bySite ?? {};
    try {
      const r = await api.get<ArchiveRow[]>('/scrapes/processed?size=1', { quiet: true });
      if (r.totalBySite) setBySite((fresh = r.totalBySite as Record<string, number>));
    } catch {
      /* keep the counts shown */
    }
    const counts = Object.entries(fresh).filter(([, x]) => x > 0);
    const sum = counts.reduce((n, [, x]) => n + x, 0);
    if (!sum) return;
    const n = fmtNum(sum);
    // Every site at once: say how many of each site's threads go, before anything is sent.
    const each = merged ? counts.map(([code, x]) => t(`${nameOf(code)} ${fmtNum(x)} bài`, `${nameOf(code)} ${fmtNum(x)} threads`)).join(' · ') + '. ' : '';
    const yes = await ask(
      t(`Sàng lại toàn bộ ${n} bài?`, `Sieve all ${n} threads again?`),
      each +
        t(
          'Mỗi bài đọc lại mọi trang của chủ đề nên có thể mất lâu. Những gì đã lưu được giữ nguyên.',
          'Each thread is read again page by page, which can take a while. What was saved is kept.',
        ),
      t('Sàng lại tất cả', 'Sieve all again'),
    );
    if (yes) await requeue(counts.map(([site]) => ({ site, sel: { all: true } })));
  };
  const requeuePicked = () => requeue(Object.entries(groupPicks(picked)).map(([site, ids]) => ({ site, sel: { ids } })));
  const archiveCount = merged ? total : ov?.scrapes;

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

      <div className="tabs-bar">
        <div className="tabs" role="tablist" aria-label={t('Nhóm trong kho', 'Archive views')}>
          <button role="tab" aria-selected="true" className="on">
            {t('Đã sàng', 'Sieved')}
            {archiveCount != null && <span className="count">{fmtNum(archiveCount)}</span>}
          </button>
        </div>
        {!!total && (
          <button className="btn btn-sm" disabled={sending} onClick={() => void requeueAll()}>
            {t('Sàng lại tất cả', 'Sieve all again')}
          </button>
        )}
      </div>

      {/* Every site at once has no side column: the list takes the whole width. */}
      <div className={merged ? undefined : 'cols'}>
        <section className="col-main gtable-scroll" aria-label={t('Các bài đã sàng', 'Sieved threads')} style={{ paddingTop: 10 }}>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {loaded && !items.length ? (
            !error && <Empty title={t('Chưa có lượt sàng nào', 'No finished jobs yet')}>
              {t('Dán link bài viết vào ô tìm ở trên, hoặc mở Hàng đợi sàng. Lượt sàng xong sẽ xuất hiện ở đây.', 'Paste a thread link into the box above, or open the sieve queue. Finished jobs show up here.')}
            </Empty>
          ) : (
            <div className="gtable lib-table">
              <div className="lib-line head">
                <label className="lib-pick">
                  <input
                    type="checkbox"
                    className="cb"
                    aria-label={t('Chọn hết các bài đang hiện', 'Choose every thread shown')}
                    checked={allShownChosen}
                    disabled={sending}
                    ref={(el) => {
                      if (el) el.indeterminate = shownChosen > 0 && !allShownChosen;
                    }}
                    onChange={(e) => setPicked((xs) => withIds(xs, items.map(pickKey), e.target.checked))}
                  />
                </label>
                <div className="gtr lib-row head" aria-hidden="true">
                  <span />
                  <span>{t('Bài viết', 'Thread')}</span>
                  <span className="r wide-only">{t('Trang', 'Pages')}</span>
                  <span className="r">{t('Ảnh', 'Images')}</span>
                  <span className="r wide-only">Video</span>
                  <span className="r">{t('Bình luận', 'Comments')}</span>
                  <span className="wide-only">{t('Sàng lúc', 'Sieved')}</span>
                </div>
              </div>
              {items.map((s) => (
                <div key={pickKey(s)} className="lib-line">
                  <label className="lib-pick">
                    <input
                      type="checkbox"
                      className="cb"
                      aria-label={scrapeTitle(s, t)}
                      checked={picked.has(pickKey(s))}
                      disabled={sending}
                      onChange={(e) => pick(pickKey(s), e.target.checked)}
                    />
                  </label>
                  <LibraryRow s={s} merged={merged} />
                </div>
              ))}
            </div>
          )}
          <Sentinel onVisible={() => void load(false, cursor)} disabled={done || !loaded} />
        </section>

        {!merged && (
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
        )}
      </div>
      {picked.size > 0 && (
        <div className="savebar" role="region" aria-label={t('Các bài đã chọn', 'Chosen threads')}>
          <span>{t(`Đã chọn ${fmtNum(picked.size)} bài`, `${fmtNum(picked.size)} chosen`)}</span>
          <button className="btn btn-primary" disabled={sending} onClick={() => void requeuePicked()}>
            {t('Sàng lại', 'Sieve again')}
          </button>
          <button className="btn btn-ghost" disabled={sending} onClick={() => setPicked(new Set())}>
            {t('Bỏ chọn', 'Clear')}
          </button>
        </div>
      )}
      {node}
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
  // The queue is one site's: the chosen one.
  const { selected } = useSites();
  const { items, processing, waiting, live } = useScrapeQueue();
  const proxy = useProxyState();
  const [recent, setRecent] = useState<Scrape[] | null>(null);
  const [cfg, setCfg] = useState<{ concurrentPages: number; concurrentImageDownloads: number } | null>(null);

  const loadRecent = useCallback(() => {
    api
      .get<Scrape[]>('/scrapes/processed?size=5', { quiet: true })
      .then((r) => setRecent(r.data))
      // Keep what is shown: an empty list here would claim nothing has finished.
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadRecent();
    api
      .get<AppConfig>('/systems/config', { quiet: true })
      .then((r) => setCfg(r.data?.scraper ?? null))
      .catch(() => {});
  }, [loadRecent]);
  useEvent([Ev.FinishScrape, Ev.Reconnected], loadRecent);

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
                <Link to={scrapePath(s.id, s.site?.code ?? selected)} className="line-title" style={{ textDecoration: 'none' }}>
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
            <Link key={s.id} to={scrapePath(s.id, s.site?.code ?? selected)} className="line" style={{ padding: '10px 0' }}>
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
