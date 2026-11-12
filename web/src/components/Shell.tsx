import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiErr } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent, useRealtimeConnected } from '../lib/realtime';
import { isLinkLike, parseThreadInput } from '../lib/format';
import { useCreateScrape } from './Scrape';
import { Icon, Mark, type IconName } from './Icons';

/* ---------------- theme (auto / light / dark), shared by every component ---------------- */

type Theme = 'auto' | 'light' | 'dark';
const themeListeners = new Set<() => void>();
let themeNow: Theme = (() => {
  try {
    return (localStorage.getItem('theme') as Theme) ?? 'auto';
  } catch {
    return 'auto';
  }
})();

function applyTheme(th: Theme) {
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
}
export function initTheme() {
  applyTheme(themeNow);
}
function setTheme(th: Theme) {
  themeNow = th;
  applyTheme(th);
  try {
    localStorage.setItem('theme', th);
  } catch {
    /* ignore */
  }
  themeListeners.forEach((l) => l());
}
const subscribeTheme = (l: () => void) => {
  themeListeners.add(l);
  return () => {
    themeListeners.delete(l);
  };
};

export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, () => themeNow);
  return [theme, setTheme] as const;
}

function useMedia(query: string) {
  const subscribe = useCallback(
    (l: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Whether the page is showing dark colours right now (resolves 'auto'). */
function useIsDark() {
  const [theme] = useTheme();
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  return theme === 'dark' || (theme === 'auto' && systemDark);
}

/* ---------------- global search / sieve box ---------------- */

const SEARCH_ROUTE = /^\/(bai-viet|binh-luan)\//;

/** One input, two jobs: a link (or bare ID) goes to the sieve queue, anything else is a search. */
function Omnibox({ narrow }: { narrow: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const create = useCreateScrape();
  const onSearch = SEARCH_ROUTE.test(loc.pathname);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  // Mirror the query of the search page; start empty everywhere else.
  useEffect(() => {
    setValue(onSearch ? (params.get('q') ?? '') : '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname, loc.search]);

  const v = value.trim();
  const threadId = v && (isLinkLike(v) || /^\d+$/.test(v)) ? parseThreadInput(v) : null;
  const asLink = threadId != null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!v || busy) return;
    setError('');
    if (asLink) {
      setBusy(true);
      try {
        await create(v, 'home', { navigate: true });
      } catch (err) {
        setError((err as ApiErr).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (onSearch) {
      const next = new URLSearchParams(params);
      next.set('q', v);
      navigate(`${loc.pathname}?${next}`);
    } else {
      navigate(`/bai-viet/tu-khoa?q=${encodeURIComponent(v)}`);
    }
  };

  const currentQ = onSearch ? (params.get('q') ?? '') : '';
  const hint = error
    ? error
    : busy
      ? t('Đang đưa vào hàng đợi…', 'Adding to the queue…')
      : asLink
        ? t(`Nhận ra bài #${threadId}. Nhấn Enter để đưa vào hàng đợi sàng.`, `Recognised thread #${threadId}. Press Enter to queue it.`)
        : v && v !== currentQ
          ? onSearch && loc.pathname.startsWith('/binh-luan')
            ? t('Nhấn Enter để tìm bình luận.', 'Press Enter to search comments.')
            : t('Nhấn Enter để tìm bài viết.', 'Press Enter to search threads.')
          : '';

  return (
    <form className="omni" onSubmit={submit} role="search">
      <label htmlFor="omni" className="sr-only">
        {t('Tìm bài viết, bình luận, hoặc dán link để sàng', 'Search threads and comments, or paste a link to sieve')}
      </label>
      <input
        id="omni"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError('');
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={narrow ? t('Tìm hoặc dán link', 'Search or paste a link') : t('Tìm bài viết, bình luận, hoặc dán link để sàng', 'Search threads and comments, or paste a link to sieve')}
        autoComplete="off"
        enterKeyHint={asLink ? 'go' : 'search'}
      />
      {hint && (focused || error) && (
        <div className={`omni-hint ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {hint}
        </div>
      )}
    </form>
  );
}

/* ---------------- navigation ---------------- */

interface NavItem {
  to: string;
  label: string;
  short?: string;
  icon: IconName;
  match?: string[];
  badge?: number;
}

const SYSTEM_PREFIXES = ['/dong-bo', '/nhat-ky', '/cai-dat', '/sao-luu', '/ho-so'];

function isActive(path: string, item: NavItem) {
  if (item.to === '/') return path === '/';
  return [item.to, ...(item.match ?? [])].some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const live = useRealtimeConnected();
  const dark = useIsDark();
  const narrow = useMedia('(max-width: 879px)');
  const [queue, setQueue] = useState(0);
  const loc = useLocation();
  const path = loc.pathname;

  const loadQueue = useCallback(() => {
    api
      .get<unknown[]>('/scrapes/unprocessed', { quiet: true })
      .then((r) => setQueue(r.data.length))
      .catch(() => {});
  }, []);
  useEffect(loadQueue, [loadQueue]);
  useEvent([Ev.NewScrape, Ev.FinishScrape, Ev.UpdateScrape], loadQueue);

  const main: NavItem[] = [
    { to: '/', label: t('Bàn làm việc', 'Desk'), short: t('Bàn', 'Desk'), icon: 'desk' },
    { to: '/bai-viet/tu-khoa', match: ['/bai-viet', '/binh-luan'], label: t('Tìm kiếm', 'Search'), short: t('Tìm', 'Search'), icon: 'search' },
    { to: '/sang', label: t('Kho', 'Archive'), short: t('Kho', 'Archive'), icon: 'archive' },
    { to: '/hang-doi', label: t('Hàng đợi sàng', 'Sieve queue'), short: t('Hàng đợi', 'Queue'), icon: 'queue', badge: queue },
  ];
  const system: NavItem[] = [
    { to: '/dong-bo', label: t('Đồng bộ', 'Sync'), icon: 'sync' },
    { to: '/nhat-ky/bai-viet', match: ['/nhat-ky'], label: t('Nhật ký', 'Sync log'), icon: 'log' },
    { to: '/cai-dat', label: t('Cài đặt', 'Settings'), icon: 'settings' },
    { to: '/sao-luu', label: t('Sao lưu', 'Backup'), icon: 'backup' },
    { to: '/ho-so', label: t('Bảo mật', 'Security'), icon: 'shield' },
  ];
  const inSystem = SYSTEM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  const mobile: NavItem[] = [...main, { to: '/dong-bo', label: t('Hệ thống', 'System'), short: t('Hệ thống', 'System'), icon: 'system' }];

  const railLink = (l: NavItem) => {
    const on = isActive(path, l);
    return (
      <Link key={l.to} to={l.to} className={`rail-link ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined}>
        <Icon name={l.icon} />
        <span>{l.label}</span>
        {!!l.badge && (
          <span className="rail-badge" aria-label={t(`${l.badge} đang chờ`, `${l.badge} queued`)}>
            {l.badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to="/" className="rail-brand" aria-label="Glean">
          <Mark size={26} />
          <span className="wordmark">GLEAN</span>
        </NavLink>
        <nav aria-label={t('Điều hướng chính', 'Main navigation')}>
          <div className="rail-group-title">{t('Menu', 'Menu')}</div>
          {main.map(railLink)}
          <div className="rail-group-title">{t('Hệ thống', 'System')}</div>
          {system.map(railLink)}
        </nav>
        <div className="rail-foot">
          <span className="live" title={live ? t('Đang nhận cập nhật trực tiếp', 'Receiving live updates') : t('Mất kết nối trực tiếp', 'Live updates disconnected')}>
            <span className={`live-dot ${live ? 'on' : ''}`} />
            {live ? t('Đang nhận cập nhật trực tiếp', 'Receiving live updates') : t('Đang kết nối lại…', 'Reconnecting…')}
          </span>
          <button onClick={() => void logout()}>{t('Đăng xuất', 'Sign out')}</button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <Link to="/" className="topbar-mark" aria-label={t('Bàn làm việc', 'Desk')}>
            <Mark size={30} />
          </Link>
          <Omnibox narrow={narrow} />
          <span className="topbar-spacer" />
          <button className="theme-btn" onClick={() => setTheme(dark ? 'light' : 'dark')}>
            {dark ? t('Giao diện sáng', 'Light theme') : t('Giao diện tối', 'Dark theme')}
          </button>
          <Link to="/ho-so" className="me" aria-label={t('Bảo mật & hiển thị', 'Security & display')}>
            <span className="avatar" aria-hidden="true">
              {user?.username?.[0] ?? '?'}
            </span>
            <span className="me-name">{user?.username}</span>
          </Link>
        </header>

        {inSystem && (
          <nav className="systabs" aria-label={t('Mục hệ thống', 'System sections')}>
            {system.map((l) => (
              <Link key={l.to} to={l.to} className={isActive(path, l) ? 'active' : ''} aria-current={isActive(path, l) ? 'page' : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
        )}

        <main className="main">{children}</main>

        <nav className="bottomnav" aria-label={t('Điều hướng chính', 'Main navigation')}>
          {mobile.map((l, i) => {
            const on = i === mobile.length - 1 ? inSystem : isActive(path, l);
            return (
              <Link key={l.label} to={l.to} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
                <Icon name={l.icon} size={18} />
                {l.short}
                {!!l.badge && <span className="rail-badge">{l.badge}</span>}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
