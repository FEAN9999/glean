import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiErr } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { OtpInput } from '../components/ui';
import { Mark } from '../components/Icons';

function AuthArt() {
  const { t } = useI18n();
  return (
    <aside className="auth-art">
      <div className="auth-brand">
        <Mark size={28} />
        <span className="wordmark">GLEAN</span>
      </div>
      <div className="stack" style={{ maxWidth: 420 }}>
        <h1>{t('Kho riêng để tìm lại những gì đã trôi qua.', 'A private archive for finding what has scrolled away.')}</h1>
        <p>
          {t(
            'Tìm lại bài viết và bình luận, sàng ảnh và video khỏi những chủ đề dài. Bản lưu vẫn còn khi bài gốc bị xóa.',
            'Find threads and comments again, and sieve images and videos out of long threads. Your copy stays when the original is deleted.',
          )}
        </p>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {t('Dữ liệu nằm trên máy chạy Glean.', 'Your data stays on the machine running Glean.')}
      </span>
    </aside>
  );
}

function FormHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <h2 className="page-title">{title}</h2>
      <span className="muted">{sub}</span>
    </div>
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
        <form onSubmit={submit}>
          <FormHead
            title={t('Tạo tài khoản', 'Create your account')}
            sub={t('Glean chỉ có một tài khoản: của bạn. Bước này chỉ làm một lần.', 'Glean has exactly one account: yours. You only do this once.')}
          />
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
          {error && <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p>}
          <button className="btn btn-primary btn-xl" disabled={busy}>
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
        <form onSubmit={submit}>
          <FormHead
            title={challenge ? t('Mã xác thực', 'Authentication code') : t('Đăng nhập', 'Sign in')}
            sub={
              challenge
                ? t('Mở ứng dụng xác thực và nhập mã 6 số đang hiển thị.', 'Open your authenticator app and enter the 6-digit code.')
                : t('Đăng nhập để mở kho của bạn.', 'Sign in to open your archive.')
            }
          />
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
            <div className="field">
              <span>{t('Mã 6 số', '6-digit code')}</span>
              <OtpInput value={code} onChange={setCode} label={t('Mã 6 số', '6-digit code')} autoFocus />
            </div>
          )}
          {error && <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p>}
          <button className="btn btn-primary btn-xl" disabled={busy || (!!challenge && code.length !== 6)}>
            {busy ? t('Đang kiểm tra…', 'Checking…') : challenge ? t('Xác nhận', 'Verify') : t('Đăng nhập', 'Sign in')}
          </button>
          {challenge ? (
            <button type="button" className="link-btn" style={{ fontSize: 13 }} onClick={() => (setChallenge(null), setCode(''))}>
              {t('Quay lại đăng nhập', 'Back to sign in')}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              {t('Nếu đã bật xác thực 2 lớp, bước sau sẽ hỏi mã 6 số.', 'If two-factor is on, the next step asks for a 6-digit code.')}
            </span>
          )}
        </form>
      </div>
    </div>
  );
}
