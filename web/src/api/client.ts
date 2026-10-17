import { store } from '../utils/storage';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let token: string | null = store.get('token');

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null) {
  token = next;
  if (next) store.set('token', next);
  else store.remove('token');
}

type Json = Record<string, unknown> | unknown[] | null;

const inflight = new Map<string, Promise<Json>>();
const cache = new Map<string, { at: number; data: Json }>();
const CACHE_LIMIT = 80;

function remember(key: string, data: Json) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function drop(key: string) {
  cache.delete(key);
}

export function invalidate(prefix: string) {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key);
}

type GetOptions = { signal?: AbortSignal; ttl?: number; force?: boolean };

const API_BASE = '/api';

/* docs-perf-notes: one choke point for the /api prefix keeps every call site relative (the
   dev proxy owns /api + /media) and leaves the cache keys on the logical path. */
export function apiUrl(path: string): string {
  if (/^https?:/i.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function jsonOf(res: Response, strict = true): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    /* docs-perf-notes: a 200 that is not JSON (an SPA fallback page, a proxy error) must
       surface as an error state instead of silently looking like "zero videos". */
    if (!strict) return null;
    throw new ApiError(res.status, '服务返回了无法解析的内容', 'bad_json');
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, '网络异常，请检查连接', 'network');
  }
  if (!res.ok) {
    const body = (await jsonOf(res, false)) as { error?: string; message?: string; code?: string } | null;
    throw new ApiError(res.status, body?.error ?? body?.message ?? `请求失败 (${res.status})`, body?.code ?? 'error');
  }
  return res;
}

export async function getJson<T>(path: string, opts: GetOptions = {}): Promise<T> {
  const { signal, force } = opts;
  const ttl = opts.ttl ?? 30000;
  if (!force && ttl > 0) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  }
  /* docs-perf-notes: a caller-supplied signal means "this exact component owns the
     request", so we bypass the shared in-flight promise — otherwise aborting a stale
     search would reject the promise a newer caller is still awaiting. */
  if (signal) {
    const res = await rawFetch(path, { method: 'GET', headers: authHeaders(), credentials: 'same-origin', signal });
    const data = await jsonOf(res);
    remember(path, data);
    return data as T;
  }
  let p = inflight.get(path);
  if (!p) {
    p = rawFetch(path, { method: 'GET', headers: authHeaders(), credentials: 'same-origin' })
      .then(async (res) => {
        const data = await jsonOf(res);
        remember(path, data);
        return data;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return (await p) as T;
}

async function mutate<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const init: RequestInit = { method, headers: authHeaders({ ...(headers ?? {}) }), credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = authHeaders({ 'Content-Type': 'application/json', ...(headers ?? {}) });
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await rawFetch(path, init);
  return (await jsonOf(res)) as T;
}

export const api = {
  get: <T,>(path: string, opts?: GetOptions) => getJson<T>(path, opts),
  post: <T,>(path: string, body?: unknown) => mutate<T>('POST', path, body),
  patch: <T,>(path: string, body?: unknown) => mutate<T>('PATCH', path, body),
  put: <T,>(path: string, body?: unknown) => mutate<T>('PUT', path, body),
  del: <T,>(path: string) => mutate<T>('DELETE', path),
  invalidate
};

export function mediaUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('data:') || path.startsWith('http') || path.startsWith('/')) return path;
  return `/media/${path}`;
}
