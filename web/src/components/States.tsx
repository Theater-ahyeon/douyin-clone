import type { ReactNode } from 'react';
import { SpinnerIcon } from './icons';

export function Loading({ label = '加载中' }: { label?: string }) {
  return (
    <div className="state-block">
      <SpinnerIcon className="dim" size={26} />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ text, hint, action }: { text: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state-block empty">
      <div className="empty-mark" aria-hidden="true" />
      <p className="empty-text">{text}</p>
      {hint ? <p className="empty-hint">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="state-block error">
      <p>{text}</p>
      {onRetry ? (
        <button className="btn ghost small" onClick={onRetry}>
          重新加载
        </button>
      ) : null}
    </div>
  );
}
