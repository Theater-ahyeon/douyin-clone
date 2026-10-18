import { createStore, useStore } from './reactive';
import { authApi, userApi } from '../api/endpoints';
import { invalidate, getToken, setToken } from '../api/client';
import type { User } from '../api/types';

export type AuthStatus = 'idle' | 'loading' | 'anon' | 'ready';

type AuthState = {
  status: AuthStatus;
  user: User | null;
  sheetOpen: boolean;
  pending: (() => void) | null;
};

export const authStore = createStore<AuthState>({
  status: 'idle',
  user: null,
  sheetOpen: false,
  pending: null
});

/* docs-perf-notes: slice subscriptions (see store/ui.ts) — components that only need the
   session status must not re-render when the sheet opens, and vice versa. */
export function useAuthStatus(): AuthStatus {
  return useStore(authStore, (s) => s.status);
}

export function useAuthSheet(): boolean {
  return useStore(authStore, (s) => s.sheetOpen);
}

export function currentUser(): User | null {
  return authStore.get().user;
}

export function isAuthed(): boolean {
  const s = authStore.get();
  return s.status === 'ready' && !!s.user;
}

export function bootstrapAuth() {
  if (!getToken()) {
    authStore.set({ status: 'anon', user: null });
    return;
  }
  authStore.set({ status: 'loading' });
  authApi
    .me()
    .then(({ user }) => authStore.set({ status: 'ready', user }))
    .catch(() => {
      setToken(null);
      authStore.set({ status: 'anon', user: null });
    });
}

export function applySession(token: string, user: User) {
  setToken(token);
  /* every cached GET is per-viewer (liked / following flags) and the cache key has no user
     in it, so a session switch must blank it along with the feed cache */
  invalidate('');
  authStore.set({ status: 'ready', user, sheetOpen: false, pending: null });
}

export async function login(username: string, password: string): Promise<User> {
  const res = await authApi.login(username, password);
  applySession(res.token, res.user);
  return res.user;
}

export async function register(username: string, password: string, display_name?: string): Promise<User> {
  const res = await authApi.register(username, password, display_name);
  applySession(res.token, res.user);
  return res.user;
}

export function logout() {
  setToken(null);
  invalidate('');
  authStore.set({ status: 'anon', user: null });
}

export async function updateMe(patch: { display_name?: string; bio?: string; avatar_color?: string }) {
  const { user } = await userApi.update(patch);
  invalidate('/users/');
  authStore.set({ user });
  return user;
}

export function openAuthSheet(after?: (() => void) | null) {
  authStore.set({ sheetOpen: true, pending: after ?? null });
}

export function closeAuthSheet() {
  authStore.set({ sheetOpen: false, pending: null });
}

export function requireAuth(action?: () => void): boolean {
  if (isAuthed()) {
    action?.();
    return true;
  }
  openAuthSheet(action ?? null);
  return false;
}

export function useSelf(): User | null {
  return useStore(authStore, (s) => s.user);
}
