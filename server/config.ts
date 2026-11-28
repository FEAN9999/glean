import crypto from 'node:crypto';
import path from 'node:path';
import { all, run, now, DATA_DIR, mainAll, mainRun, mainDb, runInSite, siteCtxOrNull, NoSiteError, type StoreCtx } from './db.ts';
import { emit, Ev } from './events.ts';
import { ApiError } from './http.ts';

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
    comments: {
      enabled: boolean;
      pagesPerRun: number;
      intervalMs: number;
      maxThreadsPerRun: number;
      /** Last stored pages re-read each run to catch edits and deletions (0 = off). */
      recheckPages: number;
      /** Threads with a post this recent are re-read even when no new comments are expected. */
      recheckWithinHours: number;
      /** Threads read at the same time (auto and manual sync); pages within a thread stay in order. */
      concurrentThreads: number;
    };
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
    maxFileSizeMb: number;
    transcodeVideoToHls: boolean;
    ffmpegPath: string;
  };
  search: { semanticSearchUrl: string; semanticTopK: number; pageSize: number; minKeywordLength: number };
  auth: { issuer: string; audience: string; secret: string; accessTokenMinutes: number; refreshTokenDays: number };
  telegram: { enabled: boolean; botToken: string; chatId: string; notifyScrapeFinished: boolean; notifySyncFailed: boolean };
  maintenance: { scrape: PauseFlag; searchPost: PauseFlag; searchComment: PauseFlag };
  backup: {
    enabled: boolean;
    intervalHours: number;
    /** Automatic copies kept; older glean-auto-* files are deleted. */
    keep: number;
    /** Empty = data/backups; relative paths are under the data folder. */
    targetDir: string;
    includeMedia: boolean;
    notifyOnFail: boolean;
  };
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
      comments: { enabled: true, pagesPerRun: 2, intervalMs: 10 * 60_000, maxThreadsPerRun: 40, recheckPages: 2, recheckWithinHours: 48, concurrentThreads: 3 },
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
      maxFileSizeMb: 50,
      transcodeVideoToHls: false,
      ffmpegPath: 'ffmpeg',
    },
    search: { semanticSearchUrl: '', semanticTopK: 8, pageSize: 20, minKeywordLength: 3 },
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
    backup: { enabled: true, intervalHours: 24, keep: 7, targetDir: '', includeMedia: true, notifyOnFail: true },
  };
}

/** Sections each site keeps in the `config` table of its own store; the rest is shared, in the main store. */
export const SITE_SECTIONS = ['source', 'sync', 'scraper', 'maintenance'] as const;
/** Fields of `search` that belong to each site: a suggestion service knows the posts of one forum only. */
export const SITE_SEARCH_FIELDS = ['semanticSearchUrl', 'semanticTopK'] as const;
type SiteSection = (typeof SITE_SECTIONS)[number];
export type SharedConfig = Omit<AppConfig, SiteSection>;
/** What a site keeps in its own store. */
type SiteOwn = Pick<AppConfig, SiteSection> & { search: Pick<AppConfig['search'], (typeof SITE_SEARCH_FIELDS)[number]> };

const isSiteSection = (k: string): k is SiteSection => (SITE_SECTIONS as readonly string[]).includes(k);
const isSiteSearchField = (k: string) => (SITE_SEARCH_FIELDS as readonly string[]).includes(k);

type Listener = (cfg: AppConfig, prev: AppConfig) => void;
type SharedListener = (cfg: SharedConfig, prev: SharedConfig) => void;
const listeners: Listener[] = [];
const sharedListeners: SharedListener[] = [];
let defaults: AppConfig;
/** Shared sections, from the main store. Its `search` row also holds the main site's semantic fields. */
let shared: SharedConfig;
/** cfg() outside any site. */
let noSite: AppConfig;
/** The main site's own sections. They stay in the main store, which is the main site's store. */
let mainOwn: SiteOwn;
/** The main site once a context for it is known. The main site is the one whose store is mainDb. */
let mainCtx: StoreCtx | null = null;
/** Every other loaded site, by code. */
const others = new Map<string, { ctx: StoreCtx; own: SiteOwn }>();
/** Shared plus own settings, by site code. */
const joinedByCode = new Map<string, AppConfig>();

type DeepPartial<T> = T extends unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
/** A settings change: any fields at any depth. Lists are replaced whole, like deepMerge does. */
export type ConfigPatch = DeepPartial<AppConfig>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base)) return (patch ?? base) as T;
  const p = patch as Obj | null | undefined;
  const out: Obj = { ...base };
  for (const k of Object.keys(base)) {
    if (p && k in p) out[k] = deepMerge(base[k], p[k]);
  }
  return out as T;
}

/**
 * Smallest allowed value of the number settings that the Settings and Backup forms limit (same
 * limits as the forms show). Every other number setting may be 0 but not negative.
 */
const NUMBER_MIN: Record<string, number> = {
  'source.postsPerPage': 1,
  'source.requestTimeoutMs': 1000,
  'sync.posts.pagesPerRun': 1,
  'sync.posts.intervalMs': 60_000,
  'sync.comments.pagesPerRun': 1,
  'sync.comments.intervalMs': 60_000,
  'sync.comments.maxThreadsPerRun': 1,
  'sync.comments.recheckWithinHours': 1,
  'scraper.concurrentPages': 1,
  'scraper.concurrentImageDownloads': 1,
  'storage.maxFileSizeMb': 1,
  'search.semanticTopK': 1,
  'search.pageSize': 5,
  'search.minKeywordLength': 1,
  'auth.accessTokenMinutes': 1,
  'auth.refreshTokenDays': 1,
  'backup.intervalHours': 1,
  'backup.keep': 1,
};

/** Number settings come back as numbers within their limits; a value that is not a number takes the default. */
function cleanNumbers<T>(value: T, def: unknown, at: string): T {
  if (typeof def === 'number') {
    const n = typeof value === 'number' ? value : value === '' || value == null ? NaN : Number(value);
    return (Number.isFinite(n) ? Math.max(NUMBER_MIN[at] ?? 0, n) : def) as T;
  }
  if (!isObj(def) || !value || typeof value !== 'object') return value;
  const out = { ...value } as Obj;
  for (const k of Object.keys(def)) if (k in out) out[k] = cleanNumbers(out[k], def[k], at ? `${at}.${k}` : k);
  return out as T;
}

/**
 * The dotted path of the first value in `value` whose type differs from the default `def`, or null.
 * A missing value means "unchanged". Number settings outside lists are fixed by cleanNumbers.
 */
function wrongType(value: unknown, def: unknown, at: string, inList = false): string | null {
  if (value == null && !inList) return null;
  if (typeof def === 'number') return inList && !Number.isFinite(value) ? at : null;
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) return at;
    // A list that is empty by default (proxy.list, source.previousBaseUrls) holds text.
    const item: unknown = def.length ? def[0] : '';
    for (const [i, v] of value.entries()) {
      const w = wrongType(v, item, `${at}[${i}]`, true);
      if (w) return w;
    }
    return null;
  }
  if (isObj(def)) {
    if (!isObj(value)) return at;
    for (const k of Object.keys(def)) {
      // An item of a list replaces the old one whole, so it needs every field.
      const w = k in value || inList ? wrongType(value[k], def[k], at ? `${at}.${k}` : k, inList) : null;
      if (w) return w;
    }
    return null;
  }
  return typeof value === typeof def ? null : at;
}

/** Refuses a settings change with a value of the wrong type, before any of it is stored. */
export function assertPatchTypes(patch: unknown) {
  const w = wrongType(patch, defaults, '');
  if (w == null) return;
  const name = w || 'settings';
  throw new ApiError(400, 'INVALID_SETTING', [`Giá trị của ${name} không đúng kiểu.`, `${name} has a value of the wrong type.`], 'inline');
}

/**
 * Loads the shared sections and the main site's own sections from the main store, filling gaps from
 * defaults. Persists any missing sections. Returns the main site's settings.
 */
export function loadConfig(port: number): AppConfig {
  const site = siteCtxOrNull();
  if (site?.db === mainDb) mainCtx = site;
  const sites = shared ? loadedSites() : [];
  const prev = sites.map(configOf);
  const prevShared = shared;
  readMain(port);
  if (prevShared) {
    for (const l of sharedListeners) l(shared, prevShared);
    notify(sites, prev);
  }
  return mainCtx ? configOf(mainCtx) : joined(mainOwn);
}

/**
 * Loads a site's own sections from its store, filling gaps from defaults (with no forums) and
 * persisting them. `init` gives the address of a site whose store has no settings yet.
 */
export function loadSiteConfig(ctx: StoreCtx, init?: { baseUrl: string }): AppConfig {
  if (ctx.db === mainDb) {
    mainCtx = ctx;
    return configOf(ctx);
  }
  const prev = others.has(ctx.code) ? configOf(ctx) : undefined;
  others.set(ctx.code, { ctx, own: readSite(ctx, init) });
  joinedByCode.delete(ctx.code);
  if (prev) notify([ctx], [prev]);
  return configOf(ctx);
}

/** Stops keeping the settings of a removed site. */
export function forgetSiteConfig(code: string) {
  others.delete(code);
  joinedByCode.delete(code);
}

function readMain(port: number) {
  defaults ??= defaultConfig(port);
  const stored = readRows(null);
  const full: AppConfig = cleanNumbers(deepMerge(defaults, stored), defaults, '');
  for (const key of Object.keys(full) as (keyof AppConfig)[]) {
    if (!(key in stored)) saveSection(null, key, full[key]);
  }
  shared = Object.fromEntries(Object.entries(full).filter(([k]) => !isSiteSection(k))) as SharedConfig;
  mainOwn = ownPart(full);
  noSite = { ...shared } as AppConfig;
  for (const k of SITE_SECTIONS) {
    Object.defineProperty(noSite, k, {
      enumerable: true,
      get() {
        throw new NoSiteError();
      },
    });
  }
  joinedByCode.clear();
}

function readSite(ctx: StoreCtx, init?: { baseUrl: string }): SiteOwn {
  const stored = readRows(ctx);
  const first = init && !('source' in stored) ? { source: { baseUrl: init.baseUrl } } : {};
  const base: SiteOwn = { ...ownPart(defaults), source: { ...defaults.source, forums: [] } };
  const own: SiteOwn = cleanNumbers(deepMerge(base, { ...stored, ...first }), defaults, '');
  for (const key of Object.keys(own) as (keyof SiteOwn)[]) {
    if (!(key in stored)) saveSection(ctx, key, own[key]);
  }
  return own;
}

const ownPart = (c: AppConfig): SiteOwn => ({
  source: c.source,
  sync: c.sync,
  scraper: c.scraper,
  maintenance: c.maintenance,
  search: { semanticSearchUrl: c.search.semanticSearchUrl, semanticTopK: c.search.semanticTopK },
});

/** The `config` rows of a site's store, or with null of the main store. */
function readRows(store: StoreCtx | null): Obj {
  const sql = 'SELECT key, value FROM config';
  const rows = store ? runInSite(store, () => all<{ key: string; value: string }>(sql)) : mainAll<{ key: string; value: string }>(sql);
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

/** Saves a section in a site's store, or with null in the main store. */
function saveSection(store: StoreCtx | null, key: string, value: unknown) {
  const sql =
    'INSERT INTO config(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at';
  const json = JSON.stringify(value);
  if (store) runInSite(store, () => run(sql, key, json, now()));
  else mainRun(sql, key, json, now());
}

/** Shared settings with a site's own, in the order of the defaults. */
function joined(own: SiteOwn): AppConfig {
  const parts: Obj = { ...shared, ...own, search: { ...shared.search, ...own.search } };
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, parts[k]])) as unknown as AppConfig;
}

/** A site other than the main one, loaded on first use. */
function ownOf(site: StoreCtx): SiteOwn {
  if (!others.has(site.code)) loadSiteConfig(site);
  return others.get(site.code)!.own;
}

function configOf(site: StoreCtx): AppConfig {
  let c = joinedByCode.get(site.code);
  if (!c) joinedByCode.set(site.code, (c = joined(site.db === mainDb ? mainOwn : ownOf(site))));
  return c;
}

const loadedSites = () => [...(mainCtx ? [mainCtx] : []), ...[...others.values()].map((o) => o.ctx)];

/** Runs the listeners of each site in its context; `prev` holds each site's settings before. */
function notify(sites: StoreCtx[], prev: AppConfig[], announce = false) {
  sites.forEach((s, i) =>
    runInSite(s, () => {
      const c = configOf(s);
      for (const l of listeners) l(c, prev[i]);
      if (announce) emit(Ev.ConfigReloaded, { maintenance: c.maintenance });
    }),
  );
}

/**
 * The settings of the current site: the shared ones with the site's own. Outside any site, the
 * shared ones only; reading a site section there throws NoSiteError.
 */
export function cfg(): AppConfig {
  const site = siteCtxOrNull();
  return site ? configOf(site) : noSite;
}

/** Called in the context of each site whose settings were changed or reloaded. */
export function onConfigChange(l: Listener) {
  listeners.push(l);
}

/** Called once when the shared settings were changed or reloaded. */
export function onSharedConfigChange(l: SharedListener) {
  sharedListeners.push(l);
}

/**
 * Partial update of any sections; hot-reloads listeners. Site sections and the site's semantic
 * search fields go to the store of the current site (NoSiteError outside a site), the rest to the
 * main store.
 */
export function updateConfig(patch: ConfigPatch, port: number) {
  const site = siteCtxOrNull();
  // null when the site's sections are in the main store: the main site, or no site.
  const own = site && site.db !== mainDb ? ownOf(site) : null;
  const toMain: Obj = {};
  const toSite: Obj = {};
  let forSite = false;
  let forAll = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults)) continue;
    if (isSiteSection(key)) {
      forSite = true;
      (own ? toSite : toMain)[key] = value;
    } else if (key === 'search' && isObj(value)) {
      const mine = Object.fromEntries(Object.entries(value).filter(([k]) => isSiteSearchField(k)));
      const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !isSiteSearchField(k)));
      if (Object.keys(mine).length) {
        forSite = true;
        (own ? toSite : toMain).search = mine;
      }
      if (Object.keys(rest).length) {
        forAll = true;
        toMain.search = { ...(toMain.search as Obj | undefined), ...rest };
      }
    } else {
      forAll = true;
      toMain[key] = value;
    }
  }
  if (forSite && !site) throw new NoSiteError();

  const sites = forAll ? loadedSites() : site ? [site] : [];
  const prev = sites.map(configOf);
  const prevShared = shared;
  const def = defaults as unknown as Obj;
  const mainNow = joined(mainOwn) as unknown as Obj;
  for (const [key, value] of Object.entries(toMain)) saveSection(null, key, cleanNumbers(deepMerge(mainNow[key], value), def[key], key));
  for (const [key, value] of Object.entries(toSite)) saveSection(site, key, cleanNumbers(deepMerge((own as unknown as Obj)[key], value), def[key], key));
  if (Object.keys(toMain).length) readMain(port);
  if (site && own && Object.keys(toSite).length) others.get(site.code)!.own = readSite(site);
  joinedByCode.clear();

  if (forAll) for (const l of sharedListeners) l(shared, prevShared);
  notify(sites, prev, true);
  return cfg();
}

/** Secrets are masked when sent to the browser; a masked value sent back means "unchanged". */
export const MASK = '••••••••';
const SECRET_PATHS = ['auth.secret', 'telegram.botToken'];

/** The object that holds the last key of a dotted path such as 'auth.secret', and that key. */
function holderOf(root: unknown, path: string): [Obj | undefined, string] {
  const parts = path.split('.');
  let o = root;
  for (const k of parts.slice(0, -1)) o = isObj(o) ? o[k] : undefined;
  return [isObj(o) ? o : undefined, parts.at(-1)!];
}

export function maskedConfig(c: AppConfig): AppConfig {
  const copy = structuredClone(c);
  for (const p of SECRET_PATHS) {
    const [o, last] = holderOf(copy, p);
    if (o?.[last]) o[last] = MASK;
  }
  copy.proxy.list = copy.proxy.list.map((line) => {
    const [h, port, user, pass] = line.split(':');
    return pass ? `${h}:${port}:${user}:${MASK}` : line;
  });
  return copy;
}

/** What a `*` request may see: the shared settings, masked, without any site's own fields. */
export function maskedShared(): Partial<AppConfig> {
  const search = Object.fromEntries(Object.entries(shared.search).filter(([k]) => !isSiteSearchField(k)));
  return maskedConfig({ ...shared, search } as unknown as AppConfig);
}

export function unmaskPatch<T>(patch: T): T {
  const current = cfg();
  for (const p of SECRET_PATHS) {
    const [o, last] = holderOf(patch, p);
    if (o && o[last] === MASK) o[last] = holderOf(current, p)[0]?.[last];
  }
  const proxy = isObj(patch) ? patch.proxy : undefined;
  if (isObj(proxy) && Array.isArray(proxy.list)) {
    const old = new Map(current.proxy.list.map((l) => [l.split(':').slice(0, 3).join(':'), l]));
    proxy.list = proxy.list.map((line: string) => {
      if (!line.endsWith(MASK)) return line;
      const key = line.split(':').slice(0, 3).join(':');
      const stored = old.get(key);
      // Without a stored line for this host:port:user there is no password to restore;
      // saving the line as is would make the mask itself the password.
      if (!stored) throw new ApiError(400, 'PROXY_PASSWORD_REQUIRED', [`Nhập lại mật khẩu cho proxy ${key} (đã đổi máy chủ, cổng hoặc tài khoản).`, `Type the password for proxy ${key} again (its host, port or user changed).`], 'inline');
      return stored;
    });
  }
  return patch;
}
