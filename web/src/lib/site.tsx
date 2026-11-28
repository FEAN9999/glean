import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { Empty } from '../components/ui';

/** One forum Glean reads, as `GET /api/sites` lists it (the main site first). */
export interface SiteInfo {
  code: string;
  name: string;
  isMain: boolean;
  baseUrl: string;
  dir: string | null;
}

/** The choice that means every site at once (`x-glean-site: *`). */
export const ALL = '*';

/**
 * The site to show, from what was stored and the sites there are now: a stored site while it still
 * exists, every site at once only while there are two or more, the main site in every other case.
 */
export function resolveSelected(stored: string | null, list: SiteInfo[]): string {
  const keep = stored === ALL ? list.length >= 2 : list.some((s) => s.code === stored);
  return keep && stored ? stored : (list.find((s) => s.isMain)?.code ?? '');
}

/* ---------------- the chosen site, shared by every component (like useTheme in Shell.tsx) ---------------- */

const KEY = 'site';
let state: { sites: SiteInfo[]; selected: string } = {
  sites: [],
  // Until the list arrives, the stored choice: the server turns down a code that is gone.
  selected: (() => {
    try {
      return localStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  })(),
};
const listeners = new Set<() => void>();
function setState(next: Partial<typeof state>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The site requests go to, for code outside components (api.ts, realtime.ts). */
export const selectedSite = () => state.selected;

function select(code: string) {
  setState({ selected: code });
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* ignore */
  }
}

async function reload() {
  const r = await api.get<SiteInfo[]>('/sites');
  setState({ sites: r.data, selected: resolveSelected(state.selected || null, r.data) });
}

export function useSites() {
  const { t } = useI18n();
  const { sites, selected } = useSyncExternalStore(subscribe, () => state);
  const nameOf = (code: string) =>
    code === ALL ? (sites.length >= 3 ? t('Tất cả trang', 'All sites') : t('Cả hai trang', 'Both sites')) : (sites.find((s) => s.code === code)?.name ?? code);
  return { sites, selected, select, reload, nameOf };
}

/** A button with the chosen site's name; it opens the list of sites, then a line, then every site at once. */
export function SitePicker() {
  const { t } = useI18n();
  const { sites, selected, select, nameOf } = useSites();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('focusin', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const choose = (code: string) => {
    select(code);
    setOpen(false);
    button.current?.focus();
  };
  const codes = sites.map((s) => s.code);
  if (sites.length > 1) codes.push(ALL);

  return (
    <div className="site-picker" ref={box}>
      <button ref={button} type="button" className="site-picker-btn" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)}>
        <span className="sr-only">{t('Trang đang xem: ', 'Site shown: ')}</span>
        <span className="site-picker-name">{nameOf(selected)}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul id={listId} className="site-picker-list" aria-label={t('Chọn trang', 'Choose a site')}>
          {codes.map((code) => (
            <li key={code} className={code === ALL ? 'site-picker-all' : undefined}>
              <button type="button" aria-current={code === selected ? 'true' : undefined} onClick={() => choose(code)}>
                {nameOf(code)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The name of the site a row belongs to, in a merged list. */
export function SiteTag({ code }: { code: string }) {
  const { nameOf } = useSites();
  return <span className="tag">{nameOf(code)}</span>;
}

/** A screen that shows one site at a time: with every site chosen, it asks which one instead. */
export function SingleSiteOnly({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { sites, selected, select } = useSites();
  if (selected !== ALL) return children;
  return (
    <div className="page">
      <Empty page title={t('Màn này xem từng trang', 'This screen shows one site at a time')}>
        <p>{t('Chọn trang để xem:', 'Choose the site to show:')}</p>
        <div className="hstack">
          {sites.map((s) => (
            <button key={s.code} type="button" className="btn" onClick={() => select(s.code)}>
              {s.name}
            </button>
          ))}
        </div>
      </Empty>
    </div>
  );
}
