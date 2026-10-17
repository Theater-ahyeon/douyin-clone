'use strict';
/**
 * The window's first paint. A blank BrowserWindow looks like a crash while the
 * embedded backend boots (~0.5s for sqlite + node:sqlite open), so the shell
 * loads this self-contained data: URL until the app origin is reachable.
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {{title?: string, detail?: string, hint?: string, tone?: 'wait'|'error'}} options
 * @returns {string} a `data:` URL safe for `loadURL`, also returned as raw HTML.
 */
function loadingPage({ title = 'Douyin Clone', detail = '', hint = '', tone = 'wait' } = {}) {
  const spinner = tone === 'error'
    ? '<div class="mark err">!</div>'
    : '<div class="mark spin"></div>';
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; flex-direction: column;
    gap: 18px; background: #0b0b0f; color: #eaeaf0;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default;
  }
  .mark { width: 34px; height: 34px; border-radius: 50%; }
  .spin { border: 2px solid rgba(255,255,255,.18); border-top-color: #fe2c55; animation: r .9s linear infinite; }
  .err { display: flex; align-items: center; justify-content: center; border: 2px solid #fe2c55; color: #fe2c55; font-weight: 700; }
  @keyframes r { to { transform: rotate(360deg); } }
  h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .02em; }
  p { margin: 0; max-width: 40ch; text-align: center; color: #9a9aa6; }
  code { color: #cfcfda; font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
</style>
</head>
<body>
  ${spinner}
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${hint ? `<p><code>${escapeHtml(hint)}</code></p>` : ''}
</body>
</html>`;
  return {
    html,
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  };
}

module.exports = { loadingPage };
