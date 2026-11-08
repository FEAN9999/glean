import { ProxyAgent, type Dispatcher } from 'undici';
import { cfg, onConfigChange } from './config.ts';
import { emit, Ev } from './events.ts';

interface ProxyState {
  line: string;
  agent: ProxyAgent;
  alive: boolean;
  failures: number;
  lastCheckedAt?: string;
}

let proxies: ProxyState[] = [];
let rr = 0;

function buildProxies() {
  for (const p of proxies) p.agent.close().catch(() => {});
  proxies = [];
  const c = cfg().proxy;
  if (!c.enabled) return;
  for (const line of c.list) {
    const [host, port, user, pass] = line.trim().split(':');
    if (!host || !port) continue;
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@` : '';
    proxies.push({ line, agent: new ProxyAgent(`http://${auth}${host}:${port}`), alive: true, failures: 0 });
  }
}

export function initNet() {
  buildProxies();
  onConfigChange((c, prev) => {
    if (JSON.stringify(c.proxy) !== JSON.stringify(prev.proxy)) buildProxies();
  });
  setInterval(() => void checkProxies(), 60_000).unref();
}

function pickProxy(): ProxyState | undefined {
  const alive = proxies.filter((p) => p.alive);
  const pool = alive.length ? alive : proxies;
  if (!pool.length) return undefined;
  return pool[rr++ % pool.length];
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`HTTP ${status} — ${url}`);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  /** Page the resource is embedded in, sent as Referer like a browser would. */
  referer?: string;
}

/** fetch through a rotating proxy (when enabled), with timeout and retry on network errors / 5xx. */
export async function fetchRaw(url: string, opts: FetchOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const proxy = pickProxy();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': cfg().source.userAgent, accept: '*/*', ...(opts.referer ? { referer: opts.referer } : {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? cfg().source.requestTimeoutMs),
        redirect: 'follow',
        // @ts-expect-error undici dispatcher is accepted by Node's fetch
        dispatcher: proxy?.agent as Dispatcher | undefined,
      });
      if (proxy) proxy.failures = 0;
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(res.status, url);
        await sleep(300 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (proxy) {
        proxy.failures++;
        if (proxy.failures >= 3 && proxy.alive) {
          proxy.alive = false;
          emit(Ev.ProxyStatus, proxyStatus());
        }
      }
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchText(url: string, opts?: FetchOpts) {
  const res = await fetchRaw(url, opts);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function proxyStatus() {
  const c = cfg().proxy;
  const alive = proxies.filter((p) => p.alive).length;
  return {
    enabled: c.enabled,
    total: proxies.length,
    alive,
    healthy: !c.enabled || proxies.length === 0 || alive > 0,
    proxies: proxies.map((p) => ({
      host: p.line.split(':').slice(0, 2).join(':'),
      alive: p.alive,
      lastCheckedAt: p.lastCheckedAt ?? null,
    })),
  };
}

export async function checkProxies() {
  if (!proxies.length) return proxyStatus();
  const target = cfg().proxy.healthCheckUrl || cfg().source.baseUrl;
  const before = proxies.map((p) => p.alive).join();
  await Promise.all(
    proxies.map(async (p) => {
      try {
        const res = await fetch(target, {
          signal: AbortSignal.timeout(8000),
          // @ts-expect-error undici dispatcher
          dispatcher: p.agent,
        });
        p.alive = res.status < 500;
      } catch {
        p.alive = false;
      }
      p.failures = 0;
      p.lastCheckedAt = new Date().toISOString();
    }),
  );
  if (before !== proxies.map((p) => p.alive).join()) emit(Ev.ProxyStatus, proxyStatus());
  return proxyStatus();
}

/** Run `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
