import { useEffect, useRef, useState } from 'react';
import { useLiveRev } from '@/backend/live';
import { toApiError } from '@/backend/errors';

export interface ServerQuery<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Runs `fn` when enabled, again whenever `deps` change, and after any live mutation.
 * Stale responses from earlier calls are dropped so fast filtering never shows old results.
 */
export function useServerQuery<T>(enabled: boolean, fn: () => Promise<T>, deps: unknown[]): ServerQuery<T> {
  const rev = useLiveRev((s) => s.rev);
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const call = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const id = ++call.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (id === call.current) setData(d);
      })
      .catch((e) => {
        if (id === call.current) setError(toApiError(e).message);
      })
      .finally(() => {
        if (id === call.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rev, nonce, ...deps]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Reloads a query every `ms` while `active` (a background job it shows is queued or running), so the screen moves on to
 * the result by itself instead of staying on "Queued". Stops after `maxMs` so a stuck job does not poll forever.
 */
export function usePollWhile(active: boolean, reload: () => void, ms = 5000, maxMs = 5 * 60_000) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > maxMs) clearInterval(t);
      else ref.current();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms, maxMs]);
}
