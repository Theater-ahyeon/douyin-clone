import { Suspense, useEffect, useMemo } from 'react';
import { useRoute } from './router/router';
import { resolveRoute } from './router/routes';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { BottomTabs } from './components/BottomTabs';
import { CommentsDrawer } from './components/CommentsDrawer';
import { AuthSheet } from './components/AuthSheet';
import { Toaster } from './components/Toaster';
import { Loading } from './components/States';
import { EmptyState } from './components/States';
import { bootstrapAuth, useAuthStatus } from './store/auth';
import { setSound, useSoundOn } from './store/ui';
import { videoPool } from './media/videoPool';

const FEED_PATHS = new Set(['/', '/follow', '/friends', '/live']);

/* docs-perf-notes: App used to subscribe to the whole ui + auth state, so a toast, a drawer
   open or a sheet close re-rendered every shell component and the feed page underneath it.
   Store readers that only need to run an effect live here instead: they render null, so a
   state change costs one tiny leaf re-render instead of the whole tree. */
function SoundBridge() {
  const soundOn = useSoundOn();

  useEffect(() => {
    videoPool.onSoundChange = (muted) => setSound(!muted);
    return () => {
      videoPool.onSoundChange = null;
    };
  }, []);

  useEffect(() => {
    videoPool.setMuted(!soundOn);
  }, [soundOn]);

  return null;
}

function BootBridge() {
  const status = useAuthStatus();

  useEffect(() => {
    document.body.classList.toggle('booting', status === 'idle' || status === 'loading');
  }, [status]);

  return null;
}

export default function App() {
  const route = useRoute();

  useEffect(() => {
    bootstrapAuth();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const match = useMemo(() => resolveRoute(route), [route]);
  const isFeed = FEED_PATHS.has(route.path);
  const View = match?.component;

  return (
    <div className="app">
      <SoundBridge />
      <BootBridge />
      <Sidebar />
      <div className="main">
        <TopBar />
        <div className={`page${isFeed ? ' page-feed' : ''}`}>
          <Suspense fallback={<Loading />}>
            {View && match ? <View key={match.cacheKey} route={route} params={match.params} /> : <EmptyState text="页面不存在" hint="从左侧导航回到推荐" />}
          </Suspense>
        </div>
      </div>
      <BottomTabs />
      <CommentsDrawer />
      <AuthSheet />
      <Toaster />
    </div>
  );
}
