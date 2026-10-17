import { useState, type FormEvent } from 'react';
import { closeAuthSheet, login, register } from '../store/auth';
import { authStore } from '../store/auth';
import { navigate } from '../router/router';
import { toast } from '../store/ui';
import { SpinnerIcon } from './icons';

export function AuthForm({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register(username.trim(), password, displayName.trim() || undefined);
      toast(`欢迎，${user.display_name || user.username}`, 'ok');
      const pending = authStore.get().pending;
      closeAuthSheet();
      if (pending) pending();
      else if (window.location.hash.startsWith('#/login')) navigate('/my');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`auth-form ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <div className="auth-switch">
        <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
          登录
        </button>
        <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
          注册
        </button>
      </div>
      <label className="field">
        <span>用户名</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="字母 / 数字 / 下划线" autoComplete="username" />
      </label>
      {mode === 'register' ? (
        <label className="field">
          <span>昵称</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="选填" />
        </label>
      ) : null}
      <label className="field">
        <span>密码</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 6 位"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="btn accent block" type="submit" disabled={busy}>
        {busy ? <SpinnerIcon size={18} /> : null}
        <span>{mode === 'login' ? '登录' : '注册并登录'}</span>
      </button>
      <p className="auth-tip">登录后可点赞、评论、关注和发布作品。</p>
    </form>
  );
}
