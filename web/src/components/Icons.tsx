import type { ReactElement } from 'react';

/** Thin-stroke 24px-grid icons drawn at 16–18px; colour follows currentColor. */

export type IconName = 'desk' | 'search' | 'archive' | 'queue' | 'sync' | 'log' | 'settings' | 'backup' | 'shield' | 'system';

const PATHS: Record<IconName, ReactElement> = {
  desk: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20.5 20.5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1.2" />
      <path d="M5 8v10.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M10 12h4" />
    </>
  ),
  queue: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth="2.6" />
    </>
  ),
  sync: (
    <>
      <path d="M19.5 12a7.5 7.5 0 0 1-13.1 5" />
      <path d="M4.5 12a7.5 7.5 0 0 1 13.1-5" />
      <path d="M17.8 3.5V7h-3.5M6.2 20.5V17h3.5" />
    </>
  ),
  log: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M19 7h1M4 17h1M11 17h9" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="8" cy="17" r="2.5" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 19 6v5.6c0 4.3-3 7.9-7 9.2-4-1.3-7-4.9-7-9.2V6z" />
      <path d="m9.2 12 2 2 3.8-3.9" />
    </>
  ),
  system: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.4M12 18.1v2.4M3.5 12h2.4M18.1 12h2.4M6 6l1.7 1.7M16.3 16.3 18 18M6 18l1.7-1.7M16.3 7.7 18 6" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Glean mark (same drawing as /mark.svg) in the accent colour. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="15" fill="var(--acc)" />
      <circle cx="16" cy="16" r="11.5" fill="none" stroke="var(--on-acc)" strokeOpacity="0.55" strokeWidth="1.5" />
      <g fill="var(--on-acc)">
        <circle cx="11" cy="11" r="1.6" />
        <circle cx="16" cy="11" r="1.6" />
        <circle cx="21" cy="11" r="1.6" />
        <circle cx="11" cy="16" r="1.6" />
        <circle cx="16" cy="16" r="1.6" />
        <circle cx="21" cy="16" r="1.6" />
        <circle cx="11" cy="21" r="1.6" />
        <circle cx="16" cy="21" r="1.6" />
        <circle cx="21" cy="21" r="2.2" />
      </g>
    </svg>
  );
}
