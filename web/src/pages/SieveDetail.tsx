import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtDate, fmtDuration, fmtNum } from '../lib/format';
import { Empty, ExternalLink, Mesh, Pager, Spinner, useConfirm, useUi } from '../components/ui';
import { ScrapeStatus, useStatusLabel, type Scrape } from '../components/Scrape';
import { ProxyNotice } from './Sieve';

interface Img {
  id: number;
  page: number;
  postNo: number | null;
  originUrl: string;
  currentUrl: string | null;
  isBin: boolean;
  isDownloadFailed: boolean;
  displayByOriginUrl: boolean;
}
interface Vid {
  id: number;
  page: number;
  postNo: number | null;
  originUrl: string;
  kind: 'file' | 'embed';
  currentUrl: string | null;
  hlsUrl: string | null;
}
interface Lnk {
  id: number;
  page: number;
  postNo: number | null;
  url: string;
  text: string | null;
}
interface Cmt {
  id: number;
  page: number;
  postNo: number | null;
  author: string;
  content: string;
  createdAt: string | null;
  url: string | null;
}

type Tab = 'images' | 'videos' | 'links' | 'comments' | 'synced-comments';

function usePaged<T>(path: string, size: number, extra = '', deps: unknown[] = []) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: T[]; total: number; extra: Record<string, unknown> } | null>(null);
  const load = useCallback(
    (p: number) => {
      api
        .get<T[]>(`${path}?page=${p}&size=${size}${extra}`, { quiet: true })
        .then((r) => setData({ items: r.data, total: r.total ?? 0, extra: r }))
        .catch(() => setData({ items: [], total: 0, extra: {} }));
    },
    [path, size, extra],
  );
  useEffect(() => {
    setPage(1);
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);
  return {
    data,
    page,
    setPage: (p: number) => {
      setPage(p);
      load(p);
      window.scrollTo({ top: document.getElementById('tabs')?.offsetTop ?? 0, behavior: 'smooth' });
    },
    reload: () => load(page),
  };
}

function Lightbox({ items, index, onClose, onIndex }: { items: Img[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const { t } = useI18n();
  const img = items[index];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, items.length, onClose, onIndex]);
  if (!img) return null;
  const src = img.currentUrl ?? img.originUrl;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('Xem ảnh', 'Image viewer')}>
      <div className="lightbox-top">
        <span className="num">
          {index + 1} / {items.length}
        </span>
        <span>
          {t(`Ở trang ${img.page}`, `On page ${img.page}`)}
          {img.postNo ? `, #${img.postNo}` : ''}
        </span>
        <span className="spacer" />
        <ExternalLink href={img.originUrl} className="btn btn-sm">
          {t('Mở ảnh gốc', 'Open original')}
        </ExternalLink>
        <button className="btn btn-sm" onClick={onClose} autoFocus>
          {t('Đóng', 'Close')}
        </button>
      </div>
      <div className="lightbox-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <img src={src} alt={t(`Ảnh ở trang ${img.page}`, `Image on page ${img.page}`)} />
      </div>
      <div className="lightbox-bottom" style={{ justifyContent: 'center' }}>
        <button className="btn btn-sm" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          {t('Ảnh trước', 'Previous')}
        </button>
        <button className="btn btn-sm" disabled={index >= items.length - 1} onClick={() => onIndex(index + 1)}>
          {t('Ảnh sau', 'Next')}
        </button>
      </div>
    </div>
  );
}

function ImageTile({ img, onOpen }: { img: Img; onOpen: () => void }) {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);
  const pending = !img.currentUrl && !img.isBin && !img.isDownloadFailed && !img.displayByOriginUrl;
  if (pending) {
    return (
      <div className="tile" style={{ cursor: 'default' }}>
        <div className="tile-broken" style={{ borderStyle: 'solid' }}>
          {t('Đang chờ tải về', 'Waiting to download')}
        </div>
        <span className="tile-cap">{t(`Trang ${img.page}`, `Page ${img.page}`)}</span>
      </div>
    );
  }
  const src = img.currentUrl ?? (img.displayByOriginUrl && !img.isBin ? img.originUrl : null);
  if (!src || broken) {
    return (
      <div className="tile" style={{ cursor: 'default' }}>
        <div className="tile-broken">
          <div className="stack" style={{ gap: 6, alignItems: 'center' }}>
            <span>{img.isBin ? t('Không phải ảnh', 'Not an image') : t('Không tải được', 'Could not download')}</span>
            <ExternalLink href={img.originUrl} className="link-btn" style={{ fontSize: 12.5 }}>
              {t('Mở link gốc', 'Open source link')}
            </ExternalLink>
          </div>
        </div>
        <span className="tile-cap">{t(`Trang ${img.page}`, `Page ${img.page}`)}</span>
      </div>
    );
  }
  return (
    <button className="tile" onClick={onOpen} aria-label={t(`Phóng to ảnh ở trang ${img.page}`, `Enlarge image on page ${img.page}`)}>
      <img src={src} loading="lazy" alt="" onError={() => setBroken(true)} />
      <span className="tile-cap">{t(`Trang ${img.page}`, `Page ${img.page}`)}</span>
    </button>
  );
}

function ImagesTab({ id }: { id: number }) {
  const { t } = useI18n();
  const { data, page, setPage } = usePaged<Img>(`/scrapes/${id}/images`, 48);
  const [open, setOpen] = useState<number | null>(null);
  if (!data) return <Spinner label={t('Đang tải ảnh', 'Loading images')} />;
  if (!data.total) return <Empty title={t('Không có ảnh', 'No images')}>{t('Chủ đề này không có ảnh nào, hoặc ảnh đến từ tên miền đang bị bỏ qua.', 'This thread has no images, or they come from ignored domains.')}</Empty>;
  const viewable = data.items.filter((i) => i.currentUrl || (i.displayByOriginUrl && !i.isBin));
  return (
    <>
      <div className="gallery">
        {data.items.map((img) => (
          <ImageTile key={img.id} img={img} onOpen={() => setOpen(viewable.findIndex((v) => v.id === img.id))} />
        ))}
      </div>
      <Pager page={page} total={data.total} size={48} onPage={setPage} />
      {open != null && open >= 0 && <Lightbox items={viewable} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function VideosTab({ id }: { id: number }) {
  const { t } = useI18n();
  const { data, page, setPage } = usePaged<Vid>(`/scrapes/${id}/videos`, 30);
  if (!data) return <Spinner label={t('Đang tải video', 'Loading videos')} />;
  if (!data.total) return <Empty title={t('Không có video', 'No videos')} />;
  return (
    <>
      <ul className="rows">
        {data.items.map((v) => (
          <li key={v.id} className="row">
            {v.currentUrl ? (
              <video controls preload="metadata" src={v.currentUrl} style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 10, background: '#000' }} />
            ) : null}
            <div className="row-meta">
              <span className="tag">{v.kind === 'embed' ? t('Video nhúng', 'Embedded') : t('Tệp video', 'Video file')}</span>
              <span>
                {t(`Ở trang ${v.page}`, `On page ${v.page}`)}
                {v.postNo ? `, #${v.postNo}` : ''}
              </span>
              {v.hlsUrl && <span className="tag tag-moss">HLS</span>}
            </div>
            <ExternalLink href={v.originUrl} className="link-btn" style={{ wordBreak: 'break-all', fontSize: 14 }}>
              {v.originUrl}
            </ExternalLink>
          </li>
        ))}
      </ul>
      <Pager page={page} total={data.total} size={30} onPage={setPage} />
    </>
  );
}

function LinksTab({ id }: { id: number }) {
  const { t } = useI18n();
  const { data, page, setPage } = usePaged<Lnk>(`/scrapes/${id}/links`, 40);
  if (!data) return <Spinner label={t('Đang tải liên kết', 'Loading links')} />;
  if (!data.total) return <Empty title={t('Không có liên kết', 'No links')} />;
  return (
    <>
      <ul className="rows">
        {data.items.map((l) => (
          <li key={l.id} className="row" style={{ gap: 2 }}>
            <ExternalLink href={l.url} className="row-title" style={{ fontSize: 15 }}>
              {l.text || l.url}
            </ExternalLink>
            <div className="row-meta">
              <span style={{ wordBreak: 'break-all' }}>{new URL(l.url).host}</span>
              <span>
                {t(`Ở trang ${l.page}`, `On page ${l.page}`)}
                {l.postNo ? `, #${l.postNo}` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <Pager page={page} total={data.total} size={40} onPage={setPage} />
    </>
  );
}

function CommentsTab({ id, synced }: { id: number; synced?: boolean }) {
  const { t } = useI18n();
  const [minLength, setMinLength] = useState(12);
  const [applied, setApplied] = useState(12);
  useEffect(() => {
    const h = setTimeout(() => setApplied(minLength), 300);
    return () => clearTimeout(h);
  }, [minLength]);
  const { data, page, setPage } = usePaged<Cmt>(`/scrapes/${id}/${synced ? 'synced-comments' : 'comments'}`, 30, synced ? '' : `&minLength=${applied}`);
  return (
    <>
      {synced ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
          {t('Bình luận lưu trong kho từ các lần đồng bộ. Vẫn còn nguyên khi bài gốc bị xóa.', 'Comments kept in the archive by syncing. They remain even if the thread is deleted.')}
        </p>
      ) : (
        <div className="hstack" style={{ marginBottom: 12 }}>
          <label className="hstack" style={{ gap: 10, fontSize: 14 }}>
            <span>{t('Bỏ bình luận ngắn hơn', 'Hide comments shorter than')}</span>
            <input type="range" min={0} max={120} step={2} value={minLength} onChange={(e) => setMinLength(Number(e.target.value))} />
            <span className="num" style={{ minWidth: 60 }}>
              {t(`${minLength} ký tự`, `${minLength} chars`)}
            </span>
          </label>
          {data && typeof data.extra.removed === 'number' && data.extra.removed > 0 && (
            <span className="muted" style={{ fontSize: 14 }}>
              {t(`Đã loại bỏ ${fmtNum(data.extra.removed as number)} bình luận không có giá trị`, `Removed ${fmtNum(data.extra.removed as number)} low-value comments`)}
            </span>
          )}
        </div>
      )}
      {!data ? (
        <Spinner label={t('Đang tải bình luận', 'Loading comments')} />
      ) : !data.total ? (
        <Empty title={t('Không có bình luận', 'No comments')} />
      ) : (
        <>
          <ul className="rows">
            {data.items.map((c) => (
              <li key={c.id} className="row">
                <div className="row-meta">
                  <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{c.author}</strong>
                  {c.createdAt && <span>{fmtDate(c.createdAt)}</span>}
                  <span>
                    {t(`Ở trang ${c.page}`, `On page ${c.page}`)}
                    {c.postNo ? `, #${c.postNo}` : ''}
                  </span>
                </div>
                <div className="row-body">{c.content || <span className="muted">{t('(chỉ có ảnh hoặc trích dẫn)', '(images or quotes only)')}</span>}</div>
                {c.url && (
                  <div>
                    <ExternalLink href={c.url} className="link-btn" style={{ fontSize: 13.5 }}>
                      {t('Xem bình luận gốc', 'View original')}
                    </ExternalLink>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Pager page={page} total={data.total} size={30} onPage={setPage} />
        </>
      )}
    </>
  );
}

export function SieveDetailPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const { t } = useI18n();
  const { toast } = useUi();
  const navigate = useNavigate();
  const label = useStatusLabel();
  const { ask, node } = useConfirm();
  const [s, setS] = useState<Scrape | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [dl, setDl] = useState<{ downloaded: number; total: number } | null>(null);
  const [rank, setRank] = useState<{ rank: number | null; waiting: number } | null>(null);
  const [tab, setTab] = useState<Tab>('images');
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    api
      .get<Scrape>(`/scrapes/${id}`, { quiet: true })
      .then((r) => {
        setS(r.data);
        // merge: realtime events may have arrived while this request was in flight
        setDone((d) => new Set([...d, ...(r.data.donePages ?? [])]));
        if (r.data.status === ScrapeStatus.Waiting) api.get(`/scrapes/${id}/rank`, { quiet: true }).then((x) => setRank(x.data));
        else setRank(null);
      })
      .catch(() => setNotFound(true));
  }, [id]);
  useEffect(load, [load]);

  useEvent(Ev.UpdateScrape, (m) => {
    if (m.data.id === id) setS((x) => (x ? { ...x, ...m.data } : m.data));
    else if (s?.status === ScrapeStatus.Waiting) api.get(`/scrapes/${id}/rank`, { quiet: true }).then((x) => setRank(x.data));
  });
  useEvent(Ev.NewScrape, (m) => {
    if (m.data.id === id) load();
  });
  useEvent(Ev.UpdateScrapeProcess, (m) => {
    if (m.data.scrapeId !== id) return;
    setDone((d) => new Set(d).add(m.data.page));
    setS((x) => (x ? { ...x, totalPages: m.data.totalPages, currentPage: m.data.currentPage, status: ScrapeStatus.Processing } : x));
  });
  useEvent(Ev.UpdateDownloadImageProcess, (m) => m.data.scrapeId === id && setDl({ downloaded: m.data.downloaded, total: m.data.total }));
  useEvent(Ev.FinishScrape, (m) => {
    if (m.data.id !== id) return;
    load();
    setVersion((v) => v + 1);
    setDl(null);
  });

  if (notFound)
    return (
      <div className="page">
        <Empty title={t('Không tìm thấy lượt sàng này', 'Sieve job not found')}>
          <Link to="/sang" className="link-btn">
            {t('Về danh sách lượt sàng', 'Back to sieve jobs')}
          </Link>
        </Empty>
      </div>
    );
  if (!s) return <div className="page"><Spinner label={t('Đang tải', 'Loading')} /></div>;

  const processing = s.status === ScrapeStatus.Processing;
  const finished = s.status === ScrapeStatus.Completed || s.status === ScrapeStatus.Failed;
  const nextPages = new Set<number>();
  if (processing) for (let p = 1; p <= s.totalPages && nextPages.size < 3; p++) if (!done.has(p)) nextPages.add(p);

  const retry = async () => {
    await api.post(`/scrapes/${id}/retry`);
    setDone(new Set());
    setVersion((v) => v + 1);
    load();
  };
  const remove = async () => {
    const yes = await ask(
      t('Xóa lượt sàng này?', 'Delete this sieve job?'),
      t('Ảnh đã tải về của lượt này sẽ bị xóa khỏi máy. Bình luận đã đồng bộ vẫn giữ trong kho.', 'Downloaded images of this job are removed from disk. Synced comments stay in the archive.'),
      t('Xóa lượt sàng', 'Delete job'),
      true,
    );
    if (!yes) return;
    await api.del(`/scrapes/${id}/mark-delete`);
    toast(t('Đã xóa lượt sàng.', 'Sieve job deleted.'));
    navigate('/sang');
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'images', label: t('Ảnh', 'Images'), count: s.totalImages },
    { key: 'videos', label: t('Video', 'Videos'), count: s.totalVideos },
    { key: 'links', label: t('Liên kết', 'Links'), count: s.totalLinks },
    { key: 'comments', label: t('Bình luận', 'Comments'), count: s.totalComments },
    { key: 'synced-comments', label: t('Bình luận lưu trữ', 'Archived comments'), count: s.syncedCommentCount },
  ];

  return (
    <div className="page">
      <Link to="/sang" className="link-btn muted" style={{ fontSize: 14 }}>
        {t('Tất cả lượt sàng', 'All sieve jobs')}
      </Link>
      <header className="page-head" style={{ marginTop: 12 }}>
        <h1 className="page-title" style={{ fontSize: 'clamp(26px, 3.4vw, 38px)' }}>
          {s.threadTitle ?? t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)}
        </h1>
        <div className="row-meta" style={{ fontSize: 14 }}>
          <span className={`tag ${processing ? 'tag-straw' : s.status === ScrapeStatus.Failed ? 'tag-rust' : s.status === ScrapeStatus.Completed ? 'tag-moss' : ''}`}>{label(s.status)}</span>
          <span>{t(`Bài #${s.threadId}`, `Thread #${s.threadId}`)}</span>
          <ExternalLink href={s.threadUrl} className="link-btn" style={{ fontSize: 14 }}>
            {t('Mở bài gốc', 'Open thread')}
          </ExternalLink>
          <span>
            {t('Tạo', 'Created')} {fmtDate(s.createdAt)}
          </span>
        </div>
      </header>

      <ProxyNotice />

      {s.isThreadDeleted && (
        <div className="notice notice-rust" style={{ marginBottom: 20 }}>
          <strong>{t('Đã bị xóa trên diễn đàn.', 'Deleted on the forum.')}</strong>
          <span>{t('Bạn đang xem bản lưu trữ: ảnh đã tải và bình luận đã đồng bộ trước đó.', 'You are viewing the archived copy: previously downloaded images and synced comments.')}</span>
        </div>
      )}
      {s.error && (
        <div className="notice notice-rust" style={{ marginBottom: 20 }}>
          {s.error}
        </div>
      )}

      {s.status === ScrapeStatus.Waiting && (
        <div className="notice notice-straw" style={{ marginBottom: 20 }}>
          {rank?.rank
            ? t(`Số thứ tự: ${rank.rank} / đang chờ: ${rank.waiting}`, `Position ${rank.rank} of ${rank.waiting} queued`)
            : t('Đang chờ đến lượt.', 'Waiting for its turn.')}
        </div>
      )}

      {s.totalPages > 0 && (
        <section aria-label={t('Tiến độ theo trang', 'Progress by page')} style={{ marginBottom: 28 }}>
          <Mesh
            total={s.totalPages}
            done={finished && !s.isThreadDeleted ? s.totalPages : done}
            current={nextPages}
            size="lg"
            label={t(`${done.size} trên ${s.totalPages} trang đã quét`, `${done.size} of ${s.totalPages} pages scanned`)}
          />
          <p className="muted" style={{ fontSize: 14, margin: '12px 0 0' }}>
            {processing && !dl
              ? t(`Scan bài ${s.currentPage}/${s.totalPages}`, `Scanning page ${s.currentPage} of ${s.totalPages}`)
              : processing && dl
                ? t(`Download ảnh ${fmtNum(dl.downloaded)}/${fmtNum(dl.total)}`, `Downloading image ${fmtNum(dl.downloaded)} of ${fmtNum(dl.total)}`)
                : t(`Mỗi chấm là một trang của chủ đề, ${fmtNum(s.totalPages)} trang.`, `Each dot is one page of the thread, ${fmtNum(s.totalPages)} pages.`)}
          </p>
          {processing && dl && (
            <div className="bar" style={{ marginTop: 8, maxWidth: 520 }}>
              <span style={{ width: `${(100 * dl.downloaded) / Math.max(1, dl.total)}%` }} />
            </div>
          )}
        </section>
      )}

      <div className="hstack" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <div className="figures">
          <div className="figure">
            <span className="num">{fmtNum(s.totalImages)}</span>
            <span>{t('ảnh', 'images')}{s.failedImages ? t(`, ${s.failedImages} lỗi`, `, ${s.failedImages} failed`) : ''}</span>
          </div>
          <div className="figure">
            <span className="num">{fmtNum(s.totalVideos)}</span>
            <span>video</span>
          </div>
          <div className="figure">
            <span className="num">{fmtNum(s.totalComments)}</span>
            <span>{t('bình luận', 'comments')}</span>
          </div>
          <div className="figure">
            <span className="num">{fmtDuration(s.handlingSeconds)}</span>
            <span>{t('thời gian xử lý', 'processing time')}</span>
          </div>
        </div>
        <div className="hstack">
          <button className="btn btn-sm" onClick={() => (load(), setVersion((v) => v + 1))}>
            {t('Làm mới', 'Refresh')}
          </button>
          {finished && (
            <button className="btn btn-sm" onClick={() => void retry()}>
              {t('Sàng lại', 'Sieve again')}
            </button>
          )}
          <button className="btn btn-sm btn-danger" onClick={() => void remove()}>
            {t('Xóa', 'Delete')}
          </button>
        </div>
      </div>
      {s.expiresAt && (
        <p className="muted" style={{ fontSize: 13.5, marginTop: -16 }}>
          {t(`Dữ liệu sẽ bị xóa lúc ${fmtDate(s.expiresAt)}.`, `Data will be deleted at ${fmtDate(s.expiresAt)}.`)}
        </p>
      )}

      <div className="tabs" id="tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.key} role="tab" aria-selected={tab === x.key} className={tab === x.key ? 'on' : ''} onClick={() => setTab(x.key)}>
            {x.label}
            {x.count != null && <span className="count">{fmtNum(x.count)}</span>}
          </button>
        ))}
      </div>
      <div key={`${tab}-${version}`}>
        {tab === 'images' && <ImagesTab id={id} />}
        {tab === 'videos' && <VideosTab id={id} />}
        {tab === 'links' && <LinksTab id={id} />}
        {tab === 'comments' && <CommentsTab id={id} />}
        {tab === 'synced-comments' && <CommentsTab id={id} synced />}
      </div>
      {node}
    </div>
  );
}
