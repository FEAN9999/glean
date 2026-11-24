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
 */
export function usePaged<T>(path: string, size: number, extra = '', deps: unknown[] = []) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PagedData<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();
  const shownPath = useRef(path);
  const load = useCallback(
    (p: number) => {
      const isLatest = latest();
      api.get<T[]>(`${path}?page=${p}&size=${size}${extra}`, { quiet: true }).then(
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
    [path, size, extra, latest],
  );
  useEffect(() => {
    if (shownPath.current !== path) {
      shownPath.current = path;
      setData(null);
    }
    setError(null);
    setPage(1);
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);
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
