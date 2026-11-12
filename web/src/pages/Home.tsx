import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtNum } from '../lib/format';
import { Donut, Empty, Status } from '../components/ui';
import { pageSplit, scrapeTitle, useScrapeQueue, type Scrape } from '../components/Scrape';

interface Overview {
  threads: number;
  comments: number;
  deletedThreads: number;
  scrapes: number;
  images: number;
  forums: { id: number; name: string; threads: number }[];
}
interface AutoState {
  at: string | null;
  error: string | null;
  running: boolean;
  enabled: boolean;
  intervalMs: number;
}
interface AutoStatus {
  posts: AutoState;
  comments: AutoState;
}
interface Recent {
  id: number;
  keyword: string;
  resultCount: number;
  createdAt: string;
}

/** Left of the top row: how much is in the archive and how auto-sync is doing. */
function Intake({ ov, auto }: { ov: Overview | null; auto: AutoStatus | null }) {
  const { t } = useI18n();
  const row = (k: 'posts' | 'comments') => {
    const a = auto?.[k];
    const name = k === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments');
    if (!a) return null;
    const every = Math.round(a.intervalMs / 60000);
    const [tone, text] = a.running
      ? (['acc', t('đang đồng bộ…', 'syncing…')] as const)
      : !a.enabled
        ? (['off', t('tự động đồng bộ đang tắt', 'auto-sync is off')] as const)
        : a.error
          ? (['bad', t('lần gần nhất lỗi', 'last run failed')] as const)
          : a.at
            ? (['ok', t(`đồng bộ ${fmtAgo(a.at)} · mỗi ${every} phút`, `synced ${fmtAgo(a.at)} · every ${every} min`)] as const)
            : (['off', t('chưa đồng bộ lần nào', 'never synced')] as const);
    return (
      <div className="kv" key={k}>
        <span>{name}</span>
        <Status tone={tone}>{text}</Status>
      </div>
    );
  };
  return (
    <section aria-labelledby="h-intake">
      <div className="section-head">
        <h2 id="h-intake" className="section-title">
          {t('Nạp vào kho', 'Intake')}
        </h2>
        <Link to="/nhat-ky/bai-viet" className="btn">
          {t('Xem nhật ký', 'View log')}
        </Link>
      </div>
      <span className="big-num">{ov ? t(`${fmtNum(ov.threads)} bài viết`, `${fmtNum(ov.threads)} threads`) : ' '}</span>
      <span className="muted" style={{ fontSize: 13 }}>
        {ov ? t(`và ${fmtNum(ov.comments)} bình luận đã đồng bộ về kho`, `and ${fmtNum(ov.comments)} comments synced into the archive`) : ''}
      </span>
      <span className="muted" style={{ paddingTop: 14 }}>
        {t('Đồng bộ tự động', 'Auto-sync')}
      </span>
      <div>
        {row('posts')}
        {row('comments')}
      </div>
    </section>
  );
}

/** Right of the top row: the job being sieved, as a donut of its pages. */
function Sieving() {
  const { t } = useI18n();
  const { items, processing: s, waiting, live } = useScrapeQueue();
  const lp = s ? live[s.id] : undefined;
  return (
    <section aria-labelledby="h-sieving">
      <div className="section-head">
        <h2 id="h-sieving" className="section-title">
          {t('Đang sàng', 'Sieving')}
        </h2>
        <Link to="/hang-doi" className="btn">
          {t('Xem hàng đợi', 'View queue')}
        </Link>
      </div>
      {items && !s && (
        <Empty title={t('Không có lượt nào đang chạy', 'Nothing is running')}>
          {waiting.length
            ? t(`${waiting.length} bài đang chờ đến lượt.`, `${waiting.length} threads waiting their turn.`)
            : t('Dán link bài viết vào ô tìm ở trên để sàng ảnh, video và bình luận.', 'Paste a thread link into the box above to sieve its images, videos and comments.')}
        </Empty>
      )}
      {s && <SievingNow s={s} downloaded={lp?.downloaded} downloadTotal={lp?.total} />}
      {s && waiting[0] && (
        <span className="muted" style={{ fontSize: 13, paddingTop: 8 }}>
          {t('Đang chờ:', 'Next:')} {scrapeTitle(waiting[0], t)}
          {waiting.length > 1 && t(` và ${waiting.length - 1} bài khác`, ` and ${waiting.length - 1} more`)}
        </span>
      )}
    </section>
  );
}

function SievingNow({ s, downloaded, downloadTotal }: { s: Scrape; downloaded?: number; downloadTotal?: number }) {
  const { t } = useI18n();
  const sp = pageSplit(s, downloadTotal ? { downloaded, total: downloadTotal } : undefined);
  return (
    <>
      <Link to={`/sang/${s.id}`} className="muted ellipsis" style={{ textDecoration: 'none' }}>
        {scrapeTitle(s, t)}
      </Link>
      <div className="sieve-viz">
        <Donut size="lg" total={sp.total || 1} done={sp.done} current={sp.current} label={t(`${sp.done} trên ${sp.total} trang đã quét`, `${sp.done} of ${sp.total} pages scanned`)} />
        <div className="tooltip" aria-hidden="true">
          {downloadTotal ? (
            <>
              <span className="tt-head">{t('Đang tải ảnh', 'Downloading')}</span>
              <span className="tt-sub">{t(`${fmtNum(downloaded)} trên ${fmtNum(downloadTotal)}`, `${fmtNum(downloaded)} of ${fmtNum(downloadTotal)}`)}</span>
            </>
          ) : (
            <>
              <span className="tt-head">{t('Đang quét', 'Scanning')}</span>
              <span className="tt-sub">
                {sp.total ? t(`trang ${Math.min(sp.done + 1, sp.total)} trên ${sp.total}`, `page ${Math.min(sp.done + 1, sp.total)} of ${sp.total}`) : t('đang mở trang đầu', 'opening page 1')}
              </span>
            </>
          )}
          <span className="tt-big">{t(`${fmtNum(s.totalImages)} ảnh`, `${fmtNum(s.totalImages)} images`)}</span>
        </div>
      </div>
      <div className="legend" style={{ paddingTop: 6 }}>
        <span>
          <span className="dot dot-acc" />
          {t(`Đã quét ${sp.done}`, `Scanned ${sp.done}`)}
        </span>
        <span>
          <span className="dot dot-acc2" />
          {t(`Đang quét ${sp.current}`, `Scanning ${sp.current}`)}
        </span>
        <span>
          <span className="dot dot-acc3" />
          {t(`Còn lại ${sp.left}`, `Left ${sp.left}`)}
        </span>
      </div>
    </>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const [ov, setOv] = useState<Overview | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [saved, setSaved] = useState<Scrape[] | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [recentC, setRecentC] = useState<Recent[]>([]);

  const load = useCallback(() => {
    api.get<Overview>('/systems/overview', { quiet: true }).then((r) => setOv(r.data)).catch(() => {});
    api.get<AutoStatus>('/sync/auto-status', { quiet: true }).then((r) => setAuto(r.data)).catch(() => {});
  }, []);
  const loadSaved = useCallback(() => {
    api
      .get<Scrape[]>('/scrapes/processed?size=3', { quiet: true })
      .then((r) => setSaved(r.data))
      .catch(() => setSaved([]));
  }, []);
  useEffect(() => {
    load();
    loadSaved();
    api.get<Recent[]>('/posts/search/recent-keywords', { quiet: true }).then((r) => setRecent(r.data.slice(0, 4))).catch(() => {});
    api.get<Recent[]>('/comments/recent-keywords', { quiet: true }).then((r) => setRecentC(r.data.slice(0, 4))).catch(() => {});
  }, [load, loadSaved]);
  useEvent([Ev.AutoSyncFinished, Ev.FinishScrape, Ev.ManualSyncComplete], load);
  useEvent(Ev.FinishScrape, loadSaved);
  useEvent(Ev.NewSearch, (m) => setRecent((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 4)));
  useEvent(Ev.NewCommentSearch, (m) => setRecentC((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 4)));

  const searches = [
    ...recent.map((r) => ({ ...r, kind: 'posts' as const })),
    ...recentC.map((r) => ({ ...r, kind: 'comments' as const })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Bàn làm việc', 'Desk')}</h1>
      </header>

      <div className="desk-top">
        <Intake ov={ov} auto={auto} />
        <Sieving />
      </div>

      <div className="cols-3">
        <section aria-labelledby="h-store" className="stack" style={{ gap: 4 }}>
          <h2 id="h-store" className="section-title">
            {t('Trong kho', 'In the archive')}
          </h2>
          <p className="section-sub">
            {ov && ov.deletedThreads > 0
              ? t(`${fmtNum(ov.deletedThreads)} bài đã bị xóa trên diễn đàn vẫn còn bản lưu`, `${fmtNum(ov.deletedThreads)} threads deleted on the forum are still kept here`)
              : t('Mọi thứ Glean đã đồng bộ và sàng về máy', 'Everything Glean has synced and sieved')}
          </p>
          {ov && (
            <div className="bubbles">
              <div className="bubble bubble-c">
                {fmtNum(ov.comments)}
                <small>{t('bình luận', 'comments')}</small>
              </div>
              <div className="bubble bubble-i">
                {fmtNum(ov.images)}
                <small>{t('ảnh đã lưu', 'saved images')}</small>
              </div>
              <div className="bubble bubble-t">
                {fmtNum(ov.threads)}
                <small>{t('bài viết', 'threads')}</small>
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="h-saved" className="stack" style={{ gap: 4 }}>
          <h2 id="h-saved" className="section-title">
            {t('Vừa lưu vào kho', 'Just saved')}
          </h2>
          <p className="section-sub" style={{ paddingBottom: 8 }}>
            {t('Bài đã sàng gần đây nhất', 'The most recently sieved threads')}
          </p>
          {saved && !saved.length && <p className="muted" style={{ margin: 0 }}>{t('Chưa có lượt sàng nào.', 'No sieve jobs yet.')}</p>}
          {saved?.map((s) => (
            <Link key={s.id} to={`/sang/${s.id}`} className="line">
              <span className="thumb" aria-hidden="true" />
              <span className="line-text">
                <span className="line-title ellipsis">{scrapeTitle(s, t)}</span>
                <span className="line-sub ellipsis">
                  {t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)} · {fmtAgo(s.finishedAt ?? s.createdAt)}
                </span>
              </span>
              <span className="line-value">{t(`${fmtNum(s.totalImages)} ảnh`, `${fmtNum(s.totalImages)} images`)}</span>
            </Link>
          ))}
        </section>

        <section aria-labelledby="h-recent" className="stack" style={{ gap: 4 }}>
          <h2 id="h-recent" className="section-title" style={{ paddingBottom: 4 }}>
            {t('Vừa tìm', 'Recent searches')}
          </h2>
          {!searches.length && <p className="muted" style={{ margin: 0 }}>{t('Chưa có lượt tìm nào.', 'No searches yet.')}</p>}
          {searches.map((r) => (
            <Link key={`${r.kind}${r.id}`} to={`/${r.kind === 'posts' ? 'bai-viet' : 'binh-luan'}/tu-khoa?q=${encodeURIComponent(r.keyword)}`} className="line">
              <span className="line-text">
                <span className="line-title ellipsis">{r.keyword}</span>
                <span className="line-sub">
                  {r.kind === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')} · {fmtAgo(r.createdAt)}
                </span>
              </span>
              <span className="line-value">{t(`${fmtNum(r.resultCount)} kết quả`, `${fmtNum(r.resultCount)} results`)}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
