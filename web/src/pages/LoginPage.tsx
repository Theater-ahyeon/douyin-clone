import { useEffect } from 'react';
import type { RouteProps } from '../router/router';
import { navigate } from '../router/router';
import { AuthForm } from '../components/AuthForm';
import { BrandMark } from '../components/icons';
import { useAuthStatus } from '../store/auth';

export default function LoginPage(_props: RouteProps) {
  const status = useAuthStatus();

  useEffect(() => {
    if (status === 'ready') navigate('/my', true);
  }, [status]);

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={40} />
          <div>
            <strong>FastVideo</strong>
            <span>记录美好的短视频社区</span>
          </div>
        </div>
        <AuthForm />
      </div>
      <p className="login-foot">登录状态保存在本机，可随时退出。</p>
    </div>
  );
}
