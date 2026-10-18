#!/usr/bin/env node
// End-to-end contract probe. Run it against a scratch database, not the one you
// care about: it registers throwaway accounts and publishes a real upload.
//
//   DY_DATA_DIR=$(mktemp -d) node scripts/seed.mjs
//   DY_DATA_DIR=<same> DY_LOG=0 node server/src/index.js &
//   npm run smoke
//
// Override the target with DY_SMOKE_BASE (default http://127.0.0.1:8787).

const BASE = process.env.DY_SMOKE_BASE || `http://${process.env.DY_HOST || '127.0.0.1'}:${process.env.DY_PORT || 8787}`;

async function call(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* error pages are not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const author = await call('POST', '/api/auth/register', { username: `smoke_a_${uniq}`, password: 'password123' });
const other = await call('POST', '/api/auth/register', { username: `smoke_b_${uniq}`, password: 'password123' });
const authorToken = author.body?.token;
const otherToken = other.body?.token;
check('two accounts register', author.status === 200 && other.status === 200 && !!authorToken && !!otherToken);

const duplicate = await call('POST', '/api/auth/register', { username: `smoke_a_${uniq}`, password: 'password123' });
check('duplicate username is 409, not 500', duplicate.status === 409, `${duplicate.status} ${duplicate.body?.error?.code}`);

const wrongPassword = await call('POST', '/api/auth/login', { username: `smoke_a_${uniq}`, password: 'wrong-password' });
check('wrong password is 401', wrongPassword.status === 401, String(wrongPassword.status));

const badToken = await call('GET', '/api/users/me', undefined, 'not-a-real-token');
check('forged token is 401', badToken.status === 401, String(badToken.status));

const anonymous = await call('GET', '/api/users/me');
check('missing token is 401', anonymous.status === 401, String(anonymous.status));

// A real upload, so the media path (registration, ownership, Range) is exercised.
const upload = await fetch(`${BASE}/api/upload`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'video/mp4',
    Authorization: `Bearer ${authorToken}`,
    'X-Meta': encodeURIComponent(JSON.stringify({ caption: 'smoke' })),
  },
  body: new Uint8Array(2048).fill(7),
});
const uploaded = await upload.json().catch(() => null);
const mediaKey = uploaded?.media_key;
check('upload returns a media_key', upload.status === 200 && !!mediaKey, `${upload.status} ${JSON.stringify(uploaded)}`);

const stolen = await call('POST', '/api/videos', { caption: 'stolen', media_key: mediaKey }, otherToken);
check("another account cannot publish someone's media_key", stolen.status === 403 && stolen.body?.error?.code === 'media_not_owned', `${stolen.status} ${stolen.body?.error?.code}`);

const published = await call('POST', '/api/videos', { caption: 'smoke clip', media_key: mediaKey, duration: 3, width: 540, height: 960 }, authorToken);
const videoId = published.body?.video?.id;
check('the uploader can publish it', published.status === 200 && !!videoId, `${published.status} ${published.body?.error?.message ?? ''}`);

const ghost = await call('POST', '/api/videos', { caption: 'ghost', media_key: 'ffffffff-ffff-ffff-ffff-ffffffffffff.mp4' }, authorToken);
check('unknown media_key is rejected', ghost.status === 400 || ghost.status === 403, `${ghost.status} ${ghost.body?.error?.code}`);

const emptyUpload = await fetch(`${BASE}/api/upload`, {
  method: 'PUT',
  headers: { 'Content-Type': 'video/mp4', Authorization: `Bearer ${authorToken}` },
  body: new Uint8Array(0),
});
check('empty upload body is 400', emptyUpload.status === 400, `${emptyUpload.status} ${(await emptyUpload.json().catch(() => ({})))?.error?.code}`);

const liked = await call('POST', `/api/videos/${videoId}/like`, undefined, otherToken);
check('like is counted', liked.status === 200 && liked.body?.likes === 1, JSON.stringify(liked.body));
const unliked = await call('DELETE', `/api/videos/${videoId}/like`, undefined, otherToken);
check('unlike rolls the counter back', unliked.status === 200 && unliked.body?.likes === 0, JSON.stringify(unliked.body));

const anonymousShare = await call('POST', `/api/videos/${videoId}/share`);
check('anonymous share is 401', anonymousShare.status === 401, String(anonymousShare.status));
await call('POST', `/api/videos/${videoId}/share`, undefined, otherToken);
const shared = await call('POST', `/api/videos/${videoId}/share`, undefined, otherToken);
check('share count persists', shared.status === 200 && shared.body?.shares === 2, JSON.stringify(shared.body));
const reread = await call('GET', `/api/videos/${videoId}`, undefined, otherToken);
check('share count survives a reload', reread.body?.video?.stats?.shares === 2, `shares=${reread.body?.video?.stats?.shares}`);
const missingShare = await call('POST', '/api/videos/999999/share', undefined, otherToken);
check('share of an unknown video is 404', missingShare.status === 404, String(missingShare.status));

const comment = await call('POST', `/api/videos/${videoId}/comments`, { content: 'smoke comment' }, otherToken);
check('comment is stored', comment.status === 200, String(comment.status));

const followed = await call('POST', `/api/users/${author.body.user.id}/follow`, undefined, otherToken);
check('follow works', followed.status === 200 && followed.body?.following === true, JSON.stringify(followed.body));

const feed = await call('GET', '/api/feed?limit=3');
check('feed serves a page', feed.status === 200 && Array.isArray(feed.body?.items), `items=${feed.body?.items?.length}`);

const page1 = await call('GET', '/api/feed?limit=2');
const page2 = await call('GET', `/api/feed?limit=2&cursor=${encodeURIComponent(page1.body?.next_cursor ?? '')}`);
const overlap = (page1.body?.items ?? []).filter((v) => (page2.body?.items ?? []).some((w) => w.id === v.id));
check('keyset paging does not repeat rows', overlap.length === 0, `overlap=${overlap.length}`);

const oversize = await fetch(`${BASE}/api/videos`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorToken}` },
  body: JSON.stringify({ caption: 'x'.repeat(4 * 1024 * 1024), media_key: mediaKey }),
});
check('oversized body is 413', oversize.status === 413, String(oversize.status));

const traversal = await fetch(`${BASE}/media/..%2f..%2fapp.sqlite`);
check('path traversal is refused', traversal.status >= 400, String(traversal.status));

const full = await fetch(`${BASE}/media/${encodeURIComponent(mediaKey)}`);
const ranged = await fetch(`${BASE}/media/${encodeURIComponent(mediaKey)}`, { headers: { Range: 'bytes=-200' } });
check('suffix range returns 206 with Content-Range', ranged.status === 206 && /^bytes 1848-2047\/2048$/.test(ranged.headers.get('content-range') ?? ''), `${ranged.status} ${ranged.headers.get('content-range')}`);
const invalid = await fetch(`${BASE}/media/${encodeURIComponent(mediaKey)}`, { headers: { Range: 'bytes=5-3' } });
check('invalid byte-range is ignored per RFC 9110', invalid.status === 200 && full.status === 200, `${invalid.status}`);
const unsatisfiable = await fetch(`${BASE}/media/${encodeURIComponent(mediaKey)}`, { headers: { Range: 'bytes=99999-' } });
check('unsatisfiable range is 416', unsatisfiable.status === 416, String(unsatisfiable.status));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name}`);
  process.exit(1);
}
