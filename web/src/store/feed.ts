import { feedApi, normalizePage, userApi, videoApi } from '../api/endpoints';
import type { Video } from '../api/types';
import { createStore, useStore } from './reactive';
import { authStore, currentUser, isAuthed, requireAuth } from './auth';
import { toast } from './ui';

export type FeedKind = 'recommend' | 'following';

export type FeedMeta = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
};

type FeedState = {
  pages: Record<string, Video[]>;
  metas: Record<string, FeedMeta>;
  byId: Record<string, Video>;
  follows: Record<string, boolean>;
};

const EMPTY_ITEMS: Video[] = [];
const IDLE_META: FeedMeta = { status: 'idle', nextCursor: null, loadingMore: false, error: null };

const store = createStore<FeedState>({ pages: {}, metas: {}, byId: {}, follows: {} });

export const feedStore = {
  raw: store,
  get: store.get,
  patchVideo,
  patchAuthor,
  upsertVideo
};

function findVideo(state: FeedState, id: string): Video | undefined {
  if (state.byId[id]) return state.byId[id];
  for (const key in state.pages) {
    const hit = state.pages[key].find((v) => v.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function patchVideo(id: string, updater: (v: Video) => Video) {
  store.set((s) => {
    const current = findVideo(s, id);
    if (!current) return {};
    const next = updater(current);
    const pages = { ...s.pages };
    for (const key in pages) {
      const list = pages[key];
      if (!list.some((v) => v.id === id)) continue;
      pages[key] = list.map((v) => (v.id === id ? next : v));
    }
    return { pages, byId: { ...s.byId, [id]: next } };
  });
}

function patchAuthor(authorId: string, nextFollowing: boolean) {
  store.set((s) => {
    const pages = { ...s.pages };
    let touched = false;
    const byId = { ...s.byId };
    for (const key in pages) {
      const list = pages[key];
      if (!list.some((v) => v.author.id === authorId)) continue;
      pages[key] = list.map((v) => (v.author.id === authorId ? { ...v, following: nextFollowing } : v));
      touched = true;
    }
    for (const id in byId) {
      if (byId[id].author.id === authorId) {
        byId[id] = { ...byId[id], following: nextFollowing };
        touched = true;
      }
    }
    const follows = { ...s.follows, [authorId]: nextFollowing };
    if (!touched) return { follows };
    return { pages, byId, follows };
  });
}

function upsertVideo(video: Video) {
  store.set((s) => {
    const prev = findVideo(s, video.id);
    const merged = prev ? { ...prev, ...video } : video;
    const pages = { ...s.pages };
    for (const key in pages) {
      if (!pages[key].some((v) => v.id === video.id)) continue;
      pages[key] = pages[key].map((v) => (v.id === video.id ? merged : v));
    }
    return { pages, byId: { ...s.byId, [video.id]: merged } };
  });
}

export function feedKey(kind: FeedKind, userId?: string): string {
  return kind === 'following' ? `following:${userId ?? currentUser()?.id ?? 'anon'}` : 'recommend';
}

export function ensureFeed(key: string, kind: FeedKind, force = false) {
  const meta = store.get().metas[key] ?? IDLE_META;
  if (!force && (meta.status === 'loading' || meta.status === 'ready')) return;
  void requestPage(key, kind, null, true);
}

const reqSeq = new Map<string, number>();

async function requestPage(key: string, kind: FeedKind, cursor: string | null, first: boolean) {
  /* a refresh and an in-flight page tail can overlap; only the newest response for a key
     may write, otherwise the stale page gets appended on top of the fresh one */
  const seq = (reqSeq.get(key) ?? 0) + 1;
  reqSeq.set(key, seq);
  const stale = () => reqSeq.get(key) !== seq;
  if (first) store.set((s) => ({ metas: { ...s.metas, [key]: { ...IDLE_META, status: 'loading' } } }));
  else store.set((s) => ({ metas: { ...s.metas, [key]: { ...(s.metas[key] ?? IDLE_META), loadingMore: true } } }));
  try {
    const raw = await feedApi.page(kind, cursor);
    if (stale()) return;
    const { items, nextCursor } = normalizePage<Video>(raw);
    store.set((s) => {
      const prev = first ? [] : s.pages[key] ?? [];
      const seen = new Set(prev.map((v) => v.id));
      const fresh = items.filter((v) => !seen.has(v.id));
      const byId = { ...s.byId };
      for (const v of fresh) byId[v.id] = v;
      const pages = { ...s.pages, [key]: [...prev, ...fresh] };
      return {
        pages,
        byId,
        metas: {
          ...s.metas,
          [key]: { status: 'ready', nextCursor, loadingMore: false, error: null }
        }
      };
    });
    warmFollowFlags(key);
  } catch (err) {
    if (stale()) return;
    const message = err instanceof Error ? err.message : '加载失败';
    store.set((s) => ({
      metas: { ...s.metas, [key]: { ...(s.metas[key] ?? IDLE_META), status: 'error', error: message, loadingMore: false } }
    }));
  }
}

function warmFollowFlags(key: string) {
  const items = store.get().pages[key] ?? [];
  if (!items.length) return;
  store.set((s) => {
    const follows = { ...s.follows };
    for (const v of items) if (!(v.author.id in follows)) follows[v.author.id] = v.following;
    return { follows };
  });
}

export function loadMoreFeed(key: string, kind: FeedKind) {
  const meta = store.get().metas[key];
  if (!meta || meta.status === 'loading' || meta.loadingMore || !meta.nextCursor) return;
  void requestPage(key, kind, meta.nextCursor, false);
}

export function refreshFeed(key: string, kind: FeedKind) {
  ensureFeed(key, kind, true);
}

export function useFeedItems(key: string): Video[] {
  return useStore(store, (s) => s.pages[key] ?? EMPTY_ITEMS);
}

export function useFeedItem(key: string, index: number): Video | undefined {
  return useStore(store, (s) => s.pages[key]?.[index]);
}

export function useFeedMeta(key: string): FeedMeta {
  return useStore(store, (s) => s.metas[key] ?? IDLE_META);
}

export function useVideo(id: string): Video | undefined {
  return useStore(store, (s) => findVideo(s, id));
}

export function useIsFollowing(authorId: string | undefined): boolean {
  return useStore(store, (s) => (authorId ? !!s.follows[authorId] : false));
}

let lastUid: string | null | undefined;
authStore.subscribe(() => {
  const uid = authStore.get().user?.id ?? null;
  if (uid === lastUid) return;
  /* docs-perf-notes: only a real session switch throws the feed cache away; unrelated auth
     UI updates (sheet open/close) must not blank the feed the user is watching. */
  lastUid = uid;
  store.set({ pages: {}, metas: {}, byId: {}, follows: {} });
});

export function toggleLike(video: Video) {
  requireAuth(() => {
    /* read the live entry, not the card's prop: two taps inside one frame would otherwise
       both toggle from the same stale baseline and the second request goes out wrong */
    const baseline = findVideo(store.get(), video.id) ?? video;
    const prevLiked = baseline.liked;
    const prevLikes = baseline.stats.likes;
    patchVideo(video.id, (v) => ({
      ...v,
      liked: !prevLiked,
      stats: { ...v.stats, likes: Math.max(0, v.stats.likes + (prevLiked ? -1 : 1)) }
    }));
    const call = prevLiked ? videoApi.unlike(video.id) : videoApi.like(video.id);
    call
      .then((res) => {
        const liked = typeof res?.liked === 'boolean' ? res.liked : !prevLiked;
        const likes = typeof res?.likes === 'number' ? res.likes : prevLikes + (liked ? 1 : -1);
        patchVideo(video.id, (v) => ({ ...v, liked, stats: { ...v.stats, likes } }));
      })
      .catch(() => {
        patchVideo(video.id, (v) => ({ ...v, liked: prevLiked, stats: { ...v.stats, likes: prevLikes } }));
        toast('操作失败，请稍后重试', 'error');
      });
  });
}

export function toggleFavorite(video: Video) {
  requireAuth(() => {
    const baseline = findVideo(store.get(), video.id) ?? video;
    const prevOn = baseline.favorited;
    const prevCount = baseline.stats.favorites;
    patchVideo(video.id, (v) => ({
      ...v,
      favorited: !prevOn,
      stats: { ...v.stats, favorites: Math.max(0, v.stats.favorites + (prevOn ? -1 : 1)) }
    }));
    const call = prevOn ? videoApi.unfavorite(video.id) : videoApi.favorite(video.id);
    call
      .then((res) => {
        const favorited = typeof res?.favorited === 'boolean' ? res.favorited : !prevOn;
        const favorites = typeof res?.favorites === 'number' ? res.favorites : prevCount + (favorited ? 1 : -1);
        patchVideo(video.id, (v) => ({ ...v, favorited, stats: { ...v.stats, favorites } }));
      })
      .catch(() => {
        patchVideo(video.id, (v) => ({
          ...v,
          favorited: prevOn,
          stats: { ...v.stats, favorites: prevCount }
        }));
        toast('操作失败，请稍后重试', 'error');
      });
  });
}

export function toggleFollow(authorId: string) {
  requireAuth(() => {
    const on = !store.get().follows[authorId];
    patchAuthor(authorId, on);
    const call = on ? userApi.follow(authorId) : userApi.unfollow(authorId);
    call
      .then((res) => patchAuthor(authorId, typeof res?.following === 'boolean' ? res.following : on))
      .catch(() => {
        patchAuthor(authorId, !on);
        toast(on ? '关注失败' : '取消关注失败', 'error');
      });
  });
}

export function bumpComments(videoId: string, delta: number) {
  patchVideo(videoId, (v) => ({ ...v, stats: { ...v.stats, comments: Math.max(0, v.stats.comments + delta) } }));
}

/* docs-perf-notes: Electron has no window.prompt and Android WebView cancels the call, and
   navigator.clipboard is undefined whenever the page is served from an insecure origin, so a
   clipboard-only share was a silent no-op on both native shells. The selection copy is the
   fallback that works everywhere; transient activation lasts long enough for it to run after
   the async clipboard attempt has already rejected. The race is not paranoia — an unfocused
   document leaves writeText pending forever, which would leave the button with no feedback. */
const CLIPBOARD_BUDGET_MS = 400;

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      const copied = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), CLIPBOARD_BUDGET_MS)),
      ]);
      if (copied) return true;
    }
  } catch {
    /* permission or document focus denied */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-10000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function shareVideo(video: Video) {
  if (!isAuthed()) {
    requireAuth(() => shareVideo(video));
    return;
  }
  const link = `${location.origin}/#/video/${video.id}`;
  /* A denied clipboard must not swallow the action: the share is counted either way, and when
     the copy fails the toast shows the link itself instead of an error the user can't act on. */
  void copyText(link).then((copied) => toast(copied ? '链接已复制' : link, copied ? 'ok' : 'info'));
  const baseline = findVideo(store.get(), video.id) ?? video;
  const prev = baseline.stats.shares;
  patchVideo(video.id, (v) => ({ ...v, stats: { ...v.stats, shares: v.stats.shares + 1 } }));
  videoApi.share(video.id).then(
    (res) => patchVideo(video.id, (v) => ({ ...v, stats: { ...v.stats, shares: res.shares } })),
    () => patchVideo(video.id, (v) => ({ ...v, stats: { ...v.stats, shares: prev } }))
  );
}

const viewed = new Set<string>();
export function reportView(videoId: string) {
  if (viewed.has(videoId)) return;
  viewed.add(videoId);
  void videoApi
    .view(videoId)
    .then((res) => {
      const views = (res as { views?: number } | undefined)?.views;
      if (typeof views === 'number') patchVideo(videoId, (v) => ({ ...v, stats: { ...v.stats, views } }));
    })
    .catch(() => {
      viewed.delete(videoId);
    });
}
