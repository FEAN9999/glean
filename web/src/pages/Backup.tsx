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
  const [target, setTarget] = useState(() => `sang-${new Date().toISOString().slice(0, 10)}.db`);
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
            'Chép toàn bộ kho, hoặc từng bảng, sang một tệp cơ sở dữ liệu khác để cất giữ hay chuyển sang máy mới. Ảnh nằm trong thư mục lưu trữ, cần chép riêng.',
            'Copy the whole archive, or single tables, into another database file to keep or move to a new machine. Images live in the storage folder and need copying separately.',
          )}
        </p>
      </header>

      <div className="stack" style={{ maxWidth: 560 }}>
        <label className="field">
          <span>{t('Tệp đích', 'Target file')}</span>
          <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} />
          <small>{data ? t(`Lưu trong ${data.backupDir}`, `Saved in ${data.backupDir}`) : ''}</small>
        </label>
        <div className="hstack">
          <button className="btn btn-primary" onClick={() => void full()} disabled={!!busy}>
            {busy === 'full' ? t('Đang sao lưu…', 'Backing up…') : t('Sao lưu toàn bộ', 'Back up everything')}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>

      <section className="section">
        <h2 className="section-title">{t('Chép từng bảng', 'Copy single tables')}</h2>
        {data && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <span className="sr-only">{t('Chọn', 'Select')}</span>
                  </th>
                  <th>{t('Dữ liệu', 'Data')}</th>
                  <th>{t('Bảng', 'Table')}</th>
                  <th className="r">{t('Số dòng', 'Rows')}</th>
                </tr>
              </thead>
              <tbody>
                {data.tables.map((tb) => (
                  <tr key={tb.name}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={tb.name}
                        checked={picked.includes(tb.name)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, tb.name] : p.filter((x) => x !== tb.name)))}
                      />
                    </td>
                    <td>{t(...(TABLE_LABEL[tb.name] ?? [tb.name, tb.name]))}</td>
                    <td className="muted">{tb.name}</td>
                    <td className="r num">{fmtNum(tb.rows)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button className="btn" style={{ marginTop: 16 }} disabled={!picked.length || !!busy} onClick={() => void cloneSelected()}>
          {busy === 'tables' ? t('Đang chép…', 'Copying…') : t(`Chép ${picked.length || ''} bảng đã chọn`, `Copy ${picked.length || ''} selected tables`)}
        </button>
        {log.length > 0 && (
          <div className="log" style={{ marginTop: 16 }} role="log">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </section>

      {data && data.backups.length > 0 && (
        <section className="section">
          <h2 className="section-title">{t('Các tệp sao lưu', 'Backup files')}</h2>
          <ul className="rows">
            {data.backups.map((b) => (
              <li key={b.name} className="row" style={{ padding: '10px 0' }}>
                <div className="hstack" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 500 }}>{b.name}</span>
                  <span className="muted" style={{ fontSize: 13.5 }}>
                    {fmtBytes(b.sizeBytes)}, {fmtDate(b.modifiedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
