import crypto from 'node:crypto';
import path from 'node:path';
import { all, run, now, DATA_DIR } from './db.ts';
import { emit, Ev } from './events.ts';

export interface PauseFlag {
  isPaused: boolean;
  message: string;
}

export interface AppConfig {
  source: {
    baseUrl: string;
    previousBaseUrls: string[];
    forums: { id: number; name: string }[];
    postsPerPage: number;
    userAgent: string;
    requestTimeoutMs: number;
  };
  sync: {
    posts: { enabled: boolean; pagesPerRun: number; intervalMs: number };
    comments: { enabled: boolean; pagesPerRun: number; intervalMs: number; maxThreadsPerRun: number };
    commentServiceUrl: string;
  };
  scraper: {
    concurrentPages: number;
    concurrentImageDownloads: number;
    batchDelayMs: number;
    ignoredDomains: string[];
    downloadImages: boolean;
    downloadVideos: boolean;
    retentionHours: number;
    minCommentLength: number;
  };
  proxy: { enabled: boolean; list: string[]; healthCheckUrl: string };
  storage: {
    basePath: string;
    thumbnailDir: string;
    maxFileSizeMb: number;
    chunkSizeMb: number;
    concurrentUploads: number;
    transcodeVideoToHls: boolean;
    ffmpegPath: string;
  };
  search: { semanticSearchUrl: string; semanticTopK: number; pageSize: number; minKeywordLength: number };
  ai: { chatGpt: { enabled: boolean; apiKey: string }; gemini: { enabled: boolean; apiKey: string } };
  auth: { issuer: string; audience: string; secret: string; accessTokenMinutes: number; refreshTokenDays: number };
  telegram: { enabled: boolean; botToken: string; chatId: string; notifyScrapeFinished: boolean; notifySyncFailed: boolean };
  maintenance: { scrape: PauseFlag; searchPost: PauseFlag; searchComment: PauseFlag };
}

export function defaultConfig(port: number): AppConfig {
  return {
    source: {
      baseUrl: `http://127.0.0.1:${port}/demo-forum`,
      previousBaseUrls: [],
      forums: [
        { id: 1, name: 'Xe & Đường dài' },
        { id: 2, name: 'Bếp nhà' },
        { id: 3, name: 'Máy ảnh & Khoảnh khắc' },
        { id: 4, name: 'Đồ chơi công nghệ' },
      ],
      postsPerPage: 20,
      userAgent: 'Mozilla/5.0 (compatible; GleanPersonal/1.0)',
      requestTimeoutMs: 15000,
    },
    sync: {
      posts: { enabled: true, pagesPerRun: 2, intervalMs: 5 * 60_000 },
      comments: { enabled: true, pagesPerRun: 2, intervalMs: 10 * 60_000, maxThreadsPerRun: 40 },
      commentServiceUrl: '',
    },
    scraper: {
      concurrentPages: 3,
      concurrentImageDownloads: 6,
      batchDelayMs: 150,
      ignoredDomains: ['ads.example.invalid', 'tracker.example.invalid'],
      downloadImages: true,
      downloadVideos: false,
      retentionHours: 0,
      minCommentLength: 12,
    },
    proxy: { enabled: false, list: [], healthCheckUrl: '' },
    storage: {
      basePath: path.join(DATA_DIR, 'media'),
      thumbnailDir: 'thumbs',
      maxFileSizeMb: 50,
      chunkSizeMb: 5,
      concurrentUploads: 3,
      transcodeVideoToHls: false,
      ffmpegPath: 'ffmpeg',
    },
    search: { semanticSearchUrl: '', semanticTopK: 8, pageSize: 20, minKeywordLength: 3 },
    ai: { chatGpt: { enabled: false, apiKey: '' }, gemini: { enabled: false, apiKey: '' } },
    auth: {
      issuer: 'glean',
      audience: 'glean-web',
      secret: crypto.randomBytes(32).toString('hex'),
      accessTokenMinutes: 30,
      refreshTokenDays: 30,
    },
    telegram: { enabled: false, botToken: '', chatId: '', notifyScrapeFinished: true, notifySyncFailed: true },
    maintenance: {
      scrape: { isPaused: false, message: '' },
      searchPost: { isPaused: false, message: '' },
      searchComment: { isPaused: false, message: '' },
    },
  };
}

type Listener = (cfg: AppConfig, prev: AppConfig) => void;
const listeners: Listener[] = [];
let current: AppConfig;
let defaults: AppConfig;

function deepMerge<T>(base: T, patch: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T;
  const out: any = { ...base };
  for (const k of Object.keys(base as any)) {
    if (patch && k in patch) out[k] = deepMerge((base as any)[k], patch[k]);
  }
  return out;
}

/** Loads config from DB, filling gaps from defaults. Persists any missing sections. */
export function loadConfig(port: number): AppConfig {
  defaults ??= defaultConfig(port);
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM config');
  const stored: any = {};
  for (const r of rows) stored[r.key] = JSON.parse(r.value);
  // Pre-rename installs persisted the old product name in the User-Agent sent to the forum.
  if (typeof stored.source?.userAgent === 'string' && stored.source.userAgent.includes('SangPersonal/')) {
    stored.source.userAgent = stored.source.userAgent.replace('SangPersonal/', 'GleanPersonal/');
    saveSection('source', stored.source);
  }
  const merged = deepMerge(defaults, stored);
  for (const key of Object.keys(merged) as (keyof AppConfig)[]) {
    if (!(key in stored)) saveSection(key, merged[key]);
  }
  const prev = current;
  current = merged;
  if (prev) for (const l of listeners) l(current, prev);
  return current;
}

function saveSection(key: string, value: unknown) {
  run(
    'INSERT INTO config(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    key,
    JSON.stringify(value),
    now(),
  );
}

export const cfg = () => current;

export function onConfigChange(l: Listener) {
  listeners.push(l);
}

/** Partial update of any sections; hot-reloads listeners. */
export function updateConfig(patch: Partial<AppConfig>, port: number) {
  for (const key of Object.keys(patch) as (keyof AppConfig)[]) {
    if (!(key in current)) continue;
    saveSection(key, deepMerge(current[key], patch[key]));
  }
  const c = loadConfig(port);
  emit(Ev.ConfigReloaded, { maintenance: c.maintenance });
  return c;
}

/** Secrets are masked when sent to the browser; a masked value sent back means "unchanged". */
export const MASK = '••••••••';
const SECRET_PATHS = ['auth.secret', 'ai.chatGpt.apiKey', 'ai.gemini.apiKey', 'telegram.botToken'];

export function maskedConfig(c: AppConfig) {
  const copy = structuredClone(c) as any;
  for (const p of SECRET_PATHS) {
    const parts = p.split('.');
    let o = copy;
    for (const k of parts.slice(0, -1)) o = o[k];
    const last = parts.at(-1)!;
    if (o[last]) o[last] = MASK;
  }
  copy.proxy.list = copy.proxy.list.map((line: string) => {
    const [h, port, user, pass] = line.split(':');
    return pass ? `${h}:${port}:${user}:${MASK}` : line;
  });
  return copy;
}

export function unmaskPatch(patch: any) {
  for (const p of SECRET_PATHS) {
    const parts = p.split('.');
    let o = patch;
    let cur: any = current;
    for (const k of parts.slice(0, -1)) {
      o = o?.[k];
      cur = cur?.[k];
    }
    const last = parts.at(-1)!;
    if (o && o[last] === MASK) o[last] = cur[last];
  }
  if (Array.isArray(patch?.proxy?.list)) {
    const old = new Map(current.proxy.list.map((l) => [l.split(':').slice(0, 3).join(':'), l]));
    patch.proxy.list = patch.proxy.list.map((line: string) =>
      line.endsWith(MASK) ? old.get(line.split(':').slice(0, 3).join(':')) ?? line : line,
    );
  }
  return patch;
}
