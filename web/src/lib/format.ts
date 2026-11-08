import { currentLang } from './i18n';

const loc = () => (currentLang() === 'en-US' ? 'en-US' : 'vi-VN');

export function fmtNum(n: number | null | undefined) {
  return new Intl.NumberFormat(loc()).format(n ?? 0);
}

export function fmtDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(loc(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export function fmtAgo(iso: string | null | undefined) {
  if (!iso) return '—';
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(Math.round(diff), 'second');
  if (abs < 2700) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso, false);
}

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} giây`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} phút ${s} giây`;
}

export function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** Highlight words of `q` in `text` (accent-insensitive). Returns segments. */
export function highlight(text: string, q: string): { s: string; hit: boolean }[] {
  const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const words = strip(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  if (!words.length) return [{ s: text, hit: false }];
  const plain = strip(text);
  // map stripped indices to original: NFD stripping keeps 1:1 length for precomposed Vietnamese letters
  const marks = new Array(text.length).fill(false);
  if (plain.length === text.length) {
    for (const w of words) {
      let i = plain.indexOf(w);
      while (i >= 0) {
        for (let k = i; k < i + w.length; k++) marks[k] = true;
        i = plain.indexOf(w, i + w.length);
      }
    }
  }
  const out: { s: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out.at(-1);
    if (last && last.hit === marks[i]) last.s += text[i];
    else out.push({ s: text[i], hit: marks[i] });
  }
  return out;
}

/** Client-side counterpart of the server's thread-link parser (for instant feedback). */
export function parseThreadInput(input: string): number | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/\/threads\/(?:[^/?#]*\.)?(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

export const isLinkLike = (s: string) => /^https?:\/\//i.test(s.trim()) || /\/threads\//.test(s);
