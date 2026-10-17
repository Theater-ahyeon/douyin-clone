import { useEffect } from 'react';
import { closeAuthSheet, useAuthSheet } from '../store/auth';
import { AuthForm } from './AuthForm';
import { CloseIcon } from './icons';

export function AuthSheet() {
  const sheetOpen = useAuthSheet();

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAuthSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  return (
    <div className={`sheet-root ${sheetOpen ? 'open' : ''}`} aria-hidden={!sheetOpen}>
      <div className="sheet-backdrop" onClick={closeAuthSheet} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="登录">
        <button className="sheet-close icon-btn" onClick={closeAuthSheet} aria-label="关闭">
          <CloseIcon size={20} />
        </button>
        <div className="sheet-head">
          <h2>登录后继续</h2>
          <p>点赞、评论、关注和上传都需要先登录。</p>
        </div>
        <AuthForm compact />
      </div>
    </div>
  );
}
