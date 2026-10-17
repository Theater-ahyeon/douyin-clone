import { useId, type ReactNode, type SVGProps } from 'react';

type IconProps = { size?: number; className?: string; on?: boolean; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'className'>;

function Svg({ size = 24, className, children, strokeWidth }: IconProps & { children: ReactNode; strokeWidth: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HeartIcon({ size, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <path
        d="M12 20.6 4.7 13.6a4.5 4.5 0 0 1 6.4-6.4l.9.8.9-.8a4.5 4.5 0 0 1 6.4 6.4Z"
        fill={on ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function CommentIcon({ size, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <path
        d="M4.5 5.6h15a1.9 1.9 0 0 1 1.9 1.9v8.1a1.9 1.9 0 0 1-1.9 1.9h-7.2l-5.4 3.6v-3.6h-2.4a1.9 1.9 0 0 1-1.9-1.9V7.5a1.9 1.9 0 0 1 1.9-1.9Z"
        fill={on ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function StarIcon({ size, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <path
        d="m12 3.8 2.5 5.1 5.6.8-4 4 1 5.5-5.1-2.6-5.1 2.6 1-5.5-4-4 5.6-.8Z"
        fill={on ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function ShareIcon({ size, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <path d="M12.6 4.2 20 11.5l-7.4 7.3v-3.6c-4.4 0-7.3 1.4-8.8 4.1.4-5.9 3.5-9 8.8-9.6Z" fill={on ? 'currentColor' : 'none'} />
    </Svg>
  );
}

export function DiscIcon({ size = 22, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity=".9" />
      <circle cx="12" cy="12" r="6.4" fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="1.1" />
      <circle cx="12" cy="12" r="2.1" fill="#f6f6f7" />
    </svg>
  );
}

export function PlusIcon({ size = 20, className, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  );
}

export function CheckIcon({ size = 20, className, strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="m5 12.6 4.4 4.4L19 7" />
    </Svg>
  );
}

export function CloseIcon({ size = 20, className, strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Svg>
  );
}

export function SearchIcon({ size = 20, className, strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </Svg>
  );
}

export function BackIcon({ size = 22, className, strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M14.5 5 7.5 12l7 7" />
    </Svg>
  );
}

export function HomeIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.9}>
      <path d="M6.2 4.6h11.6a1.6 1.6 0 0 1 1.6 1.6v11.6a1.6 1.6 0 0 1-1.6 1.6H6.2a1.6 1.6 0 0 1-1.6-1.6V6.2a1.6 1.6 0 0 1 1.6-1.6Z" fill={on ? 'currentColor' : 'none'} />
      <path d="M10.4 9.1 15 12l-4.6 2.9Z" fill={on ? '#12121a' : 'currentColor'} stroke="none" />
    </Svg>
  );
}

export function FollowIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <circle cx="10.4" cy="8.4" r="3.6" fill={on ? 'currentColor' : 'none'} />
      <path d="M4 19.4c0-3.2 2.9-5.4 6.4-5.4 1.3 0 2.5.3 3.5.8" fill={on ? 'currentColor' : 'none'} stroke={on ? 'none' : 'currentColor'} />
      <path d="M18 14.4v5.2M15.4 17h5.2" stroke={on ? 'currentColor' : 'currentColor'} strokeWidth={on ? 2 : 1.8} />
    </Svg>
  );
}

export function FriendIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  const w = strokeWidth ?? 1.8;
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : w}>
      <circle cx="9.2" cy="8.6" r="3.2" fill={on ? 'currentColor' : 'none'} />
      <circle cx="16.4" cy="9.6" r="2.5" fill={on ? 'currentColor' : 'none'} />
      <path d="M3.4 19.4c.4-3 2.7-4.8 5.8-4.8s5.5 1.9 5.8 4.8Z" fill={on ? 'currentColor' : 'none'} />
      <path d="M15.2 14.9c2.6-.6 4.7.9 5.3 3.4" fill="none" stroke="currentColor" strokeWidth={w} />
    </Svg>
  );
}

export function MeIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <circle cx="12" cy="8.2" r="3.8" fill={on ? 'currentColor' : 'none'} />
      <path d="M4.8 20c.5-4 3.4-6.2 7.2-6.2s6.7 2.2 7.2 6.2Z" fill={on ? 'currentColor' : 'none'} />
    </Svg>
  );
}

export function LiveIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  const w = strokeWidth ?? 1.8;
  return (
    <Svg size={size} className={className} strokeWidth={w}>
      <rect x="4.4" y="7.4" width="15.2" height="11.2" rx="2.2" fill={on ? 'currentColor' : 'none'} stroke={on ? 'none' : 'currentColor'} />
      <circle cx="12" cy="13" r="2.1" fill={on ? '#12121a' : 'currentColor'} stroke="none" />
      <path d="M7.6 5.1a6.4 6.4 0 0 1 8.8 0" fill="none" />
    </Svg>
  );
}

export function UploadIcon({ size = 22, className, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 16.4V5.6M8.2 9.2 12 5.5l3.8 3.7" />
      <path d="M4.6 14.4v3.2a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-3.2" />
    </Svg>
  );
}

export function MessageIcon({ size = 22, className, on, strokeWidth }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={on ? 0 : strokeWidth ?? 1.8}>
      <path d="M4.8 5.6h14.4a1.8 1.8 0 0 1 1.8 1.8v7a1.8 1.8 0 0 1-1.8 1.8h-8l-4.6 3v-3H4.8A1.8 1.8 0 0 1 3 14.4v-7a1.8 1.8 0 0 1 1.8-1.8Z" fill={on ? 'currentColor' : 'none'} />
    </Svg>
  );
}

export function SendIcon({ size = 20, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3.6 11.4 20.4 4.4 14 20.2l-2.7-6.1Z" fill="currentColor" />
    </svg>
  );
}

export function VolumeIcon({ size = 20, className, on, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4.6 9.4h2.8L11.6 6v12L7.4 14.6H4.6Z" fill="currentColor" stroke="none" />
      {on ? (
        <>
          <path d="M14.8 9.6a3.6 3.6 0 0 1 0 4.8" fill="none" />
          <path d="M17.4 7.2a7 7 0 0 1 0 9.6" fill="none" />
        </>
      ) : (
        <path d="m15.4 9.6 4.6 4.8M20 9.6l-4.6 4.8" fill="none" />
      )}
    </Svg>
  );
}

export function PlayIcon({ size = 22, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7.6 5.2 18.4 12 7.6 18.8Z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ size = 22, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="5.4" width="3.4" height="13.2" rx="1.2" fill="currentColor" />
      <rect x="13.6" y="5.4" width="3.4" height="13.2" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function EditIcon({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4.6 19.4h3.2l9.6-9.6-3.2-3.2-9.6 9.6Z" />
      <path d="M15.6 5.2 18.8 8.4" />
    </Svg>
  );
}

export function TrashIcon({ size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4.6 7h14.8M9.4 4.2h5.2M6.6 7l.8 12.2h9.2L17.4 7" />
    </Svg>
  );
}

export function MoreIcon({ size = 20, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="6" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}

export function VerifiedIcon({ size = 15, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.6l2.9 2 3.6-.3 1 3.5 2.6 2.4-2 3 .3 3.6-3.5 1-2.3 2.7-3-1.9-3.6.3-1-3.5-2.6-2.4 2-3-.3-3.6 3.5-1Z" fill="currentColor" />
      <path d="M8.4 12.2l2.4 2.3 4.6-4.8" fill="none" stroke="#0f0f13" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SpinnerIcon({ size = 22, className }: IconProps) {
  return (
    <svg className={`spin ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" opacity=".22" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function BrandMark({ size = 30, className }: IconProps) {
  const id = useId().replace(/[:]/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#25f4ee" />
          <stop offset="100%" stopColor="#fe2c55" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="26" height="26" rx="9" fill={`url(#g${id})`} />
      <path d="M13 10.4 22 16l-9 5.6Z" fill="#0d0d10" />
      <path d="M10.4 11.6v8.8" stroke="#0d0d10" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
