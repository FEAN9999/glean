import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtNum, isLinkLike, parseThreadInput } from '../lib/format';
import { ScrapeQueue, useCreateScrape } from '../components/Scrape';

interface Overview {
  threads: number;
  comments: number;
  deletedThreads: number;
  scrapes: number;
  images: number;
  forums: { id: number; name: string; threads: number }[];
}
interface AutoStatus {
  posts: { at: string | null; error: string | null; running: boolean; enabled: boolean; intervalMs: number };
  comments: { at: string | null; error: string | null; running: boolean; enabled: boolean; intervalMs: number };
}
interface Recent {
  id: number;
  keyword: string;
  resultCount: number;
  createdAt: string;
}

/** One input, two jobs: a link (or bare ID) goes to the sieve, anything else is a post search. */
function Omnibox() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const create = useCreateScrape();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const v = value.trim();
  const asLink = v && (isLinkLike(v) || /^\d+$/.test(v)) && parseThreadInput(v) != null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!v) return;
    setError('');
    if (asLink) {
      setBusy(true);
      try {
        await create(v, 'home', { navigate: true });
      } catch (err) {
        setError((err as ApiErr).message);
      } finally {
        setBusy(false);
      }
    } else {
      navigate(`/bai-viet/tu-khoa?q=${encodeURIComponent(v)}`);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="sieve-box">
        <label htmlFor="omni" className="sr-only">
          {t('Tìm bài viết hoặc dán link để sàng', 'Search posts or paste a link to sieve')}
        </label>
        <input
          id="omni"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('Gõ để tìm bài viết, hoặc dán link để sàng ảnh', 'Type to search posts, or paste a link to sieve images')}
          autoFocus
          autoComplete="off"
        />
        <button className="btn btn-primary" disabled={!v || busy}>
          {asLink ? t('Sàng bài này', 'Sieve thread') : t('Tìm bài viết', 'Search posts')}
        </button>
      </div>
      <div className="sieve-hint" role={error ? 'alert' : undefined}>
        {error ? (
          <span style={{ color: 'var(--rust)' }}>{error}</span>
        ) : asLink ? (
          t(`Nhận ra bài #${parseThreadInput(v)}. Nhấn Enter để đưa vào hàng đợi sàng.`, `Recognised thread #${parseThreadInput(v)}. Press Enter to queue it.`)
        ) : v ? (
          t('Nhấn Enter để tìm theo tiêu đề bài viết.', 'Press Enter to search thread titles.')
        ) : (
          t('Link dạng …/threads/ten-bai.12345/ sẽ được sàng; chữ thường sẽ được tìm.', 'Links like …/threads/title.12345/ get sieved; plain words get searched.')
        )}
      </div>
    </form>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const [ov, setOv] = useState<Overview | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [recentC, setRecentC] = useState<Recent[]>([]);

  const load = useCallback(() => {
    api.get<Overview>('/systems/overview', { quiet: true }).then((r) => setOv(r.data)).catch(() => {});
    api.get<AutoStatus>('/sync/auto-status', { quiet: true }).then((r) => setAuto(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    api.get<Recent[]>('/posts/search/recent-keywords', { quiet: true }).then((r) => setRecent(r.data.slice(0, 6))).catch(() => {});
    api.get<Recent[]>('/comments/recent-keywords', { quiet: true }).then((r) => setRecentC(r.data.slice(0, 6))).catch(() => {});
  }, [load]);
  useEvent([Ev.AutoSyncFinished, Ev.FinishScrape, Ev.ManualSyncComplete], load);
  useEvent(Ev.NewSearch, (m) => setRecent((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 6)));
  useEvent(Ev.NewCommentSearch, (m) => setRecentC((r) => [m.data, ...r.filter((x) => x.keyword !== m.data.keyword)].slice(0, 6)));

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Hôm nay sàng gì?', 'What are we sieving today?')}</h1>
      </header>

      <Omnibox />

      <div className="grid-2 section">
        <section aria-labelledby="h-queue">
          <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 id="h-queue" className="section-title" style={{ margin: 0 }}>
              {t('Đang sàng', 'In the sieve')}
            </h2>
            <Link to="/sang" className="link-btn">
              {t('Tất cả lượt sàng', 'All sieve jobs')}
            </Link>
          </div>
          <ScrapeQueue compact />
        </section>

        <section aria-labelledby="h-store">
          <h2 id="h-store" className="section-title">
            {t('Trong kho', 'In the archive')}
          </h2>
          {ov && (
            <div className="figures">
              <div className="figure">
                <span className="num">{fmtNum(ov.threads)}</span>
                <span>{t('bài viết', 'threads')}</span>
              </div>
              <div className="figure">
                <span className="num">{fmtNum(ov.comments)}</span>
                <span>{t('bình luận', 'comments')}</span>
              </div>
              <div className="figure">
                <span className="num">{fmtNum(ov.images)}</span>
                <span>{t('ảnh đã lưu', 'saved images')}</span>
              </div>
            </div>
          )}
          {auto && (
            <ul className="rows" style={{ marginTop: 24 }}>
              {(['posts', 'comments'] as const).map((k) => (
                <li key={k} className="row" style={{ padding: '10px 0' }}>
                  <div className="hstack" style={{ justifyContent: 'space-between' }}>
                    <span>{k === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')}</span>
                    <span className="muted" style={{ fontSize: 13.5 }}>
                      {auto[k].running
                        ? t('đang đồng bộ…', 'syncing…')
                        : !auto[k].enabled
                          ? t('tự động đồng bộ đang tắt', 'auto-sync off')
                          : auto[k].error
                            ? t('lần gần nhất lỗi', 'last run failed')
                            : auto[k].at
                              ? t(`đồng bộ ${fmtAgo(auto[k].at)}`, `synced ${fmtAgo(auto[k].at)}`)
                              : t('chưa đồng bộ lần nào', 'never synced')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {ov && ov.deletedThreads > 0 && (
            <p className="muted" style={{ fontSize: 13.5, marginTop: 12 }}>
              {t(
                `${ov.deletedThreads} bài đã bị xóa trên diễn đàn nhưng vẫn còn bản lưu trong kho.`,
                `${ov.deletedThreads} threads were deleted on the forum but are still kept here.`,
              )}
            </p>
          )}

          {(recent.length > 0 || recentC.length > 0) && (
            <div style={{ marginTop: 32 }}>
              <h2 className="section-title">{t('Vừa tìm', 'Recent searches')}</h2>
              <div className="hstack" style={{ gap: 8 }}>
                {recent.map((r) => (
                  <Link key={`p${r.id}`} className="tag" to={`/bai-viet/tu-khoa?q=${encodeURIComponent(r.keyword)}`} style={{ textDecoration: 'none', height: 28, fontSize: 13.5 }}>
                    {r.keyword}
                  </Link>
                ))}
                {recentC.map((r) => (
                  <Link key={`c${r.id}`} className="tag" to={`/binh-luan/tu-khoa?q=${encodeURIComponent(r.keyword)}`} style={{ textDecoration: 'none', height: 28, fontSize: 13.5 }}>
                    {r.keyword} <span className="muted">({t('bình luận', 'comments')})</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
