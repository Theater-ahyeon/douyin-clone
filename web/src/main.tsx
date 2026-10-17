import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import App from './App';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/feed.css';
import './styles/pages.css';
import './styles/responsive.css';

const host = document.getElementById('root');
if (!host) throw new Error('missing #root');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
);
