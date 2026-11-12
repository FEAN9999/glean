import { useState, type FormEvent } from 'react';
import { api, ApiErr, setSession, getSession } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { useTheme } from '../components/Shell';
import { OtpInput, useUi } from '../components/ui';

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
    <form onSubmit={submit} className="stack" style={{ maxWidth: 360 }}>
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
      {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
      <div>
        <button className="btn" disabled={busy}>
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
    <div className="stack" style={{ gap: 10 }}>
      <span style={{ fontSize: 13 }}>{t('Mã 6 số từ ứng dụng', '6-digit code from the app')}</span>
      <OtpInput value={code} onChange={setCode} label={t('Mã 6 số từ ứng dụng', '6-digit code from the app')} autoFocus />
    </div>
  );
  const intro = (
    <p className="muted" style={{ margin: 0, padding: '4px 0 14px', maxWidth: '60ch' }}>
      {t(
        'Thêm một lớp bảo vệ bằng ứng dụng như Google Authenticator, Aegis hoặc 1Password. Sau khi bật, đăng nhập và các trang Đồng bộ, Cài đặt, Sao lưu sẽ hỏi mã.',
        'Add a second layer with an app such as Google Authenticator, Aegis or 1Password. Once on, sign-in and the Sync, Settings and Backup pages ask for a code.',
      )}
    </p>
  );

  if (user?.twoFactorEnabled) {
    return (
      <div className="stack" style={{ gap: 16, paddingTop: 10 }}>
        <div className="notice notice-moss">{t('Xác thực 2 lớp đang bật. Đăng nhập và các trang quản trị sẽ hỏi mã.', 'Two-factor is on. Sign-in and admin pages ask for a code.')}</div>
        {!disabling ? (
          <div>
            <button className="btn-danger" onClick={() => setDisabling(true)}>
              {t('Tắt xác thực 2 lớp', 'Turn off two-factor')}
            </button>
          </div>
        ) : (
          <form onSubmit={disable} className="stack" style={{ gap: 14 }}>
            {codeInput}
            {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
            <div className="hstack">
              <button className="btn" style={{ color: 'var(--bad-ink)' }} disabled={code.length !== 6}>
                {t('Xác nhận tắt', 'Confirm turning off')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => (setDisabling(false), setCode(''))}>
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
      <div>
        {intro}
        <button className="btn btn-primary btn-lg" onClick={() => void begin()}>
          {t('Bật xác thực 2 lớp', 'Turn on two-factor')}
        </button>
      </div>
    );

  return (
    <form onSubmit={enable}>
      {intro}
      <div className="hstack" style={{ gap: 20, alignItems: 'center' }}>
        <img className="qr" src={setup.qrDataUrl} alt={t('Mã QR để quét bằng ứng dụng xác thực', 'QR code to scan with your authenticator app')} />
        <div className="stack" style={{ gap: 12 }}>
          {codeInput}
          <div className="hstack" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-lg" disabled={code.length !== 6}>
              {t('Bật xác thực 2 lớp', 'Turn on two-factor')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => (setSetup(null), setCode(''))}>
              {t('Hủy', 'Cancel')}
            </button>
          </div>
        </div>
      </div>
      <p className="section-sub" style={{ paddingTop: 14, maxWidth: '60ch' }}>
        {t('Không quét được? Nhập khóa này thủ công:', 'Cannot scan? Enter this key manually:')}{' '}
        <code className="num" style={{ wordBreak: 'break-all', color: 'var(--ink)' }}>
          {setup.secret.match(/.{1,4}/g)?.join(' ')}
        </code>
      </p>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}

export function ProfilePage() {
  const { t, lang, setLang } = useI18n();
  const { user, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  void getSession;
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t('Bảo mật & hiển thị', 'Security & display')}</h1>
        {user && (
          <p className="page-lede">
            {t(`Đăng nhập với tên ${user.username}, tạo ngày ${fmtDate(user.createdAt, false)}.`, `Signed in as ${user.username}, created ${fmtDate(user.createdAt, false)}.`)}
          </p>
        )}
      </header>

      <div className="cols">
        <div className="col-main">
          <section aria-labelledby="h-2fa" className="rule-below" style={{ paddingBottom: 26 }}>
            <h2 id="h-2fa" className="section-title">
              {t('Xác thực 2 lớp', 'Two-factor authentication')}
            </h2>
            <TwoFactor />
          </section>

          <section aria-labelledby="h-pw">
            <h2 id="h-pw" className="section-title" style={{ padding: '24px 0 12px' }}>
              {t('Mật khẩu', 'Password')}
            </h2>
            <PasswordForm />
          </section>
        </div>

        <section className="col-side" aria-labelledby="h-display" style={{ gap: 4 }}>
          <h2 id="h-display" className="section-title" style={{ paddingBottom: 6 }}>
            {t('Hiển thị', 'Display')}
          </h2>
          <div className="kv" style={{ alignItems: 'center', padding: '12px 0' }}>
            <span style={{ color: 'var(--ink)' }}>{t('Giao diện', 'Theme')}</span>
            <div className="seg" role="group" aria-label={t('Giao diện', 'Theme')}>
              {(
                [
                  ['auto', t('Tự động', 'Auto')],
                  ['light', t('Sáng', 'Light')],
                  ['dark', t('Tối', 'Dark')],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={theme === k ? 'on' : ''} aria-pressed={theme === k} onClick={() => setTheme(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="kv" style={{ alignItems: 'center', padding: '12px 0' }}>
            <span style={{ color: 'var(--ink)' }}>{t('Ngôn ngữ', 'Language')}</span>
            <div className="seg" role="group" aria-label={t('Ngôn ngữ', 'Language')}>
              <button className={lang === 'vi-VN' ? 'on' : ''} aria-pressed={lang === 'vi-VN'} onClick={() => setLang('vi-VN')}>
                Tiếng Việt
              </button>
              <button className={lang === 'en-US' ? 'on' : ''} aria-pressed={lang === 'en-US'} onClick={() => setLang('en-US')}>
                English
              </button>
            </div>
          </div>
          <div style={{ paddingTop: 22 }}>
            <button className="btn-danger" onClick={() => void logout()}>
              {t('Đăng xuất', 'Sign out')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}