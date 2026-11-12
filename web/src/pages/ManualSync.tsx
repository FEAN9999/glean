import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtAgo, fmtNum, fmtTime } from '../lib/format';
import { SudoGate } from '../components/SudoGate';
import { Status } from '../components/ui';

interface SyncStatus {
  running: boolean;
  stopRequested: boolean;
  type: 'posts' | 'comments';
  options: { type: string; allPages: boolean; pageFrom: number; pageTo: number; batchSize: number; forums: number[] } | null;
  forum: number | null;
  forumName: string;
  currentPage: number;
  totalPages: number;
  totalSynced: number;
  saving: number;
  startedAt: string | null;
  finishedAt: string | null;
  result: null | 'completed' | 'stopped' | 'failed';
  error: string | null;
  elapsedSeconds: number;
  logs: { at: string; line: string }[];
}
interface AutoState {
  at: string | null;
  error: string | null;
  running: boolean;
  enabled: boolean;
  intervalMs: number;
}

function clock(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Read-only state of the periodic sync; its schedule is edited in Settings. */
function AutoRows() {
  const { t } = useI18n();
  const [auto, setAuto] = useState<{ posts: AutoState; comments: AutoState } | null>(null);
  const load = () => api.get('/sync/auto-status', { quiet: true }).then((r) => setAuto(r.data)).catch(() => {});
  useEffect(() => void load(), []);
  useEvent([Ev.AutoSyncFinished, Ev.ConfigReloaded], () => void load());
  if (!auto) return null;
  return (
    <>
      {(['posts', 'comments'] as const).map((k) => {
        const a = auto[k];
        const every = Math.round(a.intervalMs / 60000);
        return (
          <div key={k} className="line" style={{ padding: '14px 0' }}>
            <span className="line-text">
              <span className="line-title">{k === 'posts' ? t('Bài viết', 'Threads') : t('Bình luận', 'Comments')}</span>
              <span className="line-sub">
                {a.at ? t(`Lần gần nhất ${fmtAgo(a.at)}`, `Last run ${fmtAgo(a.at)}`) : t('Chưa chạy lần nào', 'Not run yet')}
                {a.enabled && t(` · mỗi ${every} phút`, ` · every ${every} min`)}
              </span>
            </span>
            {a.running ? (
              <Status tone="acc">{t('Đang chạy', 'Running')}</Status>
            ) : a.error ? (
              <Status tone="bad">{t('Lần gần nhất lỗi', 'Last run failed')}</Status>
            ) : a.enabled ? (
              <Status tone="ok">{t('Đang bật', 'On')}</Status>
            ) : (
              <Status tone="off">{t('Đang tắt', 'Off')}</Status>
            )}
          </div>
        );
      })}
      <p className="section-sub" style={{ paddingTop: 10 }}>
        {t('Đổi chu kỳ và số trang trong ', 'Change the schedule and pages in ')}
        <Link to="/cai-dat#sync" className="link-btn">
          {t('Cài đặt › Đồng bộ tự động', 'Settings › Auto-sync')}
        </Link>
        .
      </p>
    </>
  );
}

function Inner() {
  const { t } = useI18n();
  const [forums, setForums] = useState<{ id: number; name: string }[]>([]);
  const [type, setType] = useState<'posts' | 'comments'>('posts');
  const [allPages, setAllPages] = useState(false);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(3);
  const [batchSize, setBatchSize] = useState(100);
  const [picked, setPicked] = useState<number[]>([]);
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [logs, setLogs] = useState<{ at: string; line: string }[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get('/systems/config', { quiet: true }).then((r) => setForums(r.data.source.forums)).catch(() => {});
    api.get<SyncStatus>('/manual-syncs/status', { quiet: true }).then((r) => {
      setSt(r.data);
      setLogs(r.data.logs);
    });
  }, []);

  // local clock so elapsed time moves between progress events
  useEffect(() => {
    if (!st?.running) return;
    const h = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, [st?.running]);

  const onStatus = (s: SyncStatus) => {
    setSt(s);
    setLogs((old) => {
      const seen = new Set(old.map((l) => l.at + l.line));
      return [...old, ...s.logs.filter((l) => !seen.has(l.at + l.line))].slice(-300);
    });
  };
  useEvent([Ev.ManualSyncProgress, Ev.ManualSyncComplete, Ev.ManualSyncFailed], (m) => onStatus(m.data));
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<SyncStatus>('/manual-syncs/start', { type, allPages, pageFrom, pageTo, batchSize, forums: picked }, { quiet: true });
      setLogs([]);
      onStatus(r.data);
    } catch (err) {
      setError((err as ApiErr).message);
    }
  };
  const stop = async () => {
    const r = await api.post<SyncStatus>('/manual-syncs/stop');
    onStatus(r.data);
  };

  const running = !!st?.running;
  const elapsed = st?.startedAt ? (running ? Math.round((Date.now() - Date.parse(st.startedAt)) / 1000) : st.elapsedSeconds) : 0;
  void tick;
  const o = st?.options;
  const runScope = o
    ? [
        st?.forumName || (o.forums.length ? t(`${o.forums.length} chuyên mục`, `${o.forums.length} sections`) : t('Mọi chuyên mục', 'All sections')),
        o.allPages ? t('tất cả các trang', 'every page') : t(`trang ${o.pageFrom}–${o.pageTo}`, `pages ${o.pageFrom}–${o.pageTo}`),
      ].join(' · ')
    : '';

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Đồng bộ', 'Sync')}</h1>
        <p className="page-lede">
          {t('Tự động quét trang mới nhất theo chu kỳ, hoặc kéo một khoảng trang cụ thể.', 'Scans the newest pages on a schedule, or pulls a specific range of pages on demand.')}
        </p>
      </header>

      <div className="cols">
        <div className="col-main">
          <h2 className="section-title" style={{ paddingBottom: 6 }}>
            {t('Tự động', 'Automatic')}
          </h2>
          <AutoRows />

          <h2 className="section-title" style={{ padding: '28px 0 12px' }}>
            {t('Thủ công', 'Manual')}
          </h2>
          <form onSubmit={start} className="stack" style={{ gap: 16, alignItems: 'flex-start' }}>
            <div className="seg" role="group" aria-label={t('Loại dữ liệu', 'Data type')}>
              <button type="button" className={type === 'posts' ? 'on' : ''} aria-pressed={type === 'posts'} onClick={() => setType('posts')} disabled={running}>
                {t('Bài viết', 'Threads')}
              </button>
              <button type="button" className={type === 'comments' ? 'on' : ''} aria-pressed={type === 'comments'} onClick={() => setType('comments')} disabled={running}>
                {t('Bình luận', 'Comments')}
              </button>
            </div>
            <div className="hstack" style={{ gap: 16, alignItems: 'flex-end' }}>
              {!allPages && (
                <>
                  <label className="field" style={{ width: 110 }}>
                    <span>{t('Từ trang', 'From page')}</span>
                    <input className="input" type="number" min={1} value={pageFrom} onChange={(e) => setPageFrom(Number(e.target.value))} disabled={running} />
                  </label>
                  <label className="field" style={{ width: 110 }}>
                    <span>{t('Đến trang', 'To page')}</span>
                    <input className="input" type="number" min={1} value={pageTo} onChange={(e) => setPageTo(Number(e.target.value))} disabled={running} />
                  </label>
                </>
              )}
              <label className="field" style={{ width: 150 }}>
                <span>{t('Bản ghi mỗi lần lưu', 'Records per save')}</span>
                <input className="input" type="number" min={1} max={5000} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} disabled={running} />
              </label>
              <label className="check" style={{ height: 40 }}>
                <input type="checkbox" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} disabled={running} />
                {type === 'posts' ? t('Tất cả các trang', 'Every page') : t('Mọi bài đã có trong kho', 'Every thread in the archive')}
              </label>
            </div>
            {type === 'comments' && !allPages && (
              <p className="section-sub">
                {t('Lấy các bài nằm trong khoảng trang này của chuyên mục, rồi tải toàn bộ bình luận của từng bài.', 'Takes the threads on these section pages, then pulls every comment of each.')}
              </p>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <span style={{ fontSize: 13 }}>
                {t('Chuyên mục', 'Sections')} <span className="muted">{t('(không chọn là tất cả)', '(none selected means all)')}</span>
              </span>
              <div className="chips">
                {forums.map((f) => {
                  const on = picked.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      disabled={running}
                      onClick={() => setPicked((p) => (on ? p.filter((x) => x !== f.id) : [...p, f.id]))}
                    >
                      {f.name}
                    </button>
                  );
                })}
              </div>
            </div>
            {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
            {!running ? (
              <button className="btn btn-primary btn-lg">{t('Bắt đầu đồng bộ', 'Start sync')}</button>
            ) : (
              <button type="button" className="btn btn-lg" style={{ color: 'var(--bad-ink)' }} onClick={() => void stop()} disabled={st?.stopRequested}>
                {st?.stopRequested ? t('Đang dừng…', 'Stopping…') : t('Dừng đồng bộ', 'Stop sync')}
              </button>
            )}
          </form>
        </div>

        <section className="col-side" style={{ gap: 4 }} aria-live="polite">
          <h2 className="section-title">{running ? t('Đang chạy', 'Running') : t('Lần thủ công gần nhất', 'Last manual run')}</h2>
          {!st?.startedAt ? (
            <p className="section-sub">{t('Chưa chạy lần nào kể từ khi khởi động máy chủ.', 'Not run since the server started.')}</p>
          ) : (
            <>
              <p className="section-sub">{runScope}</p>
              <div className="figures" style={{ padding: '14px 0 10px' }}>
                <div className="figure">
                  <span className="num">{fmtNum(st.totalSynced)}</span>
                  <span>{t('bản ghi', 'records')}</span>
                </div>
                <div className="figure">
                  <span className="num">{clock(elapsed)}</span>
                  <span>{t('thời gian chạy', 'elapsed')}</span>
                </div>
              </div>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${st.totalPages ? (100 * st.currentPage) / st.totalPages : !running && st.result === 'completed' ? 100 : 0}%` }} />
              </div>
              <div style={{ padding: '10px 0 16px', fontSize: 13 }}>
                {running ? (
                  <Status tone="acc">
                    {st.type === 'posts'
                      ? t(`Trang ${st.currentPage}${st.totalPages ? ` / ${st.totalPages}` : ''}`, `Page ${st.currentPage}${st.totalPages ? ` of ${st.totalPages}` : ''}`)
                      : t(`Bài ${st.currentPage}${st.totalPages ? ` / ${st.totalPages}` : ''}`, `Thread ${st.currentPage}${st.totalPages ? ` of ${st.totalPages}` : ''}`)}
                    {st.saving > 0 && t(`, đang lưu ${fmtNum(st.saving)} bản ghi…`, `, saving ${fmtNum(st.saving)} records…`)}
                  </Status>
                ) : st.result === 'completed' ? (
                  <Status tone="ok">{t(`Đồng bộ xong lúc ${fmtTime(st.finishedAt)}`, `Finished at ${fmtTime(st.finishedAt)}`)}</Status>
                ) : st.result === 'stopped' ? (
                  <Status tone="off">{t('Đã dừng theo yêu cầu.', 'Stopped on request.')}</Status>
                ) : st.result === 'failed' ? (
                  <Status tone="bad">{`${t('Đồng bộ lỗi:', 'Sync failed:')} ${st.error}`}</Status>
                ) : null}
              </div>
              <div className="log" ref={logRef} role="log" aria-label={t('Nhật ký chạy', 'Run log')}>
                {logs.length === 0 && <span style={{ color: '#9a9db5' }}>{t('Chưa có dòng nào.', 'No lines yet.')}</span>}
                {logs.map((l, i) => (
                  <div key={i}>
                    <time>{new Date(l.at).toLocaleTimeString()}</time>
                    {l.line}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function ManualSyncPage() {
  const { t } = useI18n();
  return (
    <SudoGate title={t('Đồng bộ', 'Sync')}>
      <Inner />
    </SudoGate>
  );
}
