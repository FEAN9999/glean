import { currentLang } from './i18n';

/**
 * HTTP client:
 *  - attaches the Bearer token and Accept-Language
 *  - on 401 refreshes the token once (single-flight) and replays the request
 *  - reads the `error-message-type` header to decide how an error is surfaced
 *  - retries idempotent requests on network failure, never on FEATURE_PAUSED
 */

export interface Envelope<T> {
  success: boolean;
  data: T;
  total?: number;
  message?: string;
  code?: string;
  [k: string]: unknown;
}

export class ApiErr extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public display: 'toast' | 'inline' | 'silent' | 'banner',
  ) {
    super(message);
  }
}

interface Session {
  accessToken: string;
  refreshToken: string;
  userId: number;
}

const SKEY = 'sang.session';
let session: Session | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(SKEY) ?? 'null');
  } catch {
    return null;
  }
})();

type Listener = () => void;
const authListeners = new Set<Listener>();
export const onAuthChange = (l: Listener) => {
  authListeners.add(l);
  return () => {
    authListeners.delete(l);
  };
};

export function setSession(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(SKEY, JSON.stringify(s));
    else localStorage.removeItem(SKEY);
  } catch {
    /* ignore */
  }
  authListeners.forEach((l) => l());
}
export const hasSession = () => !!session;
export const getSession = () => session;

/* error surfacing hooks, wired by the UI layer */
type ErrorSink = (e: ApiErr) => void;
let toastSink: ErrorSink = () => {};
let bannerSink: ErrorSink = () => {};
export function setErrorSinks(toast: ErrorSink, banner: ErrorSink) {
  toastSink = toast;
  bannerSink = banner;
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!session) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`/api/auth/refresh/${session!.userId}/${encodeURIComponent(session!.refreshToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        setSession(null);
        return false;
      }
      const body = await res.json();
      setSession({ accessToken: body.data.accessToken, refreshToken: body.data.refreshToken, userId: body.data.userId });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface ReqOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** override how errors are surfaced; default follows the server header */
  quiet?: boolean;
}

let sudoToken: string | null = null;
export const setSudoToken = (t: string | null) => (sudoToken = t);
export const getSudoToken = () => sudoToken;

export async function request<T = any>(path: string, opts: ReqOpts = {}): Promise<Envelope<T>> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const idempotent = method === 'GET';
  let attempt = 0;
  let replayed = false;
  for (;;) {
    const headers: Record<string, string> = {
      'accept-language': currentLang(),
      ...(opts.headers ?? {}),
    };
    if (session) headers.authorization = `Bearer ${session.accessToken}`;
    if (sudoToken) headers['x-sudo-token'] = sudoToken;
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body ?? {});
    }
    let res: Response;
    try {
      res = await fetch(`/api${path}`, { method, headers, body });
    } catch (e) {
      if (idempotent && attempt < 2) {
        attempt++;
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      const err = new ApiErr(0, 'NETWORK', 'Không kết nối được máy chủ. Kiểm tra máy chủ Sàng có đang chạy không.', 'toast');
      if (!opts.quiet) toastSink(err);
      throw err;
    }
    if (res.status === 401 && session && !replayed && !path.startsWith('/auth/login')) {
      replayed = true;
      if (await refresh()) continue;
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (res.ok && json?.success) return json;
    const display = (res.headers.get('error-message-type') as ApiErr['display']) ?? 'toast';
    const err = new ApiErr(res.status, json?.code ?? 'ERROR', json?.message ?? `Lỗi ${res.status}`, display);
    if (idempotent && res.status >= 502 && attempt < 2 && err.code !== 'FEATURE_PAUSED') {
      attempt++;
      await new Promise((r) => setTimeout(r, 400 * attempt));
      continue;
    }
    if (!opts.quiet) {
      if (err.display === 'toast') toastSink(err);
      if (err.display === 'banner') bannerSink(err);
    }
    throw err;
  }
}

export const api = {
  get: <T = any>(p: string, o?: ReqOpts) => request<T>(p, { ...o, method: 'GET' }),
  post: <T = any>(p: string, body?: unknown, o?: ReqOpts) => request<T>(p, { ...o, method: 'POST', body: body ?? {} }),
  put: <T = any>(p: string, body?: unknown, o?: ReqOpts) => request<T>(p, { ...o, method: 'PUT', body: body ?? {} }),
  del: <T = any>(p: string, o?: ReqOpts) => request<T>(p, { ...o, method: 'DELETE' }),
};

/** After login/refresh the browser gets an httpOnly cookie so <img> and EventSource are authorised too. */
export async function establishBrowserSession() {
  try {
    await api.post('/auth/browser-session', {}, { quiet: true });
  } catch {
    /* ignore */
  }
}

export async function logout() {
  try {
    await api.post('/auth/logout', { refreshToken: session?.refreshToken }, { quiet: true });
    await api.post('/auth/browser-session/clear', {}, { quiet: true });
  } catch {
    /* ignore */
  }
  setSession(null);
}
