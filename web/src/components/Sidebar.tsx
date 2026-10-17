import { useEffect, useState } from 'react';
import { Link } from '../router/Link';
import { useRoute } from '../router/router';
import { Avatar } from './Avatar';
import { BrandMark, FriendIcon, HomeIcon, LiveIcon, MeIcon, FollowIcon } from './icons';
import { useAuthStatus, useSelf } from '../store/auth';
import { readRecents, type RecentUser } from '../utils/recents';

const NAV = [
  { to: '/', label: '推荐', Icon: HomeIcon },
  { to: '/follow', label: '关注', Icon: FollowIcon },
  { to: '/friends', label: '朋友', Icon: FriendIcon },
  { to: '/my', label: '我的', Icon: MeIcon },
  { to: '/live', label: '直播', Icon: LiveIcon }
];

function isActive(route: string, to: string) {
  if (to === '/') return route === '/' || route === '';
  return route === to || route.startsWith(`${to}/`);
}

export function Sidebar() {
  const route = useRoute();
  const user = useSelf();
  const status = useAuthStatus();
  const [recents, setRecents] = useState<RecentUser[]>([]);

  useEffect(() => {
    setRecents(readRecents());
    const onFocus = () => setRecents(readRecents());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [route.path]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark size={30} />
        <div className="brand-text">
          <strong>FastVideo</strong>
          <span>短视频社区</span>
        </div>
      </div>
      <nav className="nav">
        {NAV.map(({ to, label, Icon }) => (
          <Link key={to} to={to} className={`nav-row ${isActive(route.path, to) ? 'active' : ''}`}>
            <Icon size={22} on={isActive(route.path, to)} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="side-sep" />
      <div className="recent">
        <p className="side-title">最近登录</p>
        {status === 'ready' && user ? (
          <Link to="/my" className="recent-row">
            <Avatar user={user} size={28} />
            <span className="recent-name">{user.display_name || user.username}</span>
          </Link>
        ) : (
          <Link to="/login" className="recent-row">
            <span className="recent-dot" />
            <span className="recent-name">登录账号</span>
          </Link>
        )}
        {recents.slice(0, 4).map((r) => (
          <Link key={r.id} to={`/user/${r.id}`} className="recent-row">
            <Avatar user={r} size={24} />
            <span className="recent-name">{r.display_name}</span>
          </Link>
        ))}
      </div>
      <div className="side-foot">
        <span>Fan club</span>
        <span>关于</span>
        <span>帮助</span>
      </div>
    </aside>
  );
}
