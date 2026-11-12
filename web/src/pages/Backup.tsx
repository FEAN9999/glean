import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtBytes, fmtDate, fmtNum } from '../lib/format';
import { SudoGate } from '../components/SudoGate';
import { useUi } from '../components/ui';

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
            'Chép kho sang một tệp cơ sở dữ liệu khác. Ảnh nằm trong thư mục lưu trữ, cần chép riêng.',
            'Copy the archive into another database file. Images live in the storage folder and need copying separately.',
          )}
        </p>
      </header>

      <div className="cols">
        <div className="col-main">
          <h2 className="section-title" style={{ paddingBottom: 10 }}>
            {t('Sao lưu toàn bộ', 'Full backup')}
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
