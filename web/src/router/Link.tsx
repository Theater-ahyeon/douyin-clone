import { createElement, type MouseEvent, type ReactNode } from 'react';
import { navigate } from './router';

type LinkProps = {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  replace?: boolean;
  onNavigate?: () => void;
};

export function Link({ to, children, className, title, replace, onNavigate }: LinkProps) {
  const href = `#${to.startsWith('/') ? to : `/${to}`}`;
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate?.();
    navigate(to, replace);
  };
  return createElement('a', { href, className, title, onClick: handle }, children);
}
