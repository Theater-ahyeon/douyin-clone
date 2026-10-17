import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { RouteProps, RouteState } from './router';

export type RouteMatch = {
  component: LazyExoticComponent<ComponentType<RouteProps>>;
  cacheKey: string;
  params: Record<string, string>;
};

const FeedPage = lazy(() => import('../pages/FeedPage'));
const VideoPage = lazy(() => import('../pages/VideoPage'));
const SearchPage = lazy(() => import('../pages/SearchPage'));
const UserPage = lazy(() => import('../pages/UserPage'));
const UploadPage = lazy(() => import('../pages/UploadPage'));
const MessagesPage = lazy(() => import('../pages/MessagesPage'));
const LoginPage = lazy(() => import('../pages/LoginPage'));

export function resolveRoute(route: RouteState): RouteMatch | null {
  const segs = route.path.split('/').filter(Boolean);
  switch (segs[0]) {
    case undefined:
      return { component: FeedPage, cacheKey: 'feed:recommend', params: { mode: 'recommend' } };
    case 'follow':
      return { component: FeedPage, cacheKey: 'feed:following', params: { mode: 'following' } };
    case 'friends':
    case 'live':
      return { component: FeedPage, cacheKey: `feed:recommend:${segs[0]}`, params: { mode: 'recommend' } };
    case 'my':
      return { component: UserPage, cacheKey: 'user:me', params: { id: 'me' } };
    case 'search':
      return { component: SearchPage, cacheKey: `search:${route.search}`, params: {} };
    case 'video':
      return segs[1] ? { component: VideoPage, cacheKey: `video:${segs[1]}`, params: { id: segs[1] } } : null;
    case 'user':
      return segs[1] ? { component: UserPage, cacheKey: `user:${segs[1]}`, params: { id: segs[1] } } : null;
    case 'upload':
      return { component: UploadPage, cacheKey: 'upload', params: {} };
    case 'messages':
      return {
        component: MessagesPage,
        cacheKey: `messages:${segs[1] ?? 'list'}`,
        params: segs[1] ? { peer: segs[1] } : {}
      };
    case 'login':
      return { component: LoginPage, cacheKey: 'login', params: {} };
    default:
      return null;
  }
}
