import { api, mediaUrl } from './client';
import type {
  AuthResponse,
  Comment,
  Conversation,
  Message,
  Paged,
  User,
  UserStats,
  Video
} from './types';

export type LikeResult = { liked: boolean; likes: number };
export type FavResult = { favorited: boolean; favorites: number };
export type FollowResult = { following: boolean; followers: number };
export type UploadResult = { media_key: string; url: string; bytes: number };

function asArray<T>(v: unknown, keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    for (const k of keys) {
      const candidate = (v as Record<string, unknown>)[k];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

function cursorOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = o.next_cursor ?? o.cursor ?? o.next;
  return typeof c === 'string' && c ? c : null;
}

/* docs-perf-notes: the backend answers with numeric ids while the router hands us strings;
   coercing once at the boundary keeps === comparisons (store lookups, optimistic replaces,
   React keys) honest instead of scattering String() through the components. */
export function normalizeUser<T extends { id: string | number }>(u: T | null | undefined): T {
  return { ...(u as T), id: String(u?.id ?? '') };
}

export function normalizeVideo(v: Video): Video {
  return {
    ...v,
    id: String(v.id),
    url: mediaUrl(v.url),
    poster: mediaUrl(v.poster),
    author: { ...v.author, id: String(v.author?.id ?? '') }
  };
}

export function normalizeComment(c: Comment): Comment {
  return { ...c, id: String(c.id), parent_id: c.parent_id == null ? null : String(c.parent_id), author: normalizeUser(c.author) };
}

export function normalizeMessage(m: Message): Message {
  return { ...m, id: String(m.id) };
}

export function normalizeConversation(c: Conversation): Conversation {
  return { ...c, peer: normalizeUser(c.peer), last: c.last ? normalizeMessage(c.last) : c.last };
}

export const authApi = {
  register: (username: string, password: string, display_name?: string) =>
    api.post<AuthResponse>('/auth/register', { username, password, display_name }).then(withUser),
  login: (username: string, password: string) => api.post<AuthResponse>('/auth/login', { username, password }).then(withUser),
  me: () => api.get<{ user: User }>('/users/me', { ttl: 0 }).then((r) => ({ user: normalizeUser(r.user) }))
};

function withUser(res: AuthResponse): AuthResponse {
  return { token: res.token, user: normalizeUser(res.user) };
}

export const userApi = {
  update: (patch: { display_name?: string; bio?: string; avatar_color?: string }) =>
    api.patch<{ user: User }>('/users/me', patch).then((r) => ({ user: normalizeUser(r.user) })),
  byId: (id: string) => api.get<{ user: User; stats: UserStats }>(`/users/${id}`).then((r) => ({ user: normalizeUser(r.user), stats: r.stats })),
  videos: (id: string, cursor: string | null, limit = 24, kind?: string, signal?: AbortSignal) =>
    api.get<Paged<Video>>(
      `/users/${id}/videos?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${kind ? `&kind=${kind}` : ''}`,
      { ttl: 15000, signal }
    ),
  list: (id: string, rel: 'followers' | 'following', cursor: string | null, limit = 30, signal?: AbortSignal) =>
    api
      .get<Paged<User>>(`/users/${id}/${rel}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal })
      .then((r) => ({ items: (r.items ?? []).map(normalizeUser), next_cursor: r.next_cursor ?? null })),
  follow: (id: string) => api.post<FollowResult>(`/users/${id}/follow`),
  unfollow: (id: string) => api.del<FollowResult>(`/users/${id}/follow`)
};

export const feedApi = {
  page: (kind: 'recommend' | 'following', cursor: string | null, limit = 12) =>
    api.get<Paged<Video>>(
      `${kind === 'following' ? '/following-feed' : '/feed'}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { ttl: 0 }
    )
};

export const videoApi = {
  get: (id: string) => api.get<{ video: Video }>(`/videos/${id}`).then((r) => ({ video: normalizeVideo(r.video) })),
  create: (input: {
    caption: string;
    duration: number;
    width: number;
    height: number;
    poster: string;
    media_key: string;
  }) => api.post<{ video: Video }>('/videos', input),
  like: (id: string) => api.post<LikeResult>(`/videos/${id}/like`),
  unlike: (id: string) => api.del<LikeResult>(`/videos/${id}/like`),
  favorite: (id: string) => api.post<FavResult>(`/videos/${id}/favorite`),
  unfavorite: (id: string) => api.del<FavResult>(`/videos/${id}/favorite`),
  view: (id: string) => api.post<{ views: number }>(`/videos/${id}/views`),
  share: (id: string) => api.post<{ shares: number }>(`/videos/${id}/share`),
  comments: (id: string) => api.get<unknown>(`/videos/${id}/comments`),
  addComment: (id: string, content: string, parent_id?: string | null) =>
    api
      .post<{ comment?: Comment; items?: Comment[] }>(`/videos/${id}/comments`, { content, parent_id })
      .then((res) => ({
        comment: res.comment ? normalizeComment(res.comment) : undefined,
        items: (res.items ?? []).map(normalizeComment)
      })),
  removeComment: (id: string) => api.del<unknown>(`/comments/${id}`),
  parseComments: (raw: unknown): Comment[] => asArray<Comment>(raw, ['items', 'comments']).map(normalizeComment),
  parseCursor: cursorOf
};

export const searchApi = {
  search: (q: string, cursor: string | null, limit = 20, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return api
      .get<{ videos?: Video[]; users?: User[]; items?: Video[]; next_cursor?: string | null }>(
        `/search?${params.toString()}`,
        { ttl: 20000, signal }
      )
      .then((raw) => ({
        videos: asArray<Video>(raw, ['videos', 'items']).map(normalizeVideo),
        users: asArray<User>(raw, ['users']).map(normalizeUser),
        nextCursor: cursorOf(raw)
      }));
  }
};

export const chatApi = {
  conversations: () =>
    api
      .get<unknown>('/conversations', { ttl: 0 })
      .then((raw) => asArray<Conversation>(raw, ['items', 'conversations']).map(normalizeConversation)),
  messages: (userId: string) =>
    api.get<unknown>(`/messages/${userId}`, { ttl: 0 }).then((raw) => asArray<Message>(raw, ['items', 'messages']).map(normalizeMessage)),
  send: (userId: string, content: string) =>
    api
      .post<{ message?: Message }>(`/messages/${userId}`, { content })
      .then((res) => ({ message: res.message ? normalizeMessage(res.message) : undefined }))
};

export function normalizePage<T extends Video>(page: Paged<T> | T[] | null | undefined): { items: Video[]; nextCursor: string | null } {
  const items = asArray<T>(page, ['items']);
  return {
    items: items.map(normalizeVideo),
    nextCursor: cursorOf(page)
  };
}
