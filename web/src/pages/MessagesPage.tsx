import { useEffect, useRef, useState } from 'react';
import type { RouteProps } from '../router/router';
import { navigate } from '../router/router';
import { chatApi } from '../api/endpoints';
import type { Conversation, Message } from '../api/types';
import { Avatar } from '../components/Avatar';
import { BackIcon, SendIcon, SpinnerIcon } from '../components/icons';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useSelf } from '../store/auth';
import { timeAgo } from '../utils/format';

export default function MessagesPage({ params }: RouteProps) {
  const peer = params.peer ?? '';
  const me = useSelf();
  const convs = useAsync<Conversation[]>(() => chatApi.conversations(), []);
  const [thread, setThread] = useState<Message[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [peerName, setPeerName] = useState('');

  useEffect(() => {
    if (!peer) return;
    let alive = true;
    setStatus('loading');
    const load = () =>
      chatApi
        .messages(peer)
        .then((items) => {
          if (!alive) return;
          setThread(items);
          setStatus('ready');
        })
        .catch(() => {
          if (!alive) return;
          setStatus('error');
        });
    void load();
    const id = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [peer]);

  useEffect(() => {
    const found = (convs.data ?? []).find((c) => c.peer?.id === peer);
    if (found) setPeerName(found.peer.display_name || found.peer.username);
  }, [convs.data, peer]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const send = () => {
    const content = text.trim();
    if (!content || !peer || sending) return;
    const temp: Message = {
      id: `tmp-${Math.random().toString(36).slice(2, 9)}`,
      content,
      created_at: Date.now(),
      from_me: true
    };
    setThread((list) => [...list, temp]);
    setText('');
    setSending(true);
    chatApi
      .send(peer, content)
      .then((res) => {
        const created = res.message;
        setThread((list) => list.map((m) => (m.id === temp.id ? created ?? m : m)));
      })
      .catch(() => {
        setThread((list) => list.filter((m) => m.id !== temp.id));
        setStatus('ready');
      })
      .finally(() => setSending(false));
  };

  const items = convs.data ?? [];

  return (
    <div className="msg-page">
      <aside className={`conv-list${peer ? ' hide-mobile' : ''}`}>
        <div className="page-head tight">
          <h1>私信</h1>
        </div>
        {convs.loading && !items.length ? <Loading label="加载会话" /> : null}
        {convs.error && !items.length ? <ErrorState text={convs.error} onRetry={convs.reload} /> : null}
        {!convs.loading && !items.length ? <EmptyState text="还没有会话" hint="在作者主页点「私信」开始聊天" /> : null}
        {items.map((c) => (
          <button
            key={c.peer.id}
            className={`conv${c.peer.id === peer ? ' on' : ''}`}
            onClick={() => navigate(`/messages/${c.peer.id}`)}
          >
            <Avatar user={c.peer} size={40} />
            <div className="conv-main">
              <p className="conv-name">{c.peer.display_name || c.peer.username}</p>
              <p className="conv-last">{c.last?.content ?? '暂无消息'}</p>
            </div>
            {c.unread > 0 ? <span className="badge">{c.unread}</span> : null}
          </button>
        ))}
      </aside>
      <section className={`thread${peer ? ' show-mobile' : ''}`}>
        {!peer ? (
          <div className="thread-empty">
            <p>选择一个会话开始聊天</p>
          </div>
        ) : (
          <>
            <header className="thread-head">
              <button className="icon-btn only-mobile" onClick={() => navigate('/messages')} aria-label="返回列表">
                <BackIcon size={20} />
              </button>
              <strong>{peerName || '对话'}</strong>
              {me ? <span className="thread-sub">和 {me.display_name || me.username} 的对话</span> : null}
            </header>
            <div className="bubbles" ref={listRef}>
              {status === 'loading' ? <Loading label="加载消息" /> : null}
              {status === 'error' ? <ErrorState text="消息加载失败" /> : null}
              {status === 'ready' && !thread.length ? <EmptyState text="还没有消息" hint="发一条打个招呼" /> : null}
              {thread.map((m) => (
                <div key={m.id} className={`bubble-row${m.from_me ? ' me' : ''}`}>
                  <div className="bubble">
                    {m.content}
                    <span className="bubble-time">{timeAgo(m.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
            <footer className="thread-foot">
              <input
                value={text}
                placeholder="发送消息…"
                aria-label="消息内容"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send();
                }}
              />
              <button className="send-btn" onClick={send} disabled={sending || !text.trim()} aria-label="发送">
                {sending ? <SpinnerIcon size={18} /> : <SendIcon size={19} />}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
