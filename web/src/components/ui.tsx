import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type AnchorHTMLAttributes } from 'react';
import { ApiErr, api, setErrorSinks } from '../lib/api';
import { Ev, useEvent, serverVersion } from '../lib/realtime';
import { useI18n } from '../lib/i18n';
import { highlight } from '../lib/format';

/* ---------------- toasts ---------------- */

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface Maintenance {
  scrape: { isPaused: boolean; message: string };
  searchPost: { isPaused: boolean; message: string };
  searchComment: { isPaused: boolean; message: string };
}

interface UiCtx {
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
  confirmExternal: (url: string) => void;
  maintenance: Maintenance | null;
  refreshMaintenance: () => void;
}

const Ctx = createContext<UiCtx>(null as any);
export const useUi = () => useContext(Ctx);

let seq = 0;

export function UiProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [external, setExternal] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<Maintenance | null>(null);
  const [needReload, setNeedReload] = useState(false);
  const bootVersion = useRef<string | null>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
    const id = ++seq;
    setToasts((ts) => [...ts.slice(-3), { id, text, kind, action }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 9000 : 4500);
  }, []);

  const refreshMaintenance = useCallback(() => {
    api
      .get<Maintenance>('/systems/maintenance', { quiet: true })
      .then((r) => setMaintenance(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setErrorSinks(
      (e: ApiErr) => toast(e.message, 'error'),
      () => refreshMaintenance(),
    );
    refreshMaintenance();
    api
      .get<{ version: string }>('/systems/version', { quiet: true })
      .then((r) => (bootVersion.current = r.data.version))
      .catch(() => {});
  }, [toast, refreshMaintenance]);

  useEvent(Ev.SystemNotification, (m) => toast(m.message ?? m.data?.message ?? ''));
  useEvent(Ev.NeedReload, () => setNeedReload(true));
  useEvent(Ev.ConfigReloaded, (m) => m.data?.maintenance && setMaintenance(m.data.maintenance));
  useEvent(Ev.Hello, () => {
    if (bootVersion.current && serverVersion && serverVersion !== bootVersion.current) setNeedReload(true);
  });

  // Re-check the build version when the tab regains focus.
  useEffect(() => {
    const onFocus = () =>
      api
        .get<{ version: string }>('/systems/version', { quiet: true })
        .then((r) => {
          if (bootVersion.current && r.data.version !== bootVersion.current) setNeedReload(true);
        })
        .catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <Ctx.Provider value={{ toast, confirmExternal: setExternal, maintenance, refreshMaintenance }}>
      {needReload && (
        <div className="banner banner-straw" role="status">
          {t('Đã có phiên bản mới của Glean.', 'A new version of Glean is available.')}
          <button className="btn btn-sm btn-primary" onClick={() => location.reload()}>
            {t('Tải lại trang', 'Reload page')}
          </button>
        </div>
      )}
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind === 'error' ? 'error' : ''}`}>
            <span>{x.text}</span>
            {x.action && (
              <button
                style={{ opacity: 1, textDecoration: 'underline', whiteSpace: 'nowrap' }}
                onClick={() => {
                  x.action!.run();
                  setToasts((ts) => ts.filter((y) => y.id !== x.id));
                }}
              >
                {x.action.label}
              </button>
            )}
            <button aria-label={t('Đóng', 'Close')} onClick={() => setToasts((ts) => ts.filter((y) => y.id !== x.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      {external && (
        <Dialog title={t('Mở liên kết bên ngoài?', 'Open external link?')} onClose={() => setExternal(null)}>
          <p className="muted" style={{ margin: 0 }}>
            {t('Liên kết này dẫn ra khỏi Glean và mở trong thẻ mới.', 'This link leaves Glean and opens in a new tab.')}
          </p>
          <div className="url">{external}</div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={() => setExternal(null)}>
              {t('Ở lại', 'Stay')}
            </button>
            <a
              className="btn btn-primary"
              href={external}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={() => setExternal(null)}
              autoFocus
            >
              {t('Mở liên kết', 'Open link')}
            </a>
          </div>
        </Dialog>
      )}
    </Ctx.Provider>
  );
}

/** Link that leaves the app — always asks first. */
export function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { confirmExternal } = useUi();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        confirmExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function useConfirm() {
  const { t } = useI18n();
  const [state, setState] = useState<{ title: string; body: string; action: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = (title: string, body: string, action: string, danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, action, danger, resolve }));
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Dialog title={state.title} onClose={() => close(false)}>
      <p className="muted" style={{ margin: 0 }}>
        {state.body}
      </p>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={() => close(false)}>
          {t('Hủy', 'Cancel')}
        </button>
        <button className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)} autoFocus>
          {state.action}
        </button>
      </div>
    </Dialog>
  ) : null;
  return { ask, node };
}

/** Banner shown on a page whose feature is paused by the operator. */
export function PausedNotice({ feature }: { feature: keyof Maintenance }) {
  const { maintenance } = useUi();
  const { t } = useI18n();
  const f = maintenance?.[feature];
  if (!f?.isPaused) return null;
  return (
    <div className="notice notice-straw" role="status" style={{ marginBottom: 24 }}>
      <strong>{t('Tạm dừng.', 'Paused.')}</strong>
      <span>{f.message || t('Tính năng này đang tạm dừng trong cài đặt.', 'This feature is paused in settings.')}</span>
    </div>
  );
}

export function Highlight({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map((seg, i) => (seg.hit ? <mark key={i}>{seg.s}</mark> : <span key={i}>{seg.s}</span>))}
    </>
  );
}

/** Pages of a thread drawn as holes in a sieve. */
export function Mesh({
  total,
  done,
  current,
  size = 'md',
  max,
  label,
}: {
  total: number;
  done: Set<number> | number;
  current?: Set<number>;
  size?: 'sm' | 'md' | 'lg';
  max?: number;
  label?: string;
}) {
  const shown = max ? Math.min(total, max) : total;
  const isDone = (p: number) => (typeof done === 'number' ? p <= done : done.has(p));
  return (
    <div className={`mesh ${size === 'lg' ? 'mesh-lg' : size === 'sm' ? 'mesh-sm' : ''}`} role="img" aria-label={label}>
      {Array.from({ length: Math.max(shown, 1) }, (_, i) => {
        const p = i + 1;
        const cls = isDone(p) ? 'done' : current?.has(p) ? 'now' : '';
        return <span key={p} className={`mesh-hole ${cls}`} />;
      })}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="hstack" style={{ marginTop: 20 }}>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('Trang trước', 'Previous')}
      </button>
      <span className="muted num" style={{ fontSize: 14 }}>
        {page} / {pages}
      </span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('Trang sau', 'Next')}
      </button>
    </div>
  );
}

/** Calls `onVisible` when the sentinel scrolls into view (cursor pagination). */
export function Sentinel({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (disabled || !ref.current) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && cb.current(), { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return <div ref={ref} style={{ height: 1 }} />;
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="stack" style={{ gap: 10, padding: '16px 0' }} aria-busy="true" aria-label={label}>
      <div className="skeleton" style={{ width: '60%' }} />
      <div className="skeleton" style={{ width: '40%' }} />
      <div className="skeleton" style={{ width: '52%' }} />
    </div>
  );
}
