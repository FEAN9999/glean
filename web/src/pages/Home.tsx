import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtNum } from '../lib/format';
import { pageSplit, scrapePath, scrapeTitle, useScrapeQueue, type Scrape } from '../components/Scrape';
import { useSites } from '../lib/site';
import { EASE_OUT as EASE } from '../lib/ease';
import { NumberTicker } from '../components/magic/number-ticker';
import { BorderBeam } from '../components/magic/border-beam';
import { MagicCard } from '../components/magic/magic-card';
import { Spotlight } from '../components/magic/spotlight';

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

const fmt = (n: number) => fmtNum(n);

/** A pulsing placeholder bar on the night hero. */
function NightBone({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-full bg-white/10 motion-reduce:animate-none ${className}`} />;
}

/** A count that ticks up; screen readers get the final number once. */
function Count({ value, className, delay }: { value: number; className?: string; delay?: number }) {
  return (
    <>
      <span className="sr-only">{fmtNum(value)}</span>
      <NumberTicker aria-hidden="true" value={value} format={fmt} delay={delay} className={className} />
    </>
  );
}

/** One auto-sync line: a coloured dot and what it is doing. */
function SyncPill({ name, a }: { name: string; a: AutoState | undefined }) {
  const { t } = useI18n();
  if (!a) return <NightBone className="h-8 w-56" />;
  const every = Math.round(a.intervalMs / 60000);
  const [dot, text] = a.running
    ? (['bg-wheat animate-pulse motion-reduce:animate-none', t('đang đồng bộ…', 'syncing…')] as const)
    : !a.enabled
      ? (['bg-white/35', t('tự động đồng bộ đang tắt', 'auto-sync is off')] as const)
      : a.error
        ? (['bg-[oklch(0.68_0.17_25)]', t('lần gần nhất lỗi', 'last run failed')] as const)
        : a.at
          ? (['bg-[oklch(0.75_0.15_150)]', t(`đồng bộ ${fmtAgo(a.at)} · mỗi ${every} phút`, `synced ${fmtAgo(a.at)} · every ${every} min`)] as const)
          : (['bg-white/35', t('chưa đồng bộ lần nào', 'never synced')] as const);
  return (
    <span className="inline-flex max-w-full items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] py-1.5 pr-4 pl-3 text-[13px] text-mist/85">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
      <span className="shrink-0 whitespace-nowrap text-white">{name}</span>
      <span>{text}</span>
    </span>
  );
}

/** The job being sieved, as a ring of its pages that draws itself. */
function SieveRing({ total, done, current }: { total: number; done: number; current: number }) {
  const of = (n: number) => (total > 0 ? Math.min(1, n / total) : 0);
  const ring = { cx: 80, cy: 80, r: 64, fill: 'none', strokeWidth: 14, strokeLinecap: 'round' as const };
  return (
    <svg viewBox="0 0 160 160" className="size-40 shrink-0 -rotate-90" aria-hidden="true">
      <circle {...ring} className="stroke-white/10" />
      <motion.circle {...ring} className="stroke-wheat" initial={{ pathLength: 0 }} animate={{ pathLength: of(done + current) }} transition={{ duration: 1.2, ease: EASE, delay: 0.4 }} />
      <motion.circle {...ring} className="stroke-violet" initial={{ pathLength: 0 }} animate={{ pathLength: of(done) }} transition={{ duration: 1.2, ease: EASE, delay: 0.3 }} />
    </svg>
  );
}

/** Right of the hero: what is being sieved now. */
function Sieving() {
  const { t } = useI18n();
  const { items, processing: s, waiting, live } = useScrapeQueue();
  const lp = s ? live[s.id] : undefined;
  return (
    <section aria-labelledby="h-sieving" aria-busy={!items} className="relative rounded-[22px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm xl:w-[380px]">
      {s && <BorderBeam size={90} duration={7} colorFrom="#f2c46d" colorTo="#a99bff" borderWidth={1.5} />}
      <div className="flex items-center justify-between gap-3">
        <h2 id="h-sieving" className="m-0 text-[15px] font-normal text-white">
          {t('Đang sàng', 'Sieving')}
        </h2>
        <Link to="/hang-doi" className="text-[13px] text-mist/70 no-underline hover:text-white">
          {t('Xem hàng đợi', 'View queue')}
        </Link>
      </div>
      {!items && (
        <div className="mt-5 flex items-center gap-5">
          <span aria-hidden="true" className="size-40 shrink-0 animate-pulse rounded-full border-[14px] border-white/10 motion-reduce:animate-none" />
          <div className="grid flex-1 gap-2">
            <NightBone className="h-3 w-full" />
            <NightBone className="h-3 w-2/3" />
          </div>
        </div>
      )}
      {items && !s && (
        <div className="mt-5">
          <p className="m-0 text-lg font-light text-white">{t('Không có lượt nào đang chạy', 'Nothing is running')}</p>
          <p className="m-0 mt-1.5 text-[13px] text-mist/70">
            {waiting.length
              ? t(`${waiting.length} bài đang chờ đến lượt.`, `${waiting.length} threads waiting their turn.`)
              : t('Dán link bài viết vào ô tìm ở trên để sàng ảnh, video và bình luận.', 'Paste a thread link into the box above to sieve its images, videos and comments.')}
          </p>
        </div>
      )}
      {s && <SievingNow s={s} downloaded={lp?.downloaded} downloadTotal={lp?.total} />}
      {s && waiting[0] && (
        <p className="m-0 mt-4 truncate border-t border-white/10 pt-3 text-[13px] text-mist/70">
          {t('Đang chờ:', 'Next:')} {scrapeTitle(waiting[0], t)}
          {waiting.length > 1 && t(` và ${waiting.length - 1} bài khác`, ` and ${waiting.length - 1} more`)}
        </p>
      )}
    </section>
  );
}

function SievingNow({ s, downloaded, downloadTotal }: { s: Scrape; downloaded?: number; downloadTotal?: number }) {
  const { t } = useI18n();
  // The Desk shows one site: the chosen one.
  const { selected } = useSites();
  const sp = pageSplit(s, downloadTotal ? { downloaded, total: downloadTotal } : undefined);
  return (
    <>
      <Link to={scrapePath(s.id, s.site?.code ?? selected)} className="mt-3 block truncate text-[13px] text-mist/80 no-underline hover:text-white">
        {scrapeTitle(s, t)}
      </Link>
      <div className="mt-4 flex items-center gap-5" role="img" aria-label={t(`${sp.done} trên ${sp.total} trang đã quét`, `${sp.done} of ${sp.total} pages scanned`)}>
        <SieveRing total={sp.total} done={sp.done} current={sp.current} />
        <div className="grid gap-1">
          <span className="text-[13px] text-mist/70">
            {downloadTotal
              ? t(`Đang tải ảnh ${fmtNum(downloaded)} trên ${fmtNum(downloadTotal)}`, `Downloading ${fmtNum(downloaded)} of ${fmtNum(downloadTotal)}`)
              : sp.total
                ? t(`Đang quét trang ${Math.min(sp.done + 1, sp.total)} trên ${sp.total}`, `Scanning page ${Math.min(sp.done + 1, sp.total)} of ${sp.total}`)
                : t('Đang mở trang đầu', 'Opening page 1')}
          </span>
          <span className="text-3xl font-light tracking-tight text-white">
            <Count value={s.totalImages} />
          </span>
          <span className="text-[13px] text-mist/70">{t('ảnh đã tìm thấy', 'images found')}</span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mist/70">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-violet" />
          {t(`Đã quét ${sp.done}`, `Scanned ${sp.done}`)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-wheat" />
          {t(`Đang quét ${sp.current}`, `Scanning ${sp.current}`)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-white/20" />
          {t(`Còn lại ${sp.left}`, `Left ${sp.left}`)}
        </span>
      </div>
    </>
  );
}

/** The night hero: the archive's size, auto-sync, and the job being sieved. */
function Hero({ ov, auto }: { ov: Overview | null; auto: AutoStatus | null }) {
  const { t } = useI18n();
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="relative isolate overflow-hidden rounded-[28px] bg-night px-6 py-8 text-mist sm:px-10 sm:py-12"
    >
      <Spotlight />
      <div className="relative z-10 grid items-end gap-10 xl:grid-cols-[1fr_auto]">
        <section aria-labelledby="h-intake" aria-busy={!ov || !auto} className="min-w-0">
          <h1 className="m-0 text-[15px] font-normal text-mist/70">{t('Bàn làm việc', 'Desk')}</h1>
          <h2 id="h-intake" className="sr-only">
            {t('Nạp vào kho', 'Intake')}
          </h2>
          {ov ? (
            <>
              <p className="m-0 mt-6 text-[clamp(56px,9vw,112px)] leading-[0.95] font-light tracking-[-0.045em] text-white">
                <Count value={ov.threads} delay={0.2} />
              </p>
              <p className="m-0 mt-3 text-lg font-light text-mist/80">{t('bài viết đã đồng bộ về kho', 'threads synced into the archive')}</p>
            </>
          ) : (
            <>
              <NightBone className="mt-8 h-20 w-72 max-w-full" />
              <NightBone className="mt-4 h-4 w-60" />
            </>
          )}
          {ov && (
            <dl className="m-0 mt-8 flex flex-wrap gap-x-10 gap-y-4">
              <Stat value={ov.comments} label={t('bình luận', 'comments')} delay={0.35} />
              <Stat value={ov.images} label={t('ảnh đã lưu', 'saved images')} delay={0.45} />
              {ov.deletedThreads > 0 && <Stat value={ov.deletedThreads} label={t('bài đã xóa trên diễn đàn, vẫn còn bản lưu', 'threads deleted on the forum, still kept here')} delay={0.55} />}
            </dl>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-2.5">
            <SyncPill name={t('Bài viết', 'Threads')} a={auto?.posts} />
            <SyncPill name={t('Bình luận', 'Comments')} a={auto?.comments} />
            <Link to="/nhat-ky/bai-viet" className="ml-1 text-[13px] text-mist/70 no-underline hover:text-white">
              {t('Xem nhật ký', 'View log')}
            </Link>
          </div>
        </section>
        <Sieving />
      </div>
    </motion.div>
  );
}

function Stat({ value, label, delay }: { value: number; label: string; delay: number }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-[13px] text-mist/70">{label}</dt>
      <dd className="m-0 text-3xl font-light tracking-tight text-white">
        <Count value={value} delay={delay} />
      </dd>
    </div>
  );
}

/** A list card under the hero, sliding in after it. */
function Card({ id, title, sub, delay, children }: { id: string; title: string; sub?: string; delay: number; children: ReactNode }) {
  return (
    <motion.section aria-labelledby={id} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay }} className="rounded-3xl">
      <MagicCard className="h-full rounded-3xl" gradientFrom="#a99bff" gradientTo="#f2c46d" gradientColor="var(--tint)" gradientSize={260}>
        <div className="p-6">
          <h2 id={id} className="m-0 text-[17px] font-normal text-ink">
            {title}
          </h2>
          {sub && <p className="m-0 mt-1 text-[13px] text-dim">{sub}</p>}
          <ul className="m-0 mt-4 grid list-none gap-1 p-0">{children}</ul>
        </div>
      </MagicCard>
    </motion.section>
  );
}

/** One row of a card; new rows slide in, rows that drop off fade out. */
function Row({ to, title, sub, value, thumb }: { to: string; title: string; sub: string; value: string; thumb?: boolean }) {
  return (
    <motion.li layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.35, ease: EASE }}>
      <Link to={to} className="-mx-3 flex items-center gap-3 rounded-2xl px-3 py-2.5 text-ink no-underline transition-colors hover:bg-field">
        {thumb && <span aria-hidden="true" className="size-10 shrink-0 rounded-xl bg-linear-to-br from-violet/70 to-wheat/70" />}
        <span className="grid min-w-0 flex-1">
          <span className="truncate">{title}</span>
          <span className="truncate text-[12px] text-dim">{sub}</span>
        </span>
        <span className="shrink-0 text-[13px] text-dim tabular-nums">{value}</span>
      </Link>
    </motion.li>
  );
}

function RowBones({ n, label }: { n: number; label: string }) {
  return (
    <li aria-busy="true" aria-label={label} className="grid gap-3 py-2">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} aria-hidden="true" className="block h-10 animate-pulse rounded-2xl bg-field motion-reduce:animate-none" />
      ))}
    </li>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const { selected } = useSites();
  const [ov, setOv] = useState<Overview | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [saved, setSaved] = useState<Scrape[] | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [recentC, setRecentC] = useState<Recent[]>([]);
  const [searchesLoaded, setSearchesLoaded] = useState(false);

  const load = useCallback(() => {
    api.get<Overview>('/systems/overview', { quiet: true }).then((r) => setOv(r.data)).catch(() => {});
    api.get<AutoStatus>('/sync/auto-status', { quiet: true }).then((r) => setAuto(r.data)).catch(() => {});
  }, []);
  const loadSaved = useCallback(() => {
    api
      .get<Scrape[]>('/scrapes/processed?size=3', { quiet: true })
      .then((r) => setSaved(r.data))
      // Keep what is shown: an empty list here would claim nothing was ever sieved.
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    loadSaved();
    void Promise.allSettled([
      api.get<Recent[]>('/posts/search/recent-keywords', { quiet: true }).then((r) => setRecent(r.data.slice(0, 4))),
      api.get<Recent[]>('/comments/recent-keywords', { quiet: true }).then((r) => setRecentC(r.data.slice(0, 4))),
    ]).then(() => setSearchesLoaded(true));
  }, [load, loadSaved]);
  useEvent([Ev.AutoSyncFinished, Ev.FinishScrape, Ev.ManualSyncComplete, Ev.Reconnected], load);
  useEvent([Ev.FinishScrape, Ev.Reconnected], loadSaved);
  useEvent<Recent>(Ev.NewSearch, (m) => setRecent((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 4)), { site: '*' });
  useEvent<Recent>(Ev.NewCommentSearch, (m) => setRecentC((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 4)), { site: '*' });

  const searches = [
    ...recent.map((r) => ({ ...r, kind: 'posts' as const })),
    ...recentC.map((r) => ({ ...r, kind: 'comments' as const })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);

  return (
    <div className="page">
        <Hero ov={ov} auto={auto} />

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Card id="h-saved" title={t('Vừa lưu vào kho', 'Just saved')} sub={t('Bài đã sàng gần đây nhất', 'The most recently sieved threads')} delay={0.25}>
            {!saved && <RowBones n={3} label={t('Đang tải bài vừa sàng', 'Loading recent jobs')} />}
            {saved && !saved.length && <li className="py-2 text-dim">{t('Chưa có lượt sàng nào.', 'No sieve jobs yet.')}</li>}
            <AnimatePresence initial={false}>
              {saved?.map((s) => (
                <Row
                  key={s.id}
                  thumb
                  to={scrapePath(s.id, s.site?.code ?? selected)}
                  title={scrapeTitle(s, t)}
                  sub={`${t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)} · ${fmtAgo(s.finishedAt ?? s.createdAt)}`}
                  value={t(`${fmtNum(s.totalImages)} ảnh`, `${fmtNum(s.totalImages)} images`)}
                />
              ))}
            </AnimatePresence>
          </Card>

          <Card id="h-recent" title={t('Vừa tìm', 'Recent searches')} sub={t('Từ khóa đã tìm gần đây', 'Keywords searched lately')} delay={0.35}>
            {!searchesLoaded && !searches.length && <RowBones n={4} label={t('Đang tải lượt tìm gần đây', 'Loading recent searches')} />}
            {searchesLoaded && !searches.length && <li className="py-2 text-dim">{t('Chưa có lượt tìm nào.', 'No searches yet.')}</li>}
            <AnimatePresence initial={false}>
              {searches.map((r) => (
                <Row
                  key={`${r.kind}${r.id}`}
                  to={`/${r.kind === 'posts' ? 'bai-viet' : 'binh-luan'}/tu-khoa?q=${encodeURIComponent(r.keyword)}`}
                  title={r.keyword}
                  sub={`${r.kind === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')} · ${fmtAgo(r.createdAt)}`}
                  value={t(`${fmtNum(r.resultCount)} kết quả`, `${fmtNum(r.resultCount)} results`)}
                />
              ))}
            </AnimatePresence>
          </Card>
        </div>
    </div>
  );
}
