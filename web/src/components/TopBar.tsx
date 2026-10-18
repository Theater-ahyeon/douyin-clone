import { useEffect, useRef, useState } from 'react';
import { Link } from '../router/Link';
import { navigate, useRoute } from '../router/router';
import { Avatar } from './Avatar';
import { SearchIcon, MessageIcon, UploadIcon } from './icons';
import { requireAuth, useAuthStatus, useSelf } from '../store/auth';
import { useDebounced } from '../hooks/useDebounced';

export function TopBar() {
  const route = useRoute();
  const user = useSelf();
  const status = useAuthStatus();
  const q = route.query.get('q') ?? '';
  const [text, setText] = useState(q);
  const typed = useRef(false);

  useEffect(() => {
    if (route.path !== '/search') return;
    typed.current = false;
    setText(q);
  }, [q, route.path]);

  const debounced = useDebounced(text, 250);
  useEffect(() => {
    /* only a keystroke may rewrite the URL: a settled debounce still holding the previous
       query would otherwise replace a hashtag link's q and bounce the user back to old results */
    if (route.path !== '/search' || !typed.current || !debounced.trim() || debounced === q) return;
    navigate(`/search?q=${encodeURIComponent(debounced.trim())}`, true);
  }, [debounced, q, route.path]);

  const submit = () => {
    if (!text.trim()) return;
    navigate(`/search?q=${encodeURIComponent(text.trim())}`);
  };

  return (
    <header className="topbar">
      <div className="search-wrap">
        <SearchIcon className="search-ico" />
        <input
          id="global-search"
          className="search-input"
          value={text}
          placeholder="搜索用户、视频和话题"
          onChange={(e) => {
            typed.current = true;
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          aria-label="搜索"
        />
        <kbd className="hint-chip">Ctrl K</kbd>
      </div>
      <div className="topbar-right">
        <button className="btn accent pill" onClick={() => requireAuth(() => navigate('/upload'))}>
          <UploadIcon size={18} strokeWidth={2.1} />
          <span>上传</span>
        </button>
        <button className="icon-btn" title="消息" aria-label="消息" onClick={() => requireAuth(() => navigate('/messages'))}>
          <MessageIcon size={21} />
        </button>
        {status === 'ready' && user ? (
          <Link to="/my" className="me-chip" title="我的主页">
            <Avatar user={user} size={32} />
          </Link>
        ) : (
          <button className="btn outline pill" onClick={() => navigate('/login')}>
            登录
          </button>
        )}
      </div>
    </header>
  );
}
