import { useEffect, useRef, useState } from 'react';
import type { RouteProps } from '../router/router';
import { navigate } from '../router/router';
import { normalizePage, userApi } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import type { User, Video } from '../api/types';
import { Avatar } from '../components/Avatar';
import { ThumbGrid } from '../components/ThumbGrid';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { EditIcon, VerifiedIcon } from '../components/icons';
import { pushRecent } from '../utils/recents';
import { formatCount } from '../utils/format';
import { requireAuth, updateMe, useSelf } from '../store/auth';
import { toggleFollow, useIsFollowing } from '../store/feed';
import { toast } from '../store/ui';

type Tab = 'works' | 'likes';
type Rel = 'followers' | 'following';

function EditPanel({ user, onDone }: { user: User; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(user.display_name);
  const [bio, setBio] = useState(user.bio);
  const [color, setColor] = useState(user.avatar_color);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await updateMe({ display_name: name.trim() || user.display_name, bio, avatar_color: color });
      toast('资料已更新', 'ok');
      onDone(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="edit-panel">
      <label className="field">
        <span>昵称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
      </label>
      <label className="field">
        <span>简介</span>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={120} />
      </label>
      <label className="field">
        <span>头像颜色</span>
        <div className="swatches">
          {['#fe2c55', '#25f4ee', '#8a5cff', '#ffb400', '#3ce492', '#ff6a3d'].map((c) => (
            <button
              key={c}
              className={`swatch${c === color ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`选择颜色 ${c}`}
            />
          ))}
        </div>
      </label>
      <div className="row-actions">
        <button className="btn ghost pill" onClick={() => onDone(false)}>
          取消
        </button>
        <button className="btn accent pill" onClick={save} disabled={busy}>
          保存
        </button>
      </div>
    </div>
  );
}

function RelList({ id, rel, onPick }: { id: string; rel: Rel; onPick: (u: User) => void }) {
  const state = useAsync<User[]>((signal) => userApi.list(id, rel, null, 30, signal).then((r) => r.items ?? []), [id, rel]);
  if (state.loading) return <Loading label="加载中" />;
  if (state.error) return <ErrorState text={state.error} />;
  const items = state.data ?? [];
  if (!items.length) return <EmptyState text={rel === 'followers' ? '还没有粉丝' : '还没有关注任何人'} />;
  return (
    <div className="rel-list">
      {items.map((u) => (
        <Avatar key={u.id} user={u} size={40} onClick={() => onPick(u)} className="rel-item" />
      ))}
    </div>
  );
}

export default function UserPage({ params }: RouteProps) {
  const me = useSelf();
  const requested = params.id === 'me' ? me?.id : params.id;
  const id = requested ?? '';
  const selfMode = params.id === 'me';

  useEffect(() => {
    if (selfMode && !me) navigate('/login');
  }, [selfMode, me]);

  const profile = useAsync<{ user: User; stats: { followers: number; following: number; likes_received: number; videos: number } }>(
    () => userApi.byId(id).then((r) => ({ user: r.user, stats: r.stats })),
    [id],
    !!id
  );

  useEffect(() => {
    if (profile.data) pushRecent(profile.data.user);
  }, [profile.data]);

  const [tab, setTab] = useState<Tab>('works');
  const [rel, setRel] = useState<Rel | null>(null);
  const [editing, setEditing] = useState(false);
  const [extra, setExtra] = useState<Video[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const moreCtrl = useRef<AbortController | null>(null);
  const following = useIsFollowing(profile.data?.user.id);

  const listState = useAsync<{ items: Video[]; next: string | null }>(
    (signal) =>
      userApi
        .videos(id, null, 24, tab === 'likes' ? 'likes' : undefined, signal)
        .then((raw) => {
          const page = normalizePage<Video>(raw);
          return { items: page.items, next: page.nextCursor };
        }),
    [id, tab],
    !!id
  );

  useEffect(
    () => () => {
      moreCtrl.current?.abort();
    },
    []
  );

  useEffect(() => {
    /* a page tail from the previous tab/user must not append to the list being reset */
    moreCtrl.current?.abort();
    setExtra([]);
    setNext(listState.data?.next ?? null);
  }, [listState.data]);

  const loadMore = () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    const ctrl = new AbortController();
    moreCtrl.current = ctrl;
    userApi
      .videos(id, next, 24, tab === 'likes' ? 'likes' : undefined, ctrl.signal)
      .then((raw) => {
        if (ctrl.signal.aborted) return;
        const page = normalizePage<Video>(raw);
        setExtra((list) => [...list, ...page.items]);
        setNext(page.nextCursor);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) toast('加载更多失败', 'error');
      })
      .finally(() => setMoreBusy(false));
  };

  const user = profile.data?.user;
  const stats = profile.data?.stats;
  const isSelf = !!user && !!me && user.id === me.id;

  if (!id) return <EmptyState text="请先登录" action={<button className="btn accent pill" onClick={() => navigate('/login')}>去登录</button>} />;
  if (profile.loading && !user) return <Loading label="加载主页" />;
  if (profile.error && !user) return <ErrorState text={profile.error} onRetry={profile.reload} />;
  if (!user) return <ErrorState text="用户不存在" />;

  const items = [...(listState.data?.items ?? []), ...extra];

  return (
    <div className="user-page">
      <div className="cover" style={{ background: `linear-gradient(120deg, ${user.avatar_color}55, #17171c 60%)` }}>
        <span className="cover-label">作品封面</span>
      </div>
      <div className="profile">
        <Avatar user={user} size={84} className="profile-avatar" />
        <div className="profile-main">
          <h1 className="profile-name">
            {user.display_name || user.username}
            {user.verified ? <VerifiedIcon size={16} /> : null}
          </h1>
          <p className="profile-id">
            抖音号：{user.username}
            {user.bio ? <span className="profile-bio"> · {user.bio}</span> : null}
          </p>
          <div className="profile-stats">
            <button className="stat" onClick={() => setRel('following')}>
              <strong>{formatCount(stats?.following ?? user.following_count)}</strong>
              <span>关注</span>
            </button>
            <button className="stat" onClick={() => setRel('followers')}>
              <strong>{formatCount(stats?.followers ?? user.follower_count)}</strong>
              <span>粉丝</span>
            </button>
            <span className="stat">
              <strong>{formatCount(stats?.likes_received ?? 0)}</strong>
              <span>获赞</span>
            </span>
            <span className="stat">
              <strong>{formatCount(stats?.videos ?? items.length)}</strong>
              <span>作品</span>
            </span>
          </div>
        </div>
        <div className="profile-actions">
          {isSelf ? (
            <button className="btn ghost pill" onClick={() => setEditing((v) => !v)}>
              <EditIcon size={16} />
              <span>编辑资料</span>
            </button>
          ) : (
            <>
              <button
                className={`btn pill ${following ? 'ghost' : 'accent'}`}
                onClick={() => requireAuth(() => toggleFollow(user.id))}
              >
                {following ? '已关注' : '+ 关注'}
              </button>
              <button
                className="btn outline pill"
                onClick={() => requireAuth(() => navigate(`/messages/${user.id}`))}
              >
                私信
              </button>
            </>
          )}
        </div>
        {editing && isSelf ? (
          <EditPanel
            user={user}
            onDone={(saved) => {
              setEditing(false);
              /* docs-perf-notes: updateMe only drops the GET cache for /users/, which a mounted
                 useAsync never re-reads because its [id] deps are unchanged — without this
                 reload the header keeps the old nickname and bio until a manual refresh. */
              if (saved) profile.reload();
            }}
          />
        ) : null}
      </div>
      {rel ? (
        <div className="rel-panel">
          <div className="rel-head">
            <h2>{rel === 'followers' ? '粉丝' : '关注'}</h2>
            <button className="btn ghost pill small" onClick={() => setRel(null)}>
              收起
            </button>
          </div>
          <RelList id={user.id} rel={rel} onPick={(u) => navigate(`/user/${u.id}`)} />
        </div>
      ) : null}
      <div className="tabs">
        <button className={`tab-btn${tab === 'works' ? ' on' : ''}`} onClick={() => setTab('works')}>
          作品
        </button>
        <button className={`tab-btn${tab === 'likes' ? ' on' : ''}`} onClick={() => setTab('likes')}>
          喜欢
        </button>
      </div>
      {listState.loading && !items.length ? <Loading label="加载作品" /> : null}
      {listState.error && !items.length ? <ErrorState text={listState.error} onRetry={listState.reload} /> : null}
      {!listState.loading && !items.length ? (
        <EmptyState text={tab === 'works' ? '还没有发布作品' : '还没有喜欢的视频'} />
      ) : null}
      {items.length ? (
        <>
          <ThumbGrid items={items} />
          {next ? (
            <button className="btn ghost block" onClick={loadMore} disabled={moreBusy}>
              {moreBusy ? '加载中…' : '加载更多'}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
