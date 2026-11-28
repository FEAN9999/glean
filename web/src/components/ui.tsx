import { Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type AnchorHTMLAttributes, type CSSProperties } from 'react';
import { ApiErr, api, setErrorSinks } from '../lib/api';
import { Ev, useEvent, serverVersion } from '../lib/realtime';
import { useI18n } from '../lib/i18n';
import { fmtNum, highlight } from '../lib/format';
import { ALL, selectedSite } from '../lib/site';

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
  /** Under the every-site view no single site's pause flags apply. */
  clearMaintenance: () => void;
}

const Ctx = createContext<UiCtx | null>(null);
export const useUi = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUi needs a UiProvider above it.');
  return c;
};

let seq = 0;

/**
 * Closes each toast after its time. `hold` keeps one open (the pointer is on it, or the keyboard
 * focus is in it); `start` again gives it its full time back.
 */
export function toastTimers(close: (id: number) => void) {
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  const hold = (id: number) => {
    clearTimeout(pending.get(id));
    pending.delete(id);
  };
  const start = (id: number, ms: number) => {
    hold(id);
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        close(id);
      }, ms),
    );
  };
  return { start, hold };
}

const toastLife = (x: Toast) => (x.kind === 'error' ? 7000 : x.action ? 9000 : 4500);

export function UiProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [timers] = useState(() => toastTimers((id) => setToasts((ts) => ts.filter((x) => x.id !== id))));
  const [external, setExternal] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<Maintenance | null>(null);
  const [needReload, setNeedReload] = useState(false);
  const bootVersion = useRef<string | null>(null);

  const toast = useCallback(
    (text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
      const x: Toast = { id: ++seq, text, kind, action };
      setToasts((ts) => [...ts.slice(-3), x]);
      timers.start(x.id, toastLife(x));
    },
    [timers],
  );

  const refreshMaintenance = useCallback(() => {
    // The flags are one site's: none apply under `*`, and an answer that lands after a switch is dropped.
    const site = selectedSite();
    if (site === ALL) return;
    api
      .get<Maintenance>('/systems/maintenance', { quiet: true, site })
      .then((r) => selectedSite() === site && setMaintenance(r.data))
      .catch(() => {});
  }, []);

  const clearMaintenance = useCallback(() => setMaintenance(null), []);

  useEffect(() => {
    setErrorSinks(
      (e: ApiErr) => toast(e.message, 'error'),
      () => refreshMaintenance(),
    );
    // The pause flags belong to a site: Shell loads them once the chosen site is known.
    api
      .get<{ version: string }>('/systems/version', { quiet: true })
      .then((r) => (bootVersion.current = r.data.version))
      .catch(() => {});
  }, [toast, refreshMaintenance]);

  useEvent<{ message: string }>(Ev.SystemNotification, (m) => toast(m.message ?? m.data?.message ?? ''));
  useEvent(Ev.NeedReload, () => setNeedReload(true));
  useEvent<{ maintenance: Maintenance }>(Ev.ConfigReloaded, (m) => m.data?.maintenance && selectedSite() !== ALL && setMaintenance(m.data.maintenance));
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
    <Ctx.Provider value={{ toast, confirmExternal: setExternal, maintenance, refreshMaintenance, clearMaintenance }}>
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
          <div
            key={x.id}
            className={`toast ${x.kind === 'error' ? 'error' : ''}`}
            // A toast does not close while it is pointed at or focused: its button may be about to be pressed.
            onMouseEnter={() => timers.hold(x.id)}
            onMouseLeave={() => timers.start(x.id, toastLife(x))}
            onFocus={() => timers.hold(x.id)}
            onBlur={() => timers.start(x.id, toastLife(x))}
          >
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

/**
 * When a dialog closes, the keyboard focus goes back to what had it when the dialog opened. Only if
 * the focus was lost with the dialog: one that moved the focus somewhere on purpose is left alone.
 */
export function useReturnFocus() {
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  useEffect(
    () => () => {
      // After the dialog has left the page, so the focus has had the chance to fall to <body>.
      setTimeout(() => {
        const now = document.activeElement;
        if (opener?.isConnected && (!now || now === document.body)) opener.focus();
      });
    },
    [opener],
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useReturnFocus();
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
    <div className="notice notice-straw" role="status" style={{ marginBottom: 20 }}>
      <strong>{t('Tạm dừng.', 'Paused.')}</strong>
      <span>{f.message || t('Tính năng này đang tạm dừng trong cài đặt.', 'This feature is paused in settings.')}</span>
    </div>
  );
}

export function Highlight({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text ?? '', q ?? '').map((seg, i) => (seg.hit ? <mark key={i}>{seg.s}</mark> : <span key={i}>{seg.s}</span>))}
    </>
  );
}

/**
 * Pages of a thread as a strip of bars: scanned, being scanned, still to do.
 * Up to 20 pages get a number under each bar; longer threads wrap into a dense grid.
 */
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
  const shown = Math.max(max ? Math.min(total, max) : total, 1);
  const isDone = (p: number) => (typeof done === 'number' ? p <= done : done.has(p));
  const dense = size === 'sm' || shown > 20;
  return (
    <div
      className={`pages ${dense ? 'dense' : ''}`}
      style={dense ? undefined : { gridTemplateColumns: `repeat(${shown}, minmax(0, 1fr))` }}
      role="img"
      aria-label={label}
    >
      {Array.from({ length: shown }, (_, i) => {
        const p = i + 1;
        const cls = isDone(p) ? 'done' : current?.has(p) ? 'now' : '';
        return (
          <span key={p} className={`page-cell ${cls}`}>
            <i />
            {!dense && p}
          </span>
        );
      })}
    </div>
  );
}

/** Ring split into done / in progress / remaining. `done` and `current` are counts out of `total`. */
export function Donut({
  total,
  done,
  current = 0,
  size = 'md',
  label,
  children,
}: {
  total: number;
  done: number;
  current?: number;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  children?: ReactNode;
}) {
  const pct = (n: number) => `${total > 0 ? Math.min(100, (100 * n) / total) : 0}%`;
  const style = { '--a': pct(done), '--b': pct(done + current) } as React.CSSProperties;
  return (
    <div className={`donut ${size === 'lg' ? 'donut-lg' : size === 'sm' ? 'donut-sm' : ''}`} style={style} role="img" aria-label={label}>
      <span>{children}</span>
    </div>
  );
}

/** Label + on/off switch on one ruled line. A real checkbox underneath. */
export function Switch({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Six boxes for a one-time code, driven by one numeric input. */
export function OtpInput({ value, onChange, label, autoFocus }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  return (
    <div className="otp">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={i === Math.min(value.length, 5) ? 'cur' : ''} aria-hidden="true">
          {value[i] ?? ''}
        </span>
      ))}
      <input
        aria-label={label}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        required
        autoFocus={autoFocus}
      />
    </div>
  );
}

/** Coloured dot followed by a short status text. */
export function Status({ tone, children }: { tone: 'ok' | 'bad' | 'off' | 'acc'; children: ReactNode }) {
  return (
    <span className={`status ${tone === 'bad' ? 'bad' : ''}`}>
      <span className={`dot ${tone === 'ok' ? 'dot-ok' : tone === 'bad' ? 'dot-bad' : tone === 'acc' ? 'dot-acc' : ''}`} />
      {children}
    </span>
  );
}

/** Keeps an error while drawing one page from blanking the whole app: that page shows it, the navigation keeps working. */
export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  /** Opening another page (a new `resetKey`) clears the error; pages that work are left mounted. */
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    return this.state.error ? <PageCrashed error={this.state.error} /> : this.props.children;
  }
}

function PageCrashed({ error }: { error: Error }) {
  const { t } = useI18n();
  return (
    <div className="page">
      <Empty page title={t('Trang này gặp lỗi', 'This page ran into an error')}>
        <span>{error.message}</span>
        <button className="btn" onClick={() => location.reload()}>
          {t('Tải lại trang', 'Reload the page')}
        </button>
      </Empty>
    </div>
  );
}

/** `page`: the empty state is all the page shows, so its title is the page heading. */
export function Empty({ title, children, page }: { title: string; children?: ReactNode; page?: boolean }) {
  return (
    <div className="empty">
      {page ? <h1>{title}</h1> : <strong>{title}</strong>}
      {children}
    </div>
  );
}

/**
 * Page numbers to show: always the first and last page and the pages next to the current one,
 * with `null` for a gap. The list keeps the same length while you move, so the buttons do not jump.
 */
export function pageItems(page: number, pages: number, siblings = 1): (number | null)[] {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const slots = siblings * 2 + 5;
  if (pages <= slots) return range(1, pages);
  const left = Math.max(page - siblings, 1);
  const right = Math.min(page + siblings, pages);
  const gapLeft = left > 3;
  const gapRight = right < pages - 2;
  const edge = siblings * 2 + 3;
  if (!gapLeft) return [...range(1, edge), null, pages];
  if (!gapRight) return [1, null, ...range(pages - edge + 1, pages)];
  return [1, null, ...range(left, right), null, pages];
}

/** "Showing 49–96 of 1,234 images" — the items on the current page. */
export function pageRange(t: (vi: string, en: string) => string, page: number, total: number, size: number, unit = '') {
  const from = Math.min(total, (page - 1) * size + 1);
  const to = Math.min(total, page * size);
  const u = unit ? ` ${unit}` : '';
  return t(`Hiển thị ${fmtNum(from)}–${fmtNum(to)} trong ${fmtNum(total)}${u}`, `Showing ${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(total)}${u}`);
}

/** Numbered pagination: range shown, previous / page numbers / next, and a jump box for long lists. */
export function Pager({ page, total, size, onPage, unit }: { page: number; total: number; size: number; onPage: (p: number) => void; unit?: string }) {
  const { t } = useI18n();
  const [jump, setJump] = useState('');
  const jumpId = useId();
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  const go = (p: number) => {
    const n = Math.min(pages, Math.max(1, Math.round(p)));
    if (n !== page) onPage(n);
  };
  return (
    <nav className="pager" aria-label={t('Phân trang', 'Pagination')}>
      <div className="pager-pages">
        <button className="pg pg-step" disabled={page <= 1} onClick={() => go(page - 1)} aria-label={t('Trang trước', 'Previous page')}>
          <span aria-hidden="true">‹</span>
          <span className="pg-word">{t('Trước', 'Previous')}</span>
        </button>
        {pageItems(page, pages).map((p, i) =>
          p == null ? (
            <span key={`gap-${i}`} className="pg-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              className={`pg num ${p === page ? 'on' : ''}`}
              aria-current={p === page ? 'page' : undefined}
              aria-label={t(`Trang ${p}`, `Page ${p}`)}
              onClick={() => go(p)}
            >
              {fmtNum(p)}
            </button>
          ),
        )}
        <button className="pg pg-step" disabled={page >= pages} onClick={() => go(page + 1)} aria-label={t('Trang sau', 'Next page')}>
          <span className="pg-word">{t('Sau', 'Next')}</span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div className="pager-meta">
        <span className="pager-info num">{pageRange(t, page, total, size, unit)}</span>
        {pages > 7 && (
          <form
            className="pager-jump"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jump);
              if (Number.isFinite(n) && jump.trim()) go(n);
              setJump('');
            }}
          >
            <label htmlFor={jumpId}>{t('Đến trang', 'Go to page')}</label>
            <input
              id={jumpId}
              className="num"
              type="number"
              inputMode="numeric"
              min={1}
              max={pages}
              placeholder={`${page}`}
              value={jump}
              onChange={(e) => setJump(e.target.value)}
            />
            <span className="muted num">/ {fmtNum(pages)}</span>
          </form>
        )}
      </div>
    </nav>
  );
}

/** Calls `onVisible` when the sentinel scrolls into view (cursor pagination). */
export function Sentinel({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  useLayoutEffect(() => {
    cb.current = onVisible;
  });
  useEffect(() => {
    if (disabled || !ref.current) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && cb.current(), { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return <div ref={ref} style={{ height: 1 }} />;
}

/* ---------------- skeletons: what is loading, drawn in the shape it will take ---------------- */

const BONE_WIDTHS = ['72%', '56%', '84%', '64%', '78%', '48%'];
/** Width of the `i`-th placeholder line, varied so a list of them reads as text. */
export const boneWidth = (i: number) => BONE_WIDTHS[i % BONE_WIDTHS.length];

/** One shimmering block standing in for text, a number or a picture that is still loading. */
export function Bone({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** A block still loading. Screen readers hear `label` once instead of the empty bones. */
export function Skeleton({ label, className, style, children }: { label: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={className} style={style} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** The bones alone inside a `Skeleton` that already names them; with a `label`, their own `Skeleton`. */
const wrapBones = (label: string | undefined, bones: ReactNode) => (label ? <Skeleton label={label}>{bones}</Skeleton> : <>{bones}</>);

/** `n` placeholder `.line` rows (title and sub line), with a round thumbnail and a value at the right when asked. */
export function SkeletonLines({ n, label, thumb, value, pad }: { n: number; label?: string; thumb?: boolean; value?: boolean; pad?: string }) {
  return wrapBones(
    label,
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="line" style={pad ? { padding: pad } : undefined}>
          {thumb && <Bone w={38} h={38} r="50%" />}
          <span className="line-text" style={{ gap: 7, padding: '3px 0' }}>
            <Bone w={boneWidth(i)} h={13} />
            <Bone w="40%" h={10} />
          </span>
          {value && <Bone w={56} h={12} />}
        </div>
      ))}
    </>,
  );
}

/** `n` placeholder `.result` rows (title and meta line), with a block at the right `side` pixels wide and `sideH` high. */
export function SkeletonResults({ n, label, side, sideH = 34 }: { n: number; label?: string; side?: number; sideH?: number }) {
  return wrapBones(
    label,
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="result">
          <div className="result-text" style={{ gap: 9, padding: '3px 0' }}>
            <Bone w={boneWidth(i)} h={15} />
            <Bone w="46%" h={11} />
          </div>
          {side && <Bone w={side} h={sideH} />}
        </div>
      ))}
    </>,
  );
}

/** A switch row still loading: its label and the switch. */
export function SkeletonSwitch({ label = '46%' }: { label?: string }) {
  return (
    <div className="switch-row" style={{ cursor: 'default' }}>
      <Bone w={label} h={12} />
      <Bone w={40} h={22} r={11} />
    </div>
  );
}

/** A form field still loading: its label and its input box. */
export function SkeletonField({ label = '34%' }: { label?: string }) {
  return (
    <div className="field">
      <Bone w={label} h={11} style={{ margin: '3px 0' }} />
      <Bone h={40} />
    </div>
  );
}
