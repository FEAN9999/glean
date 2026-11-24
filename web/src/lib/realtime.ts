import { useEffect, useRef, useSyncExternalStore } from 'react';
import { establishBrowserSession } from './api';
import type { Ev as ServerEv } from '../../../server/events';

/** Realtime event codes. The type check fails if one is missing or differs from server/events.ts. */
export const Ev = {
  /** Sent by this app, not the server: the stream is back after a break and events sent meanwhile were missed. */
  Reconnected: -1,
  Hello: 0,
  SystemNotification: 1000,
  NeedReload: 2000,
  NewSearch: 3001,
  NewSearchByAuthor: 3002,
  NewCommentSearch: 3003,
  NewCommentSearchByAuthor: 3004,
  NewScrape: 4001,
  UpdateScrape: 4002,
  UpdateScrapeProcess: 4003,
  UpdateDownloadImageProcess: 4004,
  FinishScrape: 4005,
  ManualSyncProgress: 5001,
  ManualSyncComplete: 5002,
  ManualSyncFailed: 5003,
  ProxyStatus: 5101,
  AutoSyncFinished: 5102,
  ConfigReloaded: 5103,
} as const satisfies typeof ServerEv & { Reconnected: -1; Hello: 0 };

export interface RtMessage<T = any> {
  type: number;
  data: T;
  message: string | null;
}

type Handler = (m: RtMessage) => void;
const handlers = new Set<Handler>();
let es: EventSource | null = null;
let connected = false;
const connListeners = new Set<() => void>();
let clientId: number | null = null;
export let serverVersion: string | null = null;

function setConnected(v: boolean) {
  connected = v;
  connListeners.forEach((l) => l());
}

/** Whether the app wants a stream (between login and logout). */
let wanted = false;
let everOpened = false;
let retryMs = 3000;

export function connectRealtime() {
  wanted = true;
  if (es) return;
  const source = new EventSource('/api/events', { withCredentials: true });
  es = source;
  source.onopen = () => {
    retryMs = 3000;
    setConnected(true);
    if (everOpened) handlers.forEach((h) => h({ type: Ev.Reconnected, data: null, message: null }));
    everOpened = true;
  };
  source.onerror = () => {
    setConnected(false);
    // The browser reopens a dropped stream by itself, but not one the server refused (an expired
    // cookie, a proxy error while the server restarts): renew the cookie and open a new one.
    if (source.readyState !== EventSource.CLOSED || es !== source) return;
    es = null;
    setTimeout(async () => {
      if (!wanted || es) return;
      await establishBrowserSession();
      if (wanted) connectRealtime();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  };
  source.onmessage = (e) => {
    let m: RtMessage;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === Ev.Hello) {
      clientId = m.data.clientId;
      serverVersion = m.data.version;
    }
    handlers.forEach((h) => h(m));
  };
}
export function disconnectRealtime() {
  wanted = false;
  everOpened = false;
  retryMs = 3000;
  es?.close();
  es = null;
  setConnected(false);
}

export const getClientId = () => clientId;

export function useRealtimeConnected() {
  return useSyncExternalStore(
    (l) => {
      connListeners.add(l);
      return () => connListeners.delete(l);
    },
    () => connected,
  );
}

/** Subscribe to one or more event types for the lifetime of the component. */
export function useEvent(types: number | number[], handler: (m: RtMessage) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = Array.isArray(types) ? types.join(',') : String(types);
  useEffect(() => {
    const set = new Set(key.split(',').map(Number));
    const h: Handler = (m) => {
      if (set.has(m.type)) ref.current(m);
    };
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, [key]);
}
