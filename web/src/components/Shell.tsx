import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Ev, useEvent, useRealtimeConnected } from '../lib/realtime';

type Theme = 'auto' | 'light' | 'dark';
function applyTheme(th: Theme) {
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
}
export function initTheme() {
  try {
    applyTheme((localStorage.getItem('theme') as Theme) ?? 'auto');
  } catch {
    /* ignore */
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('theme') as Theme) ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const set = (th: Theme) => {
    setTheme(th);
    applyTheme(th);
    try {
      localStorage.setItem('theme', th);
    } catch {
      /* ignore */
    }
  };
  return [theme, set] as const;
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { user, logout } = useAuth();
  const live = useRealtimeConnected();
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState(0);
  const loc = useLocation();

  useEffect(() => setOpen(false), [loc.pathname]);

  const loadQueue = useCallback(() => {
    api
      .get<unknown[]>('/scrapes/unprocessed', { quiet: true })
      .then((r) => setQueue(r.data.length))
      .catch(() => {});
  }, []);
  useEffect(loadQueue, [loadQueue]);
  useEvent([Ev.NewScrape, Ev.FinishScrape, Ev.UpdateScrape], loadQueue);

  const groups: { title?: string; links: { to: string; label: string; badge?: number; match?: string }[] }[] = [
    { links: [{ to: '/', label: t('Bàn làm việc', 'Desk') }] },
    {
      title: t('Tìm lại', 'Find'),
      links: [
        { to: '/bai-viet/tu-khoa', match: '/bai-viet', label: t('Bài viết', 'Posts') },
        { to: '/binh-luan/tu-khoa', match: '/binh-luan', label: t('Bình luận', 'Comments') },
      ],
    },
    {
      title: t('Sàng lọc', 'Sieve'),
      links: [{ to: '/sang', label: t('Sàng ảnh & video', 'Images & video'), badge: queue }],
    },
    {
      title: t('Dữ liệu', 'Data'),
      links: [
        { to: '/nhat-ky/bai-viet', match: '/nhat-ky', label: t('Nhật ký đồng bộ', 'Sync log') },
        { to: '/dong-bo', label: t('Đồng bộ thủ công', 'Manual sync') },
        { to: '/sao-luu', label: t('Sao lưu', 'Backup') },
      ],
    },
    {
      title: t('Hệ thống', 'System'),
      links: [
        { to: '/cai-dat', label: t('Cài đặt', 'Settings') },
        { to: '/ho-so', label: t('Hồ sơ & bảo mật', 'Profile & security') },
      ],
    },
  ];

  return (
    <div className="shell">
      <div className="topbar-mobile">
        <button aria-label={t('Mở menu', 'Open menu')} onClick={() => setOpen(true)}>
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <path d="M3 6h16M3 11h16M3 16h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <img src="/mark.svg" width={26} height={26} alt="" />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 650 }}>sàng</span>
        {queue > 0 && <span className="rail-badge" style={{ marginLeft: 'auto' }}>{queue}</span>}
      </div>
      <aside className={`rail ${open ? 'open' : ''}`} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
        <NavLink to="/" className="wordmark">
          <img src="/mark.svg" width={32} height={32} alt="" />
          <span className="wordmark-text">sàng</span>
        </NavLink>
        <nav aria-label={t('Điều hướng chính', 'Main navigation')}>
          {groups.map((g, i) => (
            <div key={i}>
              {g.title && <div className="rail-group-title">{g.title}</div>}
              {g.links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === '/'}
                  className={({ isActive }) => `rail-link ${isActive || (l.match && loc.pathname.startsWith(l.match)) ? 'active' : ''}`}
                >
                  <span>{l.label}</span>
                  {!!l.badge && <span className="rail-badge" aria-label={t(`${l.badge} đang chờ`, `${l.badge} queued`)}>{l.badge}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="rail-foot">
          <span title={live ? t('Đang nhận cập nhật trực tiếp', 'Receiving live updates') : t('Mất kết nối trực tiếp', 'Live updates disconnected')}>
            <span className={`live-dot ${live ? 'on' : ''}`} />
            {live ? t('Trực tiếp', 'Live') : t('Đang kết nối lại…', 'Reconnecting…')}
          </span>
          <button onClick={() => setLang(lang === 'vi-VN' ? 'en-US' : 'vi-VN')}>{lang === 'vi-VN' ? 'English' : 'Tiếng Việt'}</button>
          <button onClick={() => void logout()}>
            {t('Đăng xuất', 'Sign out')} {user ? `(${user.username})` : ''}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
