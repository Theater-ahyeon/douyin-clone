import { Link } from '../router/Link';
import { navigate, useRoute } from '../router/router';
import { FriendIcon, HomeIcon, MeIcon, PlusIcon, FollowIcon } from './icons';
import { requireAuth } from '../store/auth';

export function BottomTabs() {
  const route = useRoute();
  const active = (to: string) => (to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`));
  return (
    <nav className="tabbar">
      <Link to="/" className={`tab ${active('/') ? 'on' : ''}`}>
        <HomeIcon size={22} on={active('/')} />
        <span>推荐</span>
      </Link>
      <Link to="/follow" className={`tab ${active('/follow') ? 'on' : ''}`}>
        <FollowIcon size={22} on={active('/follow')} />
        <span>关注</span>
      </Link>
      <button className="tab tab-add" onClick={() => requireAuth(() => navigate('/upload'))} aria-label="上传">
        <PlusIcon size={20} />
      </button>
      <Link to="/friends" className={`tab ${active('/friends') ? 'on' : ''}`}>
        <FriendIcon size={22} on={active('/friends')} />
        <span>朋友</span>
      </Link>
      <Link to="/my" className={`tab ${active('/my') ? 'on' : ''}`}>
        <MeIcon size={22} on={active('/my')} />
        <span>我的</span>
      </Link>
    </nav>
  );
}
