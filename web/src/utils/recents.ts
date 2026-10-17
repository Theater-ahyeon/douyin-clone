import type { User } from '../api/types';
import { store } from './storage';

export type RecentUser = Pick<User, 'id' | 'display_name' | 'avatar_color'>;

const KEY = 'recents';

export function readRecents(): RecentUser[] {
  const raw = store.get(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentUser[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(user: User | null | undefined) {
  if (!user) return;
  const entry: RecentUser = {
    id: user.id,
    display_name: user.display_name || user.username,
    avatar_color: user.avatar_color
  };
  const next = [entry, ...readRecents().filter((r) => r.id !== entry.id)].slice(0, 8);
  store.set(KEY, JSON.stringify(next));
}
