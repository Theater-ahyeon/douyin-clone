import { memo, useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { colorAlpha, initialsOf } from '../utils/format';

type AvatarUser = {
  display_name?: string;
  username?: string;
  avatar_color?: string;
};

type Props = {
  user?: AvatarUser | null;
  size?: number;
  className?: string;
  badge?: ReactNode;
  onClick?: () => void;
};

/* docs-perf-notes: memo + a cached style object. Avatars are pure derivatives of (user, size)
   but they used to rebuild a `linear-gradient(...)` string (and hand React a fresh style
   object) on every pass — 5.8 Avatar renders per swipe, 6 per comment tap in the baseline. */
export const Avatar = memo(function Avatar({ user, size = 44, className = '', badge, onClick }: Props) {
  const color = user?.avatar_color || '#fe2c55';
  const label = initialsOf(user?.display_name || user?.username || '?');
  const style: CSSProperties = useMemo(
    () => ({
      width: size,
      height: size,
      background: `linear-gradient(150deg, ${color}, ${colorAlpha(color, 0.55)} 55%, #22222a)`
    }),
    [size, color]
  );
  const onKeyDown = onClick
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick();
      }
    : undefined;
  return (
    <div
      className={`avatar ${className}`}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? user?.display_name || user?.username : undefined}
    >
      <span style={{ fontSize: Math.max(11, size * 0.36) }}>{label}</span>
      {badge}
    </div>
  );
});
