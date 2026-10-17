import { memo, useCallback, type ReactNode } from 'react';
import type { Video } from '../api/types';
import { formatCount } from '../utils/format';
import { Avatar } from './Avatar';
import { CommentIcon, DiscIcon, HeartIcon, ShareIcon, StarIcon, PlusIcon, VerifiedIcon } from './icons';
import { openComments } from '../store/ui';
import { shareVideo, toggleFavorite, toggleFollow, toggleLike } from '../store/feed';
import { navigate } from '../router/router';

type Props = { video: Video };

function RailButton({
  label,
  count,
  on,
  tone,
  children,
  onClick
}: {
  label: string;
  count?: number;
  on?: boolean;
  tone?: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`rail-btn ${on ? 'on' : ''} ${tone ?? ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
    >
      <span className="rail-ico">{children}</span>
      {typeof count === 'number' ? <span className="rail-count">{count > 0 ? formatCount(count) : label}</span> : null}
    </button>
  );
}

export const ActionRail = memo(function ActionRail({ video }: Props) {
  const author = video.author;
  /* stable handler so the Avatar memo actually holds across rail re-renders */
  const openAuthor = useCallback(() => navigate(`/user/${author.id}`), [author.id]);
  return (
    <div className="action-rail">
      <div className="rail-avatar">
        <Avatar user={author} size={46} onClick={openAuthor} />
        {!video.following ? (
          <button className="follow-badge" title="关注" aria-label="关注" onClick={() => toggleFollow(author.id)}>
            <PlusIcon size={13} strokeWidth={2.6} />
          </button>
        ) : (
          <span className="follow-badge done">
            <PlusIcon size={13} strokeWidth={2.6} />
          </span>
        )}
      </div>
      <RailButton label="点赞" count={video.stats.likes} on={video.liked} tone="like" onClick={() => toggleLike(video)}>
        <HeartIcon size={30} on={video.liked} />
      </RailButton>
      <RailButton label="评论" count={video.stats.comments} onClick={() => openComments(video)}>
        <CommentIcon size={29} />
      </RailButton>
      <RailButton label="收藏" count={video.stats.favorites} on={video.favorited} tone="fav" onClick={() => toggleFavorite(video)}>
        <StarIcon size={29} on={video.favorited} />
      </RailButton>
      <RailButton label="分享" count={video.stats.shares} onClick={() => shareVideo(video)}>
        <ShareIcon size={28} />
      </RailButton>
      <div className="rail-disc" title={`${author.display_name || author.username} 的原声`}>
        <DiscIcon size={40} className="spinning" />
      </div>
      {author.verified ? (
        <span className="rail-verified">
          <VerifiedIcon size={16} />
        </span>
      ) : null}
    </div>
  );
});
