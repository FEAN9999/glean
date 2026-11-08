import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent } from '../lib/realtime';
import { fmtNum } from '../lib/format';
import { SudoGate } from '../components/SudoGate';

interface Status {
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

function clock(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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
  const [st, setSt] = useState<Status | null>(null);
  const [logs, setLogs] = useState<{ at: string; line: string }[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get('/systems/config', { quiet: true }).then((r) => setForums(r.data.source.forums)).catch(() => {});
    api.get<Status>('/manual-syncs/status', { quiet: true }).then((r) => {
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

  const onStatus = (s: Status) => {
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
      const r = await api.post<Status>('/manual-syncs/start', { type, allPages, pageFrom, pageTo, batchSize, forums: picked }, { quiet: true });
      setLogs([]);
      onStatus(r.data);
    } catch (err) {
      setError((err as ApiErr).message);
    }
  };
  const stop = async () => {
    const r = await api.post<Status>('/manual-syncs/stop');
    onStatus(r.data);
  };

  const running = !!st?.running;
  const elapsed = st?.startedAt ? (running ? Math.round((Date.now() - Date.parse(st.startedAt)) / 1000) : st.elapsedSeconds) : 0;
  void tick;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Đồng bộ thủ công', 'Manual sync')}</h1>
        <p className="page-lede">
          {t(
            'Dùng khi muốn kéo về một khoảng trang cụ thể, hoặc nạp lại toàn bộ một chuyên mục. Đồng bộ tự động vẫn chạy song song cho loại dữ liệu còn lại.',
            'Use this to pull a specific range of pages, or reload a whole section. Auto-sync keeps running for the other data type.',
          )}
        </p>
      </header>

      <div className="grid-2">
        <form onSubmit={start} className="stack">
          <div className="seg" aria-label={t('Loại dữ liệu', 'Data type')}>
            <button type="button" className={type === 'posts' ? 'on' : ''} onClick={() => setType('posts')} disabled={running}>
              {t('Bài viết', 'Threads')}
            </button>
            <button type="button" className={type === 'comments' ? 'on' : ''} onClick={() => setType('comments')} disabled={running}>
              {t('Bình luận', 'Comments')}
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} disabled={running} />
            {type === 'posts' ? t('Tất cả các trang của chuyên mục', 'Every page of the section') : t('Mọi bài đã có trong kho', 'Every thread already in the archive')}
          </label>
          {!allPages && (
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              <label className="field">
                <span>{t('Từ trang', 'From page')}</span>
                <input className="input" type="number" min={1} value={pageFrom} onChange={(e) => setPageFrom(Number(e.target.value))} disabled={running} />
              </label>
              <label className="field">
                <span>{t('Đến trang', 'To page')}</span>
                <input className="input" type="number" min={1} value={pageTo} onChange={(e) => setPageTo(Number(e.target.value))} disabled={running} />
              </label>
            </div>
          )}
          {type === 'comments' && !allPages && (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              {t('Lấy các bài nằm trong khoảng trang này của chuyên mục, rồi tải toàn bộ bình luận của từng bài.', 'Takes the threads on these section pages, then pulls every comment of each.')}
            </p>
          )}
          <label className="field">
            <span>{t('Số bản ghi mỗi lần lưu', 'Records per save')}</span>
            <input className="input" type="number" min={1} max={5000} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} disabled={running} style={{ maxWidth: 180 }} />
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={running}>
            <legend style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 6 }}>{t('Chuyên mục (để trống là tất cả)', 'Sections (none selected means all)')}</legend>
            <div className="stack" style={{ gap: 6 }}>
              {forums.map((f) => (
                <label key={f.id} className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(f.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.id] : p.filter((x) => x !== f.id)))}
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p className="error-text">{error}</p>}
          <div className="hstack">
            {!running ? (
              <button className="btn btn-primary">{t('Bắt đầu đồng bộ', 'Start sync')}</button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={st?.stopRequested}>
                {st?.stopRequested ? t('Đang dừng…', 'Stopping…') : t('Dừng đồng bộ', 'Stop sync')}
              </button>
            )}
          </div>
        </form>

        <section aria-live="polite">
          <h2 className="section-title">{running ? t('Đang chạy', 'Running') : t('Lần gần nhất', 'Last run')}</h2>
          {!st?.startedAt ? (
            <p className="muted">{t('Chưa chạy lần nào kể từ khi khởi động máy chủ.', 'Not run since the server started.')}</p>
          ) : (
            <div className="stack">
              <div className="figures">
                <div className="figure">
                  <span className="num">{fmtNum(st.totalSynced)}</span>
                  <span>{t('bản ghi đã đồng bộ', 'records synced')}</span>
                </div>
                <div className="figure">
                  <span className="num">{clock(elapsed)}</span>
                  <span>{t('thời gian chạy', 'elapsed')}</span>
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 500 }}>{st.forumName || '—'}</div>
                <div className="muted" style={{ fontSize: 14 }}>
                  {st.type === 'posts'
                    ? t(`Trang ${st.currentPage}${st.totalPages ? ` / ${st.totalPages}` : ''}`, `Page ${st.currentPage}${st.totalPages ? ` of ${st.totalPages}` : ''}`)
                    : t(`Bài ${st.currentPage}${st.totalPages ? ` / ${st.totalPages}` : ''}`, `Thread ${st.currentPage}${st.totalPages ? ` of ${st.totalPages}` : ''}`)}
                  {running && st.saving > 0 && t(`, đang lưu ${fmtNum(st.saving)} bản ghi…`, `, saving ${fmtNum(st.saving)} records…`)}
                </div>
                {st.totalPages > 0 && (
                  <div className="bar" style={{ marginTop: 8 }}>
                    <span style={{ width: `${(100 * st.currentPage) / st.totalPages}%` }} />
                  </div>
                )}
              </div>
              {!running && st.result && (
                <div className={`notice ${st.result === 'failed' ? 'notice-rust' : st.result === 'completed' ? 'notice-moss' : ''}`}>
                  {st.result === 'completed'
                    ? t('Đồng bộ xong.', 'Sync finished.')
                    : st.result === 'stopped'
                      ? t('Đã dừng theo yêu cầu.', 'Stopped on request.')
                      : `${t('Đồng bộ lỗi:', 'Sync failed:')} ${st.error}`}
                </div>
              )}
              <div className="log" ref={logRef} role="log" aria-label={t('Nhật ký chạy', 'Run log')}>
                {logs.length === 0 && <span style={{ color: '#7f8aa3' }}>{t('Chưa có dòng nào.', 'No lines yet.')}</span>}
                {logs.map((l, i) => (
                  <div key={i}>
                    <time>{new Date(l.at).toLocaleTimeString()}</time>
                    {l.line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function ManualSyncPage() {
  const { t } = useI18n();
  return (
    <SudoGate title={t('Đồng bộ thủ công', 'Manual sync')}>
      <Inner />
    </SudoGate>
  );
}
