import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtAgo, fmtBytes, fmtDate, fmtNum } from '../lib/format';
import { SudoGate } from '../components/SudoGate';
import { Status, Switch, useUi } from '../components/ui';

interface BackupRun {
  id: number;
  trigger: 'auto' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  file: string | null;
  sizeBytes: number | null;
  mediaCopied: number;
  mediaBytes: number;
  mediaError: string | null;
  error: string | null;
}
interface AutoStatus {
  running: boolean;
  last: BackupRun | null;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  dir: string;
}
interface BackupCfg {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  targetDir: string;
  includeMedia: boolean;
  notifyOnFail: boolean;
}

/** Scheduled backups: last run, next run, settings and "back up now". */
function AutoBackup({ onRan }: { onRan: () => void }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const [st, setSt] = useState<AutoStatus | null>(null);
  const [form, setForm] = useState<BackupCfg | null>(null);
  const [saved, setSaved] = useState<BackupCfg | null>(null);
  const [busy, setBusy] = useState<'run' | 'save' | null>(null);
  const [error, setError] = useState('');

  const loadStatus = useCallback(() => {
    api.get<AutoStatus>('/backups/status', { quiet: true }).then((r) => setSt(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    loadStatus();
    api
      .get('/systems/config', { quiet: true })
      .then((r) => {
        setForm(r.data.backup);
        setSaved(r.data.backup);
      })
      .catch(() => {});
  }, [loadStatus]);

  const runNow = async () => {
    setBusy('run');
    setError('');
    try {
      const r = await api.post<BackupRun>('/backups/run', {}, { quiet: true });
      if (r.data.error) setError(r.data.error);
      else toast(t(`Đã sao lưu vào ${r.data.file}.`, `Backed up to ${r.data.file}.`));
      loadStatus();
      onRan();
    } catch (e) {
      setError((e as ApiErr).message);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!form) return;
    setBusy('save');
    setError('');
    try {
      const r = await api.put('/systems/config', { backup: form }, { quiet: true });
      setForm(r.data.backup);
      setSaved(r.data.backup);
      toast(t('Đã lưu cài đặt sao lưu.', 'Backup settings saved.'));
      loadStatus();
    } catch (e) {
      setError((e as ApiErr).message);
    } finally {
      setBusy(null);
    }
  };
  const set = <K extends keyof BackupCfg>(k: K, v: BackupCfg[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const last = st?.last;
  // Media is mirrored only into a folder the user chose (server/backup.ts).
  const mediaOn = !!saved?.includeMedia && !!saved?.targetDir.trim();
  const [tone, text] = st?.running
    ? (['acc', t('Đang sao lưu…', 'Backing up…')] as const)
    : last?.error
      ? (['bad', t(`Lần gần nhất lỗi (${fmtAgo(last.finishedAt)}): ${last.error}`, `Last run failed (${fmtAgo(last.finishedAt)}): ${last.error}`)] as const)
      : last?.file
        ? ([
            'ok',
            t(
              `Lần gần nhất ${fmtAgo(last.finishedAt)} · ${fmtBytes(last.sizeBytes ?? 0)}${mediaOn ? ` · chép ${fmtNum(last.mediaCopied)} ảnh mới` : ''}`,
              `Last run ${fmtAgo(last.finishedAt)} · ${fmtBytes(last.sizeBytes ?? 0)}${mediaOn ? ` · ${fmtNum(last.mediaCopied)} new media files copied` : ''}`,
            ),
          ] as const)
        : (['off', t('Chưa có bản sao lưu tự động nào', 'No automatic backup yet')] as const);
  const next = !saved?.enabled
    ? t('Sao lưu tự động đang tắt.', 'Automatic backup is off.')
    : st?.nextDueAt
      ? t(`Lượt kế tiếp khoảng ${fmtDate(st.nextDueAt)}.`, `Next run around ${fmtDate(st.nextDueAt)}.`)
      : t('Lượt kế tiếp sẽ chạy trong vài phút.', 'The next run starts within minutes.');

  return (
    <>
      <h2 className="section-title" style={{ paddingBottom: 10 }}>
        {t('Sao lưu tự động', 'Automatic backup')}
      </h2>
      <div className="rule-below stack" style={{ gap: 12, paddingBottom: 26 }}>
        <div className="stack" style={{ gap: 4 }}>
          <Status tone={tone}>{text}</Status>
          <small className="muted" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
            {next} {st && t(`Thư mục: ${st.dir}`, `Folder: ${st.dir}`)}
          </small>
          {!st?.running && !last?.error && last?.mediaError && (
            <p className="error-text" role="alert" style={{ margin: 0, fontSize: 12.5 }}>
              {t(`Kho dữ liệu đã sao lưu, nhưng ${last.mediaError}`, `The database was backed up, but media failed: ${last.mediaError}`)}
            </p>
          )}
        </div>
        {form && (
          <>
            <Switch label={t('Tự động sao lưu', 'Back up automatically')} checked={form.enabled} onChange={(v) => set('enabled', v)} />
            <div className="form-grid">
              <label className="field">
                <span>{t('Mỗi (giờ)', 'Every (hours)')}</span>
                <input className="input" type="number" min={1} value={form.intervalHours} onChange={(e) => set('intervalHours', Math.max(1, Number(e.target.value)))} />
              </label>
              <label className="field">
                <span>{t('Giữ số bản gần nhất', 'Copies to keep')}</span>
                <input className="input" type="number" min={1} value={form.keep} onChange={(e) => set('keep', Math.max(1, Number(e.target.value)))} />
              </label>
            </div>
            <label className="field">
              <span>{t('Thư mục sao lưu', 'Backup folder')}</span>
              <input className="input" value={form.targetDir} placeholder="data/backups" onChange={(e) => set('targetDir', e.target.value)} />
              <small>{t('Nên chọn thư mục ở ổ đĩa khác, ví dụ E:\\Glean-backup. Để trống = data/backups.', 'Prefer a folder on another drive, e.g. E:\\Glean-backup. Empty = data/backups.')}</small>
            </label>
            <div className="stack" style={{ gap: 4 }}>
              <Switch label={t('Chép cả ảnh và video đã tải (chỉ chép tệp mới)', 'Also copy downloaded media (new files only)')} checked={form.includeMedia} onChange={(v) => set('includeMedia', v)} />
              {form.includeMedia && !form.targetDir.trim() && (
                <small className="muted" style={{ fontSize: 12.5 }}>
                  {t('Ảnh và video chỉ được chép khi bạn chọn thư mục sao lưu ở trên (để trống thì chỉ sao lưu kho dữ liệu).', 'Media is copied only when you choose a backup folder above (empty backs up the database only).')}
                </small>
              )}
            </div>
            <Switch label={t('Báo qua Telegram khi sao lưu lỗi', 'Notify via Telegram when a backup fails')} checked={form.notifyOnFail} onChange={(v) => set('notifyOnFail', v)} />
          </>
        )}
        <div className="hstack" style={{ gap: 10 }}>
          <button className="btn" onClick={() => void save()} disabled={!dirty || !!busy}>
            {busy === 'save' ? t('Đang lưu…', 'Saving…') : t('Lưu cài đặt', 'Save settings')}
          </button>
          <button className="btn btn-primary" onClick={() => void runNow()} disabled={!!busy || !!st?.running || dirty}>
            {busy === 'run' ? t('Đang sao lưu…', 'Backing up…') : t('Sao lưu ngay', 'Back up now')}
          </button>
        </div>
        {error && (
          <p className="error-text" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </div>
    </>
  );
}

interface Tables {
  tables: { name: string; rows: number }[];
  backups: { name: string; sizeBytes: number; modifiedAt: string }[];
  backupDir: string;
}

const TABLE_LABEL: Record<string, [string, string]> = {
  app_user: ['Tài khoản', 'Account'],
  config: ['Cấu hình', 'Configuration'],
  forum: ['Chuyên mục', 'Sections'],
  thread: ['Bài viết', 'Threads'],
  comment: ['Bình luận', 'Comments'],
  search_history: ['Lịch sử tìm kiếm', 'Search history'],
  scrape: ['Lượt sàng', 'Sieve jobs'],
  scrape_image: ['Ảnh đã sàng', 'Sieved images'],
  scrape_video: ['Video đã sàng', 'Sieved videos'],
  scrape_link: ['Liên kết đã sàng', 'Sieved links'],
  scrape_comment: ['Bình luận đã sàng', 'Sieved comments'],
  sync_history: ['Nhật ký đồng bộ', 'Sync log'],
  sync_history_item: ['Chi tiết nhật ký', 'Sync log items'],
  comment_revision: ['Bản sửa bình luận', 'Comment revisions'],
  backup_run: ['Lịch sử sao lưu', 'Backup history'],
};

function Inner() {
  const { t } = useI18n();
  const { toast } = useUi();
  const [data, setData] = useState<Tables | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState(() => `glean-${new Date().toISOString().slice(0, 10)}.db`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const load = useCallback(() => {
    api.get<Tables>('/clone/tables', { quiet: true }).then((r) => setData(r.data));
  }, []);
  useEffect(load, [load]);

  const full = async () => {
    setBusy('full');
    setError('');
    try {
      const r = await api.post('/clone/execute', { mode: 'full', target }, { quiet: true });
      setLog((l) => [t(`Sao lưu toàn bộ vào ${r.data.target} (${fmtBytes(r.data.sizeBytes)}) trong ${r.data.ms} ms.`, `Full backup to ${r.data.target} (${fmtBytes(r.data.sizeBytes)}) in ${r.data.ms} ms.`), ...l]);
      toast(t('Đã sao lưu toàn bộ.', 'Full backup done.'));
      load();
    } catch (e) {
      setError((e as ApiErr).message);
    } finally {
      setBusy(null);
    }
  };

  const cloneSelected = async () => {
    setBusy('tables');
    setError('');
    try {
      for (const table of picked) {
        const r = await api.post('/clone/table', { table, target }, { quiet: true });
        setLog((l) => [t(`${r.data.table}: đã chép ${fmtNum(r.data.rows)} dòng sang ${target}`, `${r.data.table}: copied ${fmtNum(r.data.rows)} rows to ${target}`), ...l]);
      }
      toast(t(`Đã chép ${picked.length} bảng.`, `Copied ${picked.length} tables.`));
      load();
    } catch (e) {
      setError((e as ApiErr).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Sao lưu', 'Backup')}</h1>
        <p className="page-lede">
          {t(
            'Sao lưu tự động chép kho và ảnh theo lịch. Sao lưu tay bên dưới chỉ chép kho sang một tệp cơ sở dữ liệu khác, không kèm ảnh.',
            'Automatic backup copies the archive and media on a schedule. The manual backup below copies only the archive into another database file, without media.',
          )}
        </p>
      </header>

      <div className="cols">
        <div className="col-main">
          <AutoBackup onRan={load} />
          <div style={{ height: 24 }} />
          <h2 className="section-title" style={{ paddingBottom: 10 }}>
            {t('Sao lưu tay (chỉ kho)', 'Manual backup (archive only)')}
          </h2>
          <div className="rule-below stack" style={{ gap: 6, paddingBottom: 26 }}>
            <div className="hstack" style={{ gap: 10, alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 1, minWidth: 220, maxWidth: 420 }}>
                <span>{t('Tệp đích', 'Target file')}</span>
                <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} />
              </label>
              <button className="btn btn-primary btn-lg" onClick={() => void full()} disabled={!!busy || !target.trim()}>
                {busy === 'full' ? t('Đang sao lưu…', 'Backing up…') : t('Sao lưu toàn bộ', 'Back up everything')}
              </button>
            </div>
            {data && (
              <small className="muted" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {t(`Lưu trong ${data.backupDir}`, `Saved in ${data.backupDir}`)}
              </small>
            )}
            {error && (
              <p className="error-text" role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            )}
          </div>

          <div className="section-head" style={{ alignItems: 'center', padding: '24px 0 4px' }}>
            <h2 className="section-title">{t('Chép từng bảng', 'Copy single tables')}</h2>
            <button className="btn" disabled={!picked.length || !!busy || !target.trim()} onClick={() => void cloneSelected()}>
              {busy === 'tables'
                ? t('Đang chép…', 'Copying…')
                : picked.length
                  ? t(`Chép ${picked.length} bảng đã chọn`, `Copy ${picked.length} selected tables`)
                  : t('Chép bảng đã chọn', 'Copy selected tables')}
            </button>
          </div>
          {data?.tables.map((tb) => (
            <label key={tb.name} className="table-row">
              <input
                type="checkbox"
                className="cb"
                checked={picked.includes(tb.name)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, tb.name] : p.filter((x) => x !== tb.name)))}
              />
              <span style={{ fontWeight: 400 }}>{t(...(TABLE_LABEL[tb.name] ?? [tb.name, tb.name]))}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {tb.name}
              </span>
              <span className="r num">{fmtNum(tb.rows)}</span>
            </label>
          ))}
          {log.length > 0 && (
            <div className="log" style={{ marginTop: 16 }} role="log">
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </div>

        <aside className="col-side" style={{ gap: 4 }}>
          <h2 className="section-title" style={{ paddingBottom: 2 }}>
            {t('Các tệp sao lưu', 'Backup files')}
          </h2>
          {data && !data.backups.length && <p className="section-sub">{t('Chưa có tệp sao lưu nào.', 'No backup files yet.')}</p>}
          {data?.backups.map((b) => (
            <div key={b.name} className="line" style={{ padding: '10px 0' }}>
              <span className="line-text">
                <span className="line-title ellipsis">{b.name}</span>
                <span className="line-sub">{fmtDate(b.modifiedAt)}</span>
              </span>
              <span className="line-value">{fmtBytes(b.sizeBytes)}</span>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
export function BackupPage() {
  const { t } = useI18n();
  return (
    <SudoGate title={t('Sao lưu', 'Backup')}>
      <Inner />
    </SudoGate>
  );
}
