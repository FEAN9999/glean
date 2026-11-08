import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiErr, getSudoToken, setSudoToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

/**
 * Admin pages ask for the 2FA code again (when 2FA is on). The resulting short-lived
 * sudo token is sent with every sensitive write.
 */
let sudoUntil = 0;

export function SudoGate({ children, title }: { children: ReactNode; title: string }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [ok, setOk] = useState(() => !user?.twoFactorEnabled || (!!getSudoToken() && Date.now() < sudoUntil));
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (ok) return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/auth/2fa/verify-code', { code }, { quiet: true });
      setSudoToken(r.data.sudoToken);
      sudoUntil = Date.now() + (r.data.expiresInSeconds ?? 900) * 1000 - 30_000;
      setOk(true);
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">
          {t('Trang này thay đổi cách Sàng hoạt động. Nhập mã xác thực 2 lớp để tiếp tục.', 'This page changes how Sàng runs. Enter your two-factor code to continue.')}
        </p>
      </header>
      <form onSubmit={submit} className="stack" style={{ maxWidth: 320 }}>
        <label className="field">
          <span>{t('Mã 6 số', '6-digit code')}</span>
          <input
            className="input num"
            style={{ fontSize: 22, letterSpacing: '0.3em', height: 52 }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" disabled={busy || code.length !== 6}>
          {t('Xác nhận', 'Verify')}
        </button>
      </form>
    </div>
  );
}
