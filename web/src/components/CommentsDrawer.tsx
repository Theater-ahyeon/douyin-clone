import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, User, Video } from '../api/types';
import { videoApi } from '../api/endpoints';
import { Avatar } from './Avatar';
import { CloseIcon, HeartIcon, SendIcon, SpinnerIcon, TrashIcon } from './icons';
import { Loading, EmptyState, ErrorState } from './States';
import { bumpComments, useVideo } from '../store/feed';
import { invalidate } from '../api/client';
import { requireAuth, useSelf } from '../store/auth';
import { closeComments, toast, useCommentsOpen, useCommentsVideo } from '../store/ui';
import { navigate } from '../router/router';
import { formatCount, timeAgo } from '../utils/format';

type Props = { video: Video };

function CommentRow({
  comment,
  me,
  onReply,
  onDelete
}: {
  comment: Comment;
  me: User | null;
  onReply: (c: Comment) => void;
  onDelete: (c: Comment) => void;
}) {
  return (
    <div className={`comment${comment.parent_id ? ' reply' : ''}`}>
      <Avatar user={comment.author} size={34} onClick={() => navigate(`/user/${comment.author.id}`)} />
      <div className="comment-body">
        <p className="comment-name">
          {comment.author.display_name || comment.author.username}
          <span className="comment-time">{timeAgo(comment.created_at)}</span>
        </p>
        <p className="comment-text">{comment.content}</p>
        <div className="comment-actions">
          <span className={`c-like${comment.liked ? ' on' : ''}`} title="点赞数由服务端统计">
            <HeartIcon size={15} on={comment.liked} />
            {comment.likes > 0 ? formatCount(comment.likes) : ''}
          </span>
          <button className="c-act" onClick={() => onReply(comment)}>
            回复
          </button>
          {me && comment.author.id === me.id ? (
            <button className="c-act danger" onClick={() => onDelete(comment)} aria-label="删除评论">
              <TrashIcon size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* docs-perf-notes: the drawer only ever translates in X and the list scrolls on its own,
   so opening it costs a compositor move instead of a re-layout of the feed. */
export function CommentsDrawerBody({ video }: Props) {
  const me = useSelf();
  /* the prop is a snapshot taken when the drawer opened; the header count has to follow the
     store, otherwise bumpComments moves the rail number and this one stays where it was */
  const live = useVideo(video.id) ?? video;
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    videoApi
      .comments(video.id)
      .then((raw) => {
        if (!alive) return;
        setComments(videoApi.parseComments(raw));
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '评论加载失败');
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [video.id]);

  const sorted = useMemo(() => {
    const replies = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!c.parent_id) continue;
      const list = replies.get(c.parent_id) ?? [];
      list.push(c);
      replies.set(c.parent_id, list);
    }
    const out: Comment[] = [];
    for (const top of comments.filter((c) => !c.parent_id)) {
      out.push(top);
      for (const r of replies.get(top.id) ?? []) out.push(r);
    }
    return out;
  }, [comments]);

  const scrollToEnd = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const send = () => {
    const content = text.trim();
    if (!content || sending) return;
    if (!me) {
      requireAuth();
      return;
    }
    const parentId = replyTo ? replyTo.parent_id ?? replyTo.id : null;
    const temp: Comment = {
      id: `tmp-${Math.random().toString(36).slice(2, 9)}`,
      content,
      created_at: Date.now(),
      likes: 0,
      liked: false,
      parent_id: parentId,
      author: {
        id: me.id,
        username: me.username,
        display_name: me.display_name,
        avatar_color: me.avatar_color,
        verified: me.verified
      }
    };
    setComments((list) => [...list, temp]);
    setText('');
    setReplyTo(null);
    setSending(true);
    bumpComments(video.id, 1);
    videoApi
      .addComment(video.id, content, parentId)
      .then((res) => {
        const created = res.comment ?? (Array.isArray(res.items) ? res.items[0] : undefined);
        setComments((list) => list.map((c) => (c.id === temp.id ? created ?? c : c)));
        /* the list GET is cached for 30s: without this the next open of this video's
           comments replays a response that predates the comment just posted */
        invalidate(`/videos/${video.id}/comments`);
        queueMicrotask(scrollToEnd);
      })
      .catch(() => {
        setComments((list) => list.filter((c) => c.id !== temp.id));
        bumpComments(video.id, -1);
        toast('评论发送失败', 'error');
      })
      .finally(() => setSending(false));
  };

  const remove = (c: Comment) => {
    if (c.id.startsWith('tmp-')) return;
    setComments((list) => list.filter((x) => x.id !== c.id));
    bumpComments(video.id, -1);
    videoApi
      .removeComment(c.id)
      .then(() => invalidate(`/videos/${video.id}/comments`))
      .catch(() => {
        setComments((list) => [...list, c]);
        bumpComments(video.id, 1);
        toast('删除失败', 'error');
      });
  };

  return (
    <>
      <header className="drawer-head">
        <h3>{formatCount(live.stats.comments)} 条评论</h3>
        <button className="icon-btn" onClick={closeComments} aria-label="关闭评论">
          <CloseIcon size={20} />
        </button>
      </header>
      <div className="comment-list" ref={listRef}>
        {status === 'loading' ? <Loading label="加载评论" /> : null}
        {status === 'error' ? <ErrorState text={error ?? '评论加载失败'} /> : null}
        {status === 'ready' && sorted.length === 0 ? <EmptyState text="还没有评论" hint="发一条，抢个沙发" /> : null}
        {sorted.map((c) => (
          <CommentRow key={c.id} comment={c} me={me} onReply={(x) => { setReplyTo(x); inputRef.current?.focus(); }} onDelete={remove} />
        ))}
      </div>
      <footer className="drawer-foot">
        {replyTo ? (
          <div className="reply-chip">
            <span>回复 @{replyTo.author.display_name || replyTo.author.username}</span>
            <button className="icon-btn tiny" onClick={() => setReplyTo(null)} aria-label="取消回复">
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
        <div className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder="友善评论，理性发言"
            aria-label="评论内容"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send-btn" onClick={send} disabled={sending || !text.trim()} aria-label="发送评论">
            {sending ? <SpinnerIcon size={18} /> : <SendIcon size={19} />}
          </button>
        </div>
      </footer>
    </>
  );
}

export function CommentsDrawer() {
  const commentsOpen = useCommentsOpen();
  const commentsVideo = useCommentsVideo();
  const [retained, setRetained] = useState<Video | null>(commentsVideo);

  useEffect(() => {
    if (commentsOpen && commentsVideo) setRetained(commentsVideo);
  }, [commentsOpen, commentsVideo]);

  const open = commentsOpen && !!commentsVideo;
  const shown = open ? commentsVideo : retained;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeComments();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <section className={`drawer${open ? ' open' : ''}`} aria-hidden={!open} aria-label="评论区">
      {shown ? <CommentsDrawerBody key={shown.id} video={shown} /> : null}
    </section>
  );
}
