import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiErr, getSudoToken, onSudoRequired, setSudoToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Dialog, OtpInput } from './ui';

/**
 * Admin pages ask for the 2FA code again (when 2FA is on). The resulting short-lived
 * sudo token is sent with every sensitive write.
 */
let sudoUntil = 0;

export function SudoGate({ children, title }: { children: ReactNode; title: string }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [ok, setOk] = useState(() => !user?.twoFactorEnabled || (!!getSudoToken() && Date.now() < sudoUntil));
  /** The re-check ran out while the page was open: ask again over the page, so unsaved edits stay. */
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onSudoRequired(() => {
        sudoUntil = 0;
        setCode('');
        setExpired(true);
      }),
    [],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ sudoToken: string | null; expiresInSeconds?: number }>('/auth/2fa/verify-code', { code }, { quiet: true });
      setSudoToken(r.data.sudoToken);
      sudoUntil = Date.now() + (r.data.expiresInSeconds ?? 900) * 1000 - 30_000;
      setOk(true);
      setExpired(false);
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 320, alignItems: 'flex-start' }}>
      <div className="field">
        <span>{t('Mã 6 số', '6-digit code')}</span>
        <OtpInput value={code} onChange={setCode} label={t('Mã 6 số', '6-digit code')} autoFocus />
      </div>
      {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
      <button className="btn btn-primary btn-lg" disabled={busy || code.length !== 6}>
        {t('Xác nhận', 'Verify')}
      </button>
    </form>
  );

  if (ok)
    return (
      <>
        {children}
        {expired && (
          <Dialog title={t('Nhập lại mã xác thực', 'Enter your code again')} onClose={() => setExpired(false)}>
            <p>{t('Lần xác thực 2 lớp trước đã hết hạn. Nhập mã rồi thử lại thao tác vừa rồi.', 'Your last two-factor check has expired. Enter your code, then try that action again.')}</p>
            {form}
          </Dialog>
        )}
      </>
    );

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">
          {t('Trang này thay đổi cách Glean hoạt động. Nhập mã xác thực 2 lớp để tiếp tục.', 'This page changes how Glean runs. Enter your two-factor code to continue.')}
        </p>
      </header>
      {form}
    </div>
  );
}
