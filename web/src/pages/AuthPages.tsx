import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiErr } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Mesh } from '../components/ui';

function AuthArt() {
  const { t } = useI18n();
  // a static sieve: a few holes already "caught" something
  const done = useMemo(() => new Set([3, 4, 11, 17, 18, 19, 26, 34, 41, 42, 50, 57, 58, 65, 73, 74]), []);
  return (
    <aside className="auth-art" aria-hidden="false">
      <div className="hstack">
        <img src="/mark.svg" width={34} height={34} alt="" />
      </div>
      <div className="stack" style={{ gap: 28 }}>
        <h1>sàng</h1>
        <p style={{ margin: 0, maxWidth: '38ch', fontSize: 16 }}>
          {t(
            'Kho riêng của bạn để tìm lại bài viết, bình luận, và lọc ảnh khỏi những chủ đề dài trên diễn đàn.',
            'Your own archive for finding posts and comments again, and sieving images out of long forum threads.',
          )}
        </p>
        <Mesh total={84} done={done} size="lg" />
      </div>
    </aside>
  );
}

export function SetupPage() {
  const { t } = useI18n();
  const { acceptTokens } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError(t('Hai mật khẩu chưa khớp nhau.', 'The passwords do not match.'));
    setBusy(true);
    try {
      const r = await api.post('/auth/setup', { username, password }, { quiet: true });
      await acceptTokens(r.data);
    } catch (err) {
      setError((err as ApiErr).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <AuthArt />
      <div className="auth-form">
        <form onSubmit={submit} className="stack">
          <div>
            <h2 className="page-title" style={{ fontSize: 32 }}>
              {t('Tạo tài khoản', 'Create your account')}
            </h2>
            <p className="page-lede">
              {t('Sàng chỉ có một tài khoản: của bạn. Bước này chỉ làm một lần.', 'Sàng has exactly one account: yours. You only do this once.')}
            </p>
          </div>
          <label className="field">
            <span>{t('Tên đăng nhập', 'Username')}</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          </label>
          <label className="field">
            <span>{t('Mật khẩu', 'Password')}</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
            <small>{t('Tối thiểu 8 ký tự.', 'At least 8 characters.')}</small>
          </label>
          <label className="field">
            <span>{t('Nhập lại mật khẩu', 'Repeat password')}</span>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? t('Đang tạo…', 'Creating…') : t('Tạo tài khoản', 'Create account')}
          </button>
        </form>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { acceptTokens } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!challenge) {
        const r = await api.post('/auth/login', { username, password }, { quiet: true });
        if (r.data.requires2fa) {
          setChallenge(r.data.challenge);
          return;
        }
        await acceptTokens(r.data);
      } else {
        const r = await api.post('/auth/verify-2fa', { challenge, code }, { quiet: true });
        await acceptTokens(r.data);
      }
    } catch (err) {
      const e2 = err as ApiErr;
      if (e2.code === 'CHALLENGE_EXPIRED') setChallenge(null);
      setError(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <AuthArt />
      <div className="auth-form">
        <form onSubmit={submit} className="stack">
          <div>
            <h2 className="page-title" style={{ fontSize: 32 }}>
              {challenge ? t('Mã xác thực', 'Authentication code') : t('Đăng nhập', 'Sign in')}
            </h2>
            <p className="page-lede">
              {challenge
                ? t('Mở ứng dụng xác thực và nhập mã 6 số đang hiển thị.', 'Open your authenticator app and enter the 6-digit code.')
                : t('Đăng nhập để mở kho của bạn.', 'Sign in to open your archive.')}
            </p>
          </div>
          {!challenge ? (
            <>
              <label className="field">
                <span>{t('Tên đăng nhập', 'Username')}</span>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
              </label>
              <label className="field">
                <span>{t('Mật khẩu', 'Password')}</span>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>
            </>
          ) : (
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
                required
                autoFocus
              />
            </label>
          )}
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? t('Đang kiểm tra…', 'Checking…') : challenge ? t('Xác nhận', 'Verify') : t('Đăng nhập', 'Sign in')}
          </button>
          {challenge && (
            <button type="button" className="link-btn" onClick={() => (setChallenge(null), setCode(''))}>
              {t('Quay lại đăng nhập', 'Back to sign in')}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
