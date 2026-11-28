import { useCallback, useEffect, useState } from 'react';
import { api, ApiErr } from '../lib/api';
import { unpack, useI18n } from '../lib/i18n';
import { fmtAgo, fmtBytes, fmtDate, fmtNum } from '../lib/format';
import { useSites } from '../lib/site';
import { SudoGate } from '../components/SudoGate';
import { Status, Switch, useUi } from '../components/ui';
import type { BackupRun, backupStatus } from '../../../server/backup';
import type { AppConfig } from '../../../server/config';

type AutoStatus = ReturnType<typeof backupStatus>;
type SiteStatus = AutoStatus['sites'][number];
type BackupCfg = AppConfig['backup'];

/** The backup state of a site other than the main one: last success, last error, next run. */
function SiteBackupRow({ s, enabled }: { s: SiteStatus; enabled: boolean }) {
  const { t, lang } = useI18n();
  const next = !enabled
    ? t('Tự động đang tắt', 'Automatic backup is off')
    : s.nextDueAt
      ? t(`Lần tới khoảng ${fmtDate(s.nextDueAt)}`, `Next run around ${fmtDate(s.nextDueAt)}`)
      : t('Lần tới trong vài phút', 'Next run within minutes');
  return (
    <li className="row">
      <span className="row-title">{s.name}</span>
      <div className="row-meta">
        <span>{s.lastSuccessAt ? t(`Thành công gần nhất ${fmtAgo(s.lastSuccessAt)}`, `Last success ${fmtAgo(s.lastSuccessAt)}`) : t('Chưa sao lưu thành công lần nào', 'No successful backup yet')}</span>
        <span>{next}</span>
      </div>
      {s.last?.error && (
        <p className="error-text" style={{ margin: 0, fontSize: 12.5 }}>
          {t(`Lỗi gần nhất (${fmtAgo(s.last.finishedAt)}): `, `Last error (${fmtAgo(s.last.finishedAt)}): `) + unpack(s.last.error, lang)}
        </p>
      )}
    </li>
  );
}

/** Scheduled backups: last run, next run, settings and "back up now". */
function AutoBackup({ st, reload }: { st: AutoStatus | null; reload: () => void }) {
  const { t, lang } = useI18n();
  const { toast } = useUi();
  const { sites, nameOf } = useSites();
  const [form, setForm] = useState<BackupCfg | null>(null);
  const [saved, setSaved] = useState<BackupCfg | null>(null);
  const [busy, setBusy] = useState<'run' | 'save' | null>(null);
  const [error, setError] = useState('');
  // This page also opens with every site chosen. The backup settings are shared, so read and save
  // them through the main site: with `*` the server saves them but cannot send the settings back.
  const mainCode = sites.find((s) => s.isMain)?.code;

  useEffect(() => {
    api
      .get<AppConfig>('/systems/config', { quiet: true, site: mainCode })
      .then((r) => {
        setForm(r.data.backup);
        setSaved(r.data.backup);
      })
      .catch((err) => setError((err as ApiErr).message));
  }, [mainCode]);

  const runNow = async () => {
    setBusy('run');
    setError('');
    try {
      const r = await api.post<BackupRun>('/backups/run', {}, { quiet: true });
      // One run per store: name each site whose copy failed, not only the main one.
      const runs = (r.runs as BackupRun[] | undefined) ?? [r.data];
      const failed = runs.filter((x) => x.error);
      if (!failed.length) toast(t(`Đã sao lưu vào ${r.data.file}.`, `Backed up to ${r.data.file}.`));
      else if (runs.length === 1) setError(unpack(failed[0].error!, lang));
      else
        setError(
          failed
            .map((x) => {
              const site = nameOf(x.siteCode ?? mainCode ?? '');
              return t(`Trang ${site} sao lưu lỗi: `, `Backup of the site ${site} failed: `) + unpack(x.error!, lang);
            })
            .join('\n'),
        );
      reload();
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
      const r = await api.put<AppConfig>('/systems/config', { backup: form }, { quiet: true, site: mainCode });
      setForm(r.data.backup);
      setSaved(r.data.backup);
      toast(t('Đã lưu cài đặt sao lưu.', 'Backup settings saved.'));
      reload();
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
      ? (['bad', t(`Lần gần nhất lỗi (${fmtAgo(last.finishedAt)}): `, `Last run failed (${fmtAgo(last.finishedAt)}): `) + unpack(last.error, lang)] as const)
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
          {!!st?.sites.length && mainCode && <span className="row-title">{nameOf(mainCode)}</span>}
          <Status tone={tone}>{text}</Status>
          <small className="muted" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
            {next} {st && t(`Thư mục: ${st.dir}`, `Folder: ${st.dir}`)}
          </small>
          {!st?.running && !last?.error && last?.mediaError && (
            <p className="error-text" role="alert" style={{ margin: 0, fontSize: 12.5 }}>
              {t('Kho dữ liệu đã sao lưu, nhưng ', 'The database was backed up, but ') + unpack(last.mediaError, lang)}
            </p>
          )}
        </div>
        {!!st?.sites.length && (
          <div className="stack" style={{ gap: 0 }}>
            <ul className="rows" aria-label={t('Sao lưu của các trang khác', 'Backups of the other sites')}>
              {st.sites.map((s) => (
                <SiteBackupRow key={s.code} s={s} enabled={!!saved?.enabled} />
              ))}
            </ul>
            <small className="muted" style={{ fontSize: 12.5, paddingTop: 8 }}>
              {t('Bản sao của mỗi trang khác nằm trong thư mục con sites/<mã trang>/ của thư mục sao lưu.', "Each other site's copies go in the subfolder sites/<site code>/ of the backup folder.")}
            </small>
          </div>
        )}
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
          <p className="error-text" role="alert" style={{ margin: 0, whiteSpace: 'pre-line' }}>
            {error}
          </p>
        )}
      </div>
    </>
  );
}

function Inner() {
  const { t } = useI18n();
  const [st, setSt] = useState<AutoStatus | null>(null);
  const loadStatus = useCallback(() => {
    api.get<AutoStatus>('/backups/status', { quiet: true }).then((r) => setSt(r.data)).catch(() => {});
  }, []);
  useEffect(loadStatus, [loadStatus]);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Sao lưu', 'Backup')}</h1>
        <p className="page-lede">
          {t(
            'Glean chép kho dữ liệu theo lịch, kèm ảnh và video khi bạn chọn thư mục sao lưu. "Sao lưu ngay" chép ngay một bản.',
            'Glean copies the archive on a schedule, with media when you choose a backup folder. "Back up now" makes a copy straight away.',
          )}
        </p>
      </header>

      <div className="cols">
        <div className="col-main">
          <AutoBackup st={st} reload={loadStatus} />
        </div>

        <aside className="col-side" style={{ gap: 4 }}>
          <h2 className="section-title" style={{ paddingBottom: 2 }}>
            {t('Các tệp sao lưu', 'Backup files')}
          </h2>
          {st && !st.files.length && <p className="section-sub">{t('Chưa có tệp sao lưu nào.', 'No backup files yet.')}</p>}
          {st?.files.map((b) => (
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
