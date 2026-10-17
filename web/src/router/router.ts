import { createStore, useStore } from '../store/reactive';

export type RouteState = {
  raw: string;
  path: string;
  search: string;
  query: URLSearchParams;
};

export type RouteProps = { route: RouteState; params: Record<string, string> };

function read(): RouteState {
  const hash = window.location.hash.replace(/^#/, '');
  const [rawPath, rawSearch = ''] = hash.split('?');
  const path = rawPath || '/';
  return {
    raw: hash,
    path: path.startsWith('/') ? path : `/${path}`,
    search: rawSearch,
    query: new URLSearchParams(rawSearch)
  };
}

export const routerStore = createStore<RouteState>(read());

window.addEventListener(
  'hashchange',
  () => {
    const next = read();
    /* docs-perf-notes: read() builds a fresh URLSearchParams, so an Object.is pass over the
       state always sees a change; comparing the raw hash keeps a no-op navigation from
       notifying every subscriber (route + query are otherwise identical). */
    if (next.raw === routerStore.get().raw) return;
    routerStore.set(next);
  },
  { passive: true }
);

export function navigate(to: string, replace = false) {
  const next = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === next) return;
  if (replace) window.location.replace(next);
  else window.location.hash = next;
}

export function useRoute(): RouteState {
  return useStore(routerStore, (s) => s);
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(s[i]);
    else if (seg !== s[i]) return null;
  }
  return params;
}
