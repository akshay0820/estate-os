import { useEffect, useState } from 'react';

export interface Route {
  page: string;
  params: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { page: path || 'dashboard', params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(page: string, params?: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  const qs = q.toString();
  const next = `#/${page}${qs ? `?${qs}` : ''}`;
  if (location.hash !== next) location.hash = next;
}

/** Update query params on the current page without adding noise to the route. */
export function setParam(key: string, value: string | null) {
  const { page, params } = parse();
  if (value == null || value === '') params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  const next = `#/${page}${qs ? `?${qs}` : ''}`;
  if (location.hash !== next) location.hash = next;
}
