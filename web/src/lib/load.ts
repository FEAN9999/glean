import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiErr, type Envelope } from './api';

/**
 * For requests that can overlap (typing, paging, switching tabs): call it when a request starts and
 * keep the check it returns. Only the newest request's check stays true, so an older answer that
 * arrives late is dropped instead of overwriting a newer one.
 */
export function useLatest() {
  const seq = useRef(0);
  return useCallback(() => {
    const id = ++seq.current;
    return () => id === seq.current;
  }, []);
}

/**
 * For reloads set off by bursts of events: a call while `run` is in flight does not start another
 * one; all such calls share a single run once the current one ends.
 */
export function singleFlight(run: () => Promise<unknown>) {
  let busy = false;
  let again = false;
  const start = (): void => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    run()
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          start();
        }
      });
  };
  return start;
}

export interface PagedData<T> {
  items: T[];
  total: number;
  /** The whole answer, for fields the list sends next to its items. */
  extra: Envelope<T[]>;
}

/**
 * One numbered page of the list at `path` (`?page=&size=` is added, then `extra`). Opening another list
 * starts empty; refiltering the same list keeps the old rows until the new ones arrive. A failed load
 * keeps what is shown and sets `error`, so a failure does not look like an empty list.
 * `site` asks that site instead of the one chosen in the picker.
 */
export function usePaged<T>(path: string, size: number, extra = '', site?: string) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PagedData<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();
  const list = `${path}?size=${size}${extra}`;
  const [shown, setShown] = useState({ path, list });
  if (shown.list !== list) {
    setShown({ path, list });
    if (shown.path !== path) setData(null);
    setError(null);
    setPage(1);
  }
  const load = useCallback(
    (p: number) => {
      const isLatest = latest();
      api.get<T[]>(`${path}?page=${p}&size=${size}${extra}`, { quiet: true, site }).then(
        (r) => {
          if (!isLatest()) return;
          setData({ items: r.data, total: r.total ?? 0, extra: r });
          setError(null);
        },
        (e) => {
          if (isLatest()) setError((e as ApiErr).message);
        },
      );
    },
    [path, size, extra, site, latest],
  );
  useEffect(() => load(1), [load]);
  return {
    data,
    error,
    page,
    setPage: (p: number) => {
      setPage(p);
      load(p);
    },
    reload: () => load(page),
  };
}
