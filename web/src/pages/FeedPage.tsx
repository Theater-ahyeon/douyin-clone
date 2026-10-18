import { useEffect, useMemo } from 'react';
import type { RouteProps } from '../router/router';
import { navigate } from '../router/router';
import { FeedScroller } from '../components/FeedScroller';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { VolumeIcon } from '../components/icons';
import { ensureFeed, feedKey, refreshFeed, useFeedItems, useFeedMeta } from '../store/feed';
import type { FeedKind } from '../store/feed';
import { useAuthStatus } from '../store/auth';
import { setSound, useSoundOn } from '../store/ui';

/* docs-perf-notes: the HUD is the only thing on this page that cares about the speaker
   toggle, so it owns that subscription. Before, a sound flip re-rendered FeedPage and
   cascaded into the scroller + every card. */
function FeedHud({ feedKey: key, kind }: { feedKey: string; kind: FeedKind }) {
  const soundOn = useSoundOn();
  return (
    <div className="feed-hud">
      <button
        className="hud-btn"
        title={soundOn ? '静音' : '外放'}
        aria-label={soundOn ? '静音' : '外放'}
        aria-pressed={!soundOn}
        onClick={() => setSound(!soundOn)}
      >
        <VolumeIcon size={17} on={soundOn} strokeWidth={1.9} />
      </button>
      <FeedRefreshButton feedKey={key} kind={kind} />
    </div>
  );
}

function FeedRefreshButton({ feedKey: key, kind }: { feedKey: string; kind: FeedKind }) {
  const { status } = useFeedMeta(key);
  return (
    <button
      className="hud-btn"
      title="刷新当前 feed"
      aria-label="刷新当前 feed"
      onClick={() => refreshFeed(key, kind)}
      disabled={status === 'loading'}
    >
      <span className={`hud-refresh${status === 'loading' ? ' spinning' : ''}`}>↻</span>
    </button>
  );
}

export default function FeedPage({ params }: RouteProps) {
  const kind: FeedKind = params.mode === 'following' ? 'following' : 'recommend';
  const key = feedKey(kind);
  const items = useFeedItems(key);
  const meta = useFeedMeta(key);
  const status = useAuthStatus();

  useEffect(() => {
    if (kind === 'following' && status !== 'ready') return;
    ensureFeed(key, kind);
  }, [key, kind, status]);

  const needLogin = kind === 'following' && status === 'anon';
  const { status: feedStatus, error: feedError } = meta;

  /* memoised so an unrelated FeedPage re-render (new meta, a toast elsewhere) cannot hand
     FeedScroller a fresh element and defeat its memo() bailout */
  const empty = useMemo(
    () =>
      needLogin ? (
        <EmptyState
          text="登录后可以看到关注人的视频"
          action={
            <button className="btn accent pill" onClick={() => navigate('/login')}>
              立即登录
            </button>
          }
        />
      ) : feedStatus === 'loading' || (feedStatus === 'idle' && items.length === 0) ? (
        <Loading label="正在为你准备视频" />
      ) : feedStatus === 'error' ? (
        <ErrorState text={feedError ?? '加载失败'} onRetry={() => refreshFeed(key, kind)} />
      ) : (
        <EmptyState text="这里还没有内容" hint={kind === 'following' ? '去关注一些创作者吧' : undefined} />
      ),
    [needLogin, feedStatus, feedError, items.length, key, kind]
  );

  return (
    <>
      <FeedScroller feedKey={key} kind={kind} items={items} empty={empty} />
      <FeedHud feedKey={key} kind={kind} />
      {meta.loadingMore ? <div className="feed-more">正在加载更多…</div> : null}
    </>
  );
}
