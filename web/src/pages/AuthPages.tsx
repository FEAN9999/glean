import { useState, type FormEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { api, ApiErr } from '../lib/api';
import { useAuth, type Tokens } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { OtpInput } from '../components/ui';
import { Mark } from '../components/Icons';
import { Spotlight } from '../components/magic/spotlight';
import { EASE_OUT } from '../lib/ease';

/** The night side of the sign-in screen: the headline comes in word by word under a slow spotlight. */
function AuthArt() {
  const { t } = useI18n();
  const headline = t('Kho riêng để tìm lại những gì đã trôi qua.', 'A private archive for finding what has scrolled away.');
  const words = headline.split(' ');
  const after = 0.2 + words.length * 0.06;
  return (
    <aside className="auth-art relative isolate overflow-hidden bg-night text-mist max-[879px]:flex max-[879px]:gap-8 max-[879px]:px-6 max-[879px]:py-8">
      <Spotlight />
      <div className="auth-brand relative z-10">
        <Mark size={28} />
        <span className="wordmark text-mist">GLEAN</span>
      </div>
      <div className="relative z-10 grid max-w-[500px] gap-5">
        <h1 aria-label={headline} className="m-0 text-[clamp(30px,4.4vw,54px)] leading-[1.08] font-light tracking-[-0.03em] text-white">
          {words.map((w, i) => (
            <motion.span
              key={i}
              aria-hidden="true"
              className="inline-block whitespace-pre"
              initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ delay: 0.2 + i * 0.06, duration: 0.6, ease: EASE_OUT }}
            >
              {i < words.length - 1 ? `${w} ` : w}
            </motion.span>
          ))}
        </h1>
        <motion.p
          className="m-0 text-[15px] leading-relaxed text-mist/75 max-[879px]:hidden"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: after, duration: 0.6, ease: EASE_OUT }}
        >
          {t(
            'Tìm lại bài viết và bình luận, sàng ảnh và video khỏi những chủ đề dài. Bản lưu vẫn còn khi bài gốc bị xóa.',
            'Find threads and comments again, and sieve images and videos out of long threads. Your copy stays when the original is deleted.',
          )}
        </motion.p>
      </div>
      <motion.span className="relative z-10 text-[13px] text-mist/60 max-[879px]:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: after + 0.2, duration: 0.6 }}>
        {t('Dữ liệu nằm trên máy chạy Glean.', 'Your data stays on the machine running Glean.')}
      </motion.span>
    </aside>
  );
}

/** The form slides up just behind the headline. */
const formIn = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.25, duration: 0.6, ease: EASE_OUT } };

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
      const r = await api.post<Tokens>('/auth/setup', { username, password }, { quiet: true });
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
        <motion.form {...formIn} onSubmit={submit}>
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
        </motion.form>
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
        const r = await api.post<Tokens | { requires2fa: true; challenge: string }>('/auth/login', { username, password }, { quiet: true });
        if ('requires2fa' in r.data) {
          setChallenge(r.data.challenge);
          return;
        }
        await acceptTokens(r.data);
      } else {
        const r = await api.post<Tokens>('/auth/verify-2fa', { challenge, code }, { quiet: true });
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
        <motion.form {...formIn} onSubmit={submit}>
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
        </motion.form>
      </div>
    </div>
  );
}
