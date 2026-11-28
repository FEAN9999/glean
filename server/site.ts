import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DATA_DIR, DB_PATH, NoSiteError, mainAll, mainDb, mainGet, mainRun, now, openStore, runInSite, siteCtxOrNull, type StoreCtx } from './db.ts';
import { cfg, forgetSiteConfig, loadSiteConfig } from './config.ts';
import { ApiError, ok, sendError } from './http.ts';
import { requireSudo } from './auth.ts';

/** A forum Glean reads, with its own store. The main site's store is data/glean.db. */
export interface Site extends StoreCtx {
  name: string;
  isMain: boolean;
  /** data/sites/<code>; null for the main site, whose files stay where they always were. */
  dir: string | null;
  dbPath: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The site named by x-glean-site; null on shared routes and for `*` on merge routes. */
    site: Site | null;
  }
}

const CODE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface SiteRow {
  code: string;
  name: string;
  created_at: string;
}

let main: Site | null = null;
/** The other sites not removed, by code. */
const others = new Map<string, { site: Site; createdAt: string }>();
/** Store handles by code. A removed site's store stays open, so a run still going ends in it, and is reused if the code comes back. */
const stores = new Map<string, DatabaseSync>();
const addedListeners: ((s: Site) => void)[] = [];
const removedListeners: ((s: Site) => void)[] = [];

/** The site of data/glean.db. Its row is created the first time, named after the configured address. */
export function mainSite(): Site {
  if (main) return main;
  let row = mainGet<SiteRow>('SELECT code, name, created_at FROM site WHERE is_main=1');
  if (!row) {
    // Not cfg(): tests use mainSite() as the context of cfg() itself.
    const stored = mainGet<{ value: string }>("SELECT value FROM config WHERE key='source'");
    const baseUrl = stored ? (JSON.parse(stored.value) as { baseUrl?: string }).baseUrl : undefined;
    const { code, name } = baseUrl ? suggestSite(baseUrl) : { code: 'demo', name: 'demo' };
    row = { code, name, created_at: now() };
    mainRun('INSERT INTO site(code, name, is_main, created_at) VALUES(?,?,1,?)', code, name, row.created_at);
  }
  main = { code: row.code, name: row.name, isMain: true, dir: null, dbPath: DB_PATH, db: mainDb };
  return main;
}

/** Opens the store of every site not removed and loads its settings. */
export function initSites() {
  loadSiteConfig(mainSite());
  for (const r of mainAll<SiteRow>('SELECT code, name, created_at FROM site WHERE is_main=0 AND removed_at IS NULL'))
    others.set(r.code, { site: openSite(r.code, r.name), createdAt: r.created_at });
}

/** A site other than the main one, with its store open and its settings loaded. */
function openSite(code: string, name: string, init?: { baseUrl: string }): Site {
  const dir = path.join(DATA_DIR, 'sites', code);
  const dbPath = path.join(dir, 'glean.db');
  let db = stores.get(code);
  if (!db) stores.set(code, (db = openStore(dbPath)));
  const site: Site = { code, name, isMain: false, dir, dbPath, db };
  loadSiteConfig(site, init);
  return site;
}

/** The main site first, then the others in the order they were created. */
export function sites(): Site[] {
  const rest = [...others.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [mainSite(), ...rest.map((o) => o.site)];
}

export function siteByCode(code: string): Site | undefined {
  return code === mainSite().code ? mainSite() : others.get(code)?.site;
}

export function currentSiteOrNull(): Site | null {
  const ctx = siteCtxOrNull();
  if (!ctx) return null;
  return 'isMain' in ctx ? (ctx as Site) : (siteByCode(ctx.code) ?? null);
}

export function currentSite(): Site {
  const s = currentSiteOrNull();
  if (!s) throw new NoSiteError();
  return s;
}

export function withSite<T>(s: Site | string, fn: () => T): T {
  const site = typeof s === 'string' ? siteByCode(s) : s;
  if (!site) throw siteUnknown(String(s));
  return runInSite(site, fn);
}

/** Runs `fn` for each site in turn, inside that site. */
export async function forEachSite<T>(fn: (s: Site) => T | Promise<T>): Promise<{ site: Site; value: T }[]> {
  const out: { site: Site; value: T }[] = [];
  for (const site of sites()) out.push({ site, value: await withSite(site, () => fn(site)) });
  return out;
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** The address of a site and its old domains. */
const urlsOf = (s: Site) => withSite(s, () => [cfg().source.baseUrl, ...cfg().source.previousBaseUrls]);

export function siteForHost(host: string): Site | undefined {
  const h = normalizeHost(host);
  return sites().find((s) => urlsOf(s).some((u) => hostOf(u) === h));
}

function parseBaseUrl(raw: string): URL {
  try {
    const url = new URL(raw.trim());
    if (/^https?:$/.test(url.protocol)) return url;
  } catch {
    // falls through to the error below
  }
  throw new ApiError(400, 'INVALID_URL', ['Địa chỉ diễn đàn không hợp lệ.', 'The forum address is not valid.'], 'inline');
}

/** A code and name from a forum address: rphang.land → rphang. The demo forum is `demo`. */
export function suggestSite(baseUrl: string): { code: string; name: string } {
  const url = parseBaseUrl(baseUrl);
  if (url.pathname.replace(/\/+$/, '').endsWith('/demo-forum')) return { code: 'demo', name: 'demo' };
  const label = normalizeHost(url.hostname).split('.')[0];
  const code = label.replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 32) || 'site';
  return { code, name: label || code };
}

export function assertHostFree(url: string, exceptCode?: string) {
  const host = hostOf(url);
  const owner = host && sites().find((s) => s.code !== exceptCode && urlsOf(s).some((u) => hostOf(u) === host));
  if (owner)
    throw new ApiError(409, 'SITE_HOST_TAKEN', [`${host} đã thuộc trang "${owner.name}".`, `${host} already belongs to the site "${owner.name}".`], 'inline');
}

function cleanName(name: string) {
  const n = String(name ?? '').trim();
  if (!n) throw new ApiError(400, 'SITE_NAME_REQUIRED', ['Nhập tên trang.', 'Type a name for the site.'], 'inline');
  return n;
}

function siteByCodeOr404(code: string): Site {
  const s = siteByCode(code);
  if (!s) throw siteUnknown(code, 404);
  return s;
}

export function addSite(input: { baseUrl: string; code: string; name: string }): Site {
  const code = String(input.code ?? '').trim();
  if (!CODE.test(code))
    throw new ApiError(
      400,
      'SITE_CODE_INVALID',
      ['Mã trang chỉ gồm chữ thường, số và dấu gạch ngang, bắt đầu bằng chữ hoặc số, tối đa 32 ký tự.', 'A site code has lowercase letters, digits and hyphens only, starts with a letter or digit, and has at most 32 characters.'],
      'inline',
    );
  const name = cleanName(input.name);
  const baseUrl = String(input.baseUrl ?? '').trim();
  parseBaseUrl(baseUrl);
  if (siteByCode(code)) throw new ApiError(409, 'SITE_CODE_TAKEN', [`Mã "${code}" đã có trang dùng.`, `The code "${code}" is already used by a site.`], 'inline');
  assertHostFree(baseUrl);

  const removed = mainGet<{ created_at: string }>('SELECT created_at FROM site WHERE code=?', code);
  const createdAt = removed?.created_at ?? now();
  const site = openSite(code, name, { baseUrl });
  try {
    // A store that was there already keeps its own addresses: none may belong to another site.
    for (const u of urlsOf(site)) assertHostFree(u);
  } catch (e) {
    forgetSiteConfig(code);
    throw e;
  }
  if (removed) mainRun('UPDATE site SET name=?, removed_at=NULL WHERE code=?', name, code);
  else mainRun('INSERT INTO site(code, name, is_main, created_at) VALUES(?,?,0,?)', code, name, createdAt);
  others.set(code, { site, createdAt });
  for (const l of addedListeners) l(site);
  return site;
}

export function renameSite(code: string, name: string): Site {
  const s = siteByCodeOr404(code);
  s.name = cleanName(name);
  mainRun('UPDATE site SET name=? WHERE code=?', s.name, code);
  return s;
}

/** Takes a site off the list. Its folder and store stay, and adding the code again brings them back. */
export function removeSite(code: string) {
  const s = siteByCodeOr404(code);
  if (s.isMain) throw new ApiError(400, 'SITE_MAIN', ['Không thể gỡ trang chính.', 'The main site cannot be removed.'], 'inline');
  mainRun('UPDATE site SET removed_at=? WHERE code=?', now(), code);
  others.delete(code);
  forgetSiteConfig(code);
  for (const l of removedListeners) l(s);
}

export function onSiteAdded(l: (s: Site) => void) {
  addedListeners.push(l);
}

export function onSiteRemoved(l: (s: Site) => void) {
  removedListeners.push(l);
}

/** Where a site's sieved images are saved. */
export function siteMediaRoot(s = currentSite()): string {
  return s.isMain ? cfg().storage.basePath : path.join(s.dir!, 'media');
}

/** The URL path its images are served under. */
export function siteMediaPrefix(s = currentSite()): string {
  return s.isMain ? '/media' : `/media/sites/${s.code}`;
}

export function siteInfo(s: Site) {
  return { code: s.code, name: s.name, isMain: s.isMain, baseUrl: withSite(s, () => cfg().source.baseUrl), dir: s.dir };
}

/** The site a request is for; null means `*`, every site. */
export function requestSite(req: FastifyRequest): Site | null {
  return req.site;
}

export const siteRequired = () =>
  new ApiError(400, 'SITE_REQUIRED', ['Chưa chọn trang: yêu cầu này cần một trang cụ thể.', 'No site chosen: this request needs a specific site.'], 'inline');

const siteUnknown = (code: string, status = 400) => new ApiError(status, 'SITE_UNKNOWN', [`Không có trang "${code}".`, `There is no site "${code}".`], 'inline');

/** Routes that are the same for every site: they run outside any site. */
const SHARED_ROUTES = [
  /^\/api\/auth\//,
  /^\/api\/accounts\//,
  /^\/api\/events(\/|$)/,
  /^\/api\/backups\//,
  /^\/api\/sites(\/|$)/,
  /^\/api\/search-history\//,
  /^\/api\/posts\/search\/recent-/,
  /^\/api\/comments\/recent-/,
  /^\/api\/scrapes\/check-proxy$/,
  /^\/api\/systems\/(version|environment|notify|force-reload|test-telegram)$/,
];

/** Routes that also take `*`: every site at once. */
const MERGE_ROUTES = new Set([
  'POST /api/posts/search',
  'POST /api/posts/search/count',
  'GET /api/posts/search/suggestions',
  'POST /api/comments/search',
  'POST /api/comments/search-by-author',
  'POST /api/comments/search/count',
  'GET /api/scrapes/processed',
  'POST /api/scrapes/create-scrape',
  'PUT /api/systems/config',
]);

/** Shared routes whose tables are still read through the site helpers. */
const SHARED_IN_MAIN_STORE = [
  /^\/api\/(search-history\/|posts\/search\/recent-|comments\/recent-)/, // TEMP(Task 5): search history moves to the main store
  /^\/api\/backups\//, // TEMP(Task 10): backups cover every store
];

/**
 * Runs each /api/ request in the site its `x-glean-site` header names. `legacyMainFallback` runs a
 * request without the header in the main site, for a web app that does not send it yet.
 */
export function registerSites(app: FastifyInstance, opts: { legacyMainFallback?: boolean } = {}) {
  app.decorateRequest('site', null);
  app.addHook('onRequest', (req, reply, done) => {
    const url = req.url.split('?')[0].replace(/(.)\/+$/, '$1');
    if (!url.startsWith('/api/')) return done();
    if (SHARED_ROUTES.some((r) => r.test(url))) {
      if (opts.legacyMainFallback && SHARED_IN_MAIN_STORE.some((r) => r.test(url))) return runInSite(mainSite(), done);
      return done();
    }
    const code = req.headers['x-glean-site'];
    let site: Site | undefined;
    if (typeof code !== 'string' || !code) {
      if (!opts.legacyMainFallback) return sendError(reply, siteRequired());
      site = mainSite();
    } else if (code === '*') {
      if (!MERGE_ROUTES.has(`${req.method} ${url}`)) return sendError(reply, siteRequired());
      return done();
    } else {
      site = siteByCode(code);
      if (!site) return sendError(reply, siteUnknown(code));
    }
    req.site = site;
    runInSite(site, done);
  });

  app.get('/api/sites', async () => ok(sites().map(siteInfo)));
  app.get<{ Querystring: { baseUrl?: string } }>('/api/sites/suggest', async (req) => ok(suggestSite(String(req.query.baseUrl ?? ''))));
  app.post<{ Body: { baseUrl?: string; code?: string; name?: string } }>('/api/sites', async (req) => {
    requireSudo(req);
    const b = req.body ?? {};
    return ok(siteInfo(addSite({ baseUrl: String(b.baseUrl ?? ''), code: String(b.code ?? ''), name: String(b.name ?? '') })));
  });
  app.patch<{ Params: { code: string }; Body: { name?: string } }>('/api/sites/:code', async (req) =>
    ok(siteInfo(renameSite(req.params.code, String(req.body?.name ?? '')))),
  );
  app.delete<{ Params: { code: string } }>('/api/sites/:code', async (req) => {
    requireSudo(req);
    removeSite(req.params.code);
    return ok(true);
  });
}
