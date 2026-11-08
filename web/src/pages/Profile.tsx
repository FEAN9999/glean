import { useState, type FormEvent } from 'react';
import { api, ApiErr, setSession, getSession } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { useTheme } from '../components/Shell';
import { useUi } from '../components/ui';

function PasswordForm() {
  const { t } = useI18n();
  const { toast } = useUi();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== again) return setError(t('Hai mật khẩu mới chưa khớp nhau.', 'The new passwords do not match.'));
    setBusy(true);
    try {
      const r = await api.put('/accounts/change-password', { currentPassword: cur, newPassword: next }, { quiet: true });
      setSession({ accessToken: r.data.accessToken, refreshToken: r.data.refreshToken, userId: r.data.userId });
      setCur('');
      setNext('');
      setAgain('');
      toast(t('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.', 'Password changed. Other devices were signed out.'));
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 380 }}>
      <label className="field">
        <span>{t('Mật khẩu hiện tại', 'Current password')}</span>
        <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>{t('Mật khẩu mới', 'New password')}</span>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      <label className="field">
        <span>{t('Nhập lại mật khẩu mới', 'Repeat new password')}</span>
        <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div>
        <button className="btn btn-primary" disabled={busy}>
          {t('Đổi mật khẩu', 'Change password')}
        </button>
      </div>
    </form>
  );
}

function TwoFactor() {
  const { t } = useI18n();
  const { toast } = useUi();
  const { user, reloadUser } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [disabling, setDisabling] = useState(false);

  const begin = async () => {
    setError('');
    const r = await api.post('/auth/2fa/setup');
    setSetup(r.data);
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/2fa/enable', { code }, { quiet: true });
      setSetup(null);
      setCode('');
      await reloadUser();
      toast(t('Đã bật xác thực 2 lớp.', 'Two-factor authentication is on.'));
    } catch (err) {
      setError((err as ApiErr).message);
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/2fa/disable', { code }, { quiet: true });
      setDisabling(false);
      setCode('');
      await reloadUser();
      toast(t('Đã tắt xác thực 2 lớp.', 'Two-factor authentication is off.'));
    } catch (err) {
      setError((err as ApiErr).message);
    }
  };

  const codeInput = (
    <label className="field" style={{ maxWidth: 220 }}>
      <span>{t('Mã 6 số từ ứng dụng', '6-digit code from the app')}</span>
      <input
        className="input num"
        style={{ fontSize: 20, letterSpacing: '0.25em' }}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        required
        autoFocus
      />
    </label>
  );

  if (user?.twoFactorEnabled) {
    return (
      <div className="stack">
        <div className="notice notice-moss">{t('Xác thực 2 lớp đang bật. Đăng nhập và các trang quản trị sẽ hỏi mã.', 'Two-factor is on. Sign-in and admin pages ask for a code.')}</div>
        {!disabling ? (
          <div>
            <button className="btn btn-danger" onClick={() => setDisabling(true)}>
              {t('Tắt xác thực 2 lớp', 'Turn off two-factor')}
            </button>
          </div>
        ) : (
          <form onSubmit={disable} className="stack">
            {codeInput}
            {error && <p className="error-text">{error}</p>}
            <div className="hstack">
              <button className="btn btn-danger">{t('Xác nhận tắt', 'Confirm turning off')}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setDisabling(false)}>
                {t('Hủy', 'Cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  if (!setup)
    return (
      <div className="stack">
        <p className="muted" style={{ margin: 0, maxWidth: '60ch' }}>
          {t(
            'Thêm một lớp bảo vệ bằng ứng dụng như Google Authenticator, Aegis hoặc 1Password. Sau khi bật, đăng nhập và các trang cài đặt, đồng bộ, sao lưu sẽ hỏi mã.',
            'Add a second layer with an app such as Google Authenticator, Aegis or 1Password. Once on, sign-in and the settings, sync and backup pages ask for a code.',
          )}
        </p>
        <div>
          <button className="btn btn-primary" onClick={() => void begin()}>
            {t('Bật xác thực 2 lớp', 'Turn on two-factor')}
          </button>
        </div>
      </div>
    );

  return (
    <form onSubmit={enable} className="stack">
      <div className="hstack" style={{ alignItems: 'flex-start', gap: 24 }}>
        <img src={setup.qrDataUrl} width={180} height={180} alt={t('Mã QR để quét bằng ứng dụng xác thực', 'QR code to scan with your authenticator app')} style={{ borderRadius: 10, background: '#fff', padding: 6 }} />
        <div className="stack" style={{ gap: 8, maxWidth: 360 }}>
          <span>{t('1. Quét mã QR bằng ứng dụng xác thực.', '1. Scan the QR code with your authenticator app.')}</span>
          <span className="muted" style={{ fontSize: 14 }}>
            {t('Không quét được? Nhập khóa này thủ công:', 'Cannot scan? Enter this key manually:')}
          </span>
          <code className="num" style={{ wordBreak: 'break-all', background: 'var(--sheet-2)', padding: '6px 10px', borderRadius: 8, fontSize: 14 }}>
            {setup.secret.match(/.{1,4}/g)?.join(' ')}
          </code>
          <span>{t('2. Nhập mã 6 số ứng dụng hiển thị.', '2. Enter the 6-digit code it shows.')}</span>
        </div>
      </div>
      {codeInput}
      {error && <p className="error-text">{error}</p>}
      <div className="hstack">
        <button className="btn btn-primary" disabled={code.length !== 6}>
          {t('Bật xác thực 2 lớp', 'Turn on two-factor')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>
          {t('Hủy', 'Cancel')}
        </button>
      </div>
    </form>
  );
}

export function ProfilePage() {
  const { t, lang, setLang } = useI18n();
  const { user } = useAuth();
  const [theme, setTheme] = useTheme();
  void getSession;
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Hồ sơ & bảo mật', 'Profile & security')}</h1>
        {user && (
          <p className="page-lede">
            {t(`Đăng nhập với tên ${user.username}, tạo ngày ${fmtDate(user.createdAt, false)}.`, `Signed in as ${user.username}, created ${fmtDate(user.createdAt, false)}.`)}
          </p>
        )}
      </header>

      <section>
        <h2 className="section-title">{t('Xác thực 2 lớp', 'Two-factor authentication')}</h2>
        <TwoFactor />
      </section>

      <section className="section">
        <h2 className="section-title">{t('Mật khẩu', 'Password')}</h2>
        <PasswordForm />
      </section>

      <section className="section">
        <h2 className="section-title">{t('Hiển thị', 'Display')}</h2>
        <div className="stack">
          <div className="hstack">
            <span style={{ minWidth: 100 }}>{t('Ngôn ngữ', 'Language')}</span>
            <div className="seg">
              <button className={lang === 'vi-VN' ? 'on' : ''} onClick={() => setLang('vi-VN')}>
                Tiếng Việt
              </button>
              <button className={lang === 'en-US' ? 'on' : ''} onClick={() => setLang('en-US')}>
                English
              </button>
            </div>
          </div>
          <div className="hstack">
            <span style={{ minWidth: 100 }}>{t('Giao diện', 'Theme')}</span>
            <div className="seg">
              {(
                [
                  ['auto', t('Theo máy', 'System')],
                  ['light', t('Sáng', 'Light')],
                  ['dark', t('Tối', 'Dark')],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={theme === k ? 'on' : ''} onClick={() => setTheme(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
