import { all, get, run, transaction, PERF_BASELINE } from './db.js';
import { commentFromRow, messageFromRow, userFromRow, videoFromRow } from './models.js';
import { httpError } from './util.js';

const USER_COLUMNS = `
  u.id, u.username, u.display_name, u.bio, u.avatar_color, u.verified, u.created_at,
  (SELECT COUNT(*) FROM follows fw WHERE fw.follower_id = u.id) AS following_count,
  (SELECT COUNT(*) FROM follows fw WHERE fw.user_id = u.id) AS follower_count
`;

const VIDEO_COUNTS = `
  (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS likes,
  (SELECT COUNT(*) FROM favorites fav WHERE fav.video_id = v.id) AS favorites,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count,
  v.shares, v.views
`;

// Anonymous callers bind viewer = 0. No user row can ever have id 0 (INTEGER PRIMARY KEY
// starts at 1), so the EXISTS probes stay cheap and always false.
const VIDEO_SELECT = `
SELECT
  v.id, v.sort_key, v.caption, v.url, v.poster, v.media_key, v.duration, v.width, v.height,
  v.created_at, ${VIDEO_COUNTS},
  u.id AS author_id, u.username AS author_username, u.display_name AS author_display_name,
  u.avatar_color AS author_avatar_color, u.verified AS author_verified,
  EXISTS(SELECT 1 FROM likes l WHERE l.video_id = v.id AND l.user_id = ?) AS viewer_liked,
  EXISTS(SELECT 1 FROM favorites fav WHERE fav.video_id = v.id AND fav.user_id = ?) AS viewer_favorited,
  EXISTS(SELECT 1 FROM follows f WHERE f.user_id = v.author_id AND f.follower_id = ?) AS viewer_following
FROM videos v
JOIN users u ON u.id = v.author_id
`;

const COMMENT_SELECT = `
SELECT c.id, c.content, c.created_at, c.parent_id,
       (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS likes,
       c.author_id, u.username AS author_username, u.display_name AS author_display_name,
       u.avatar_color AS author_avatar_color,
       EXISTS(SELECT 1 FROM comment_likes cl2 WHERE cl2.comment_id = c.id AND cl2.user_id = ?) AS viewer_liked
FROM comments c
JOIN users u ON u.id = c.author_id
`;

const ESCAPE = "ESCAPE '\\'";

function keysetDesc(sortColumn, idColumn) {
  return `(${sortColumn} < ? OR (${sortColumn} = ? AND ${idColumn} < ?))`;
}

/* ------------------------------------------------------------------ users -- */

export function createUser({ username, passwordHash, passwordSalt, displayName, bio, avatarColor, verified, createdAt }) {
  const result = run(
    `INSERT INTO users (username, password_hash, password_salt, display_name, bio, avatar_color, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, passwordHash, passwordSalt, displayName, bio || '', avatarColor, verified ? 1 : 0, createdAt, createdAt]
  );
  return Number(result.lastInsertRowid);
}

export function userByUsername(username) {
  return get(`SELECT * FROM users WHERE username = ? LIMIT 1`, [String(username).toLowerCase()]);
}

export function userById(id) {
  return get(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
}

export function userExists(id) {
  return Boolean(get(`SELECT 1 AS ok FROM users WHERE id = ? LIMIT 1`, [id]));
}

// Every authenticated request used to pay a synchronous `users` PK lookup just to
// confirm the token's subject still exists. Because node:sqlite pins that probe to
// the main thread, it lands directly in the path that also pumps media bytes. A
// short-TTL in-process cache collapses the repeated probe into one query per window;
// the TTL is tiny so a deleted user is caught within a few seconds, and it is bounded
// so it can never grow without limit.
const USER_EXISTS_TTL_MS = 3000;
const USER_EXISTS_MAX = 4096;
const userExistsCache = new Map(); // id -> expiry timestamp (ms)

export function userExistsCached(id) {
  if (PERF_BASELINE) return userExists(id);
  if (!Number.isInteger(id)) return false;
  const nowMs = Date.now();
  const hit = userExistsCache.get(id);
  if (hit !== undefined) {
    if (hit >= nowMs) return true;
    userExistsCache.delete(id);
  }
  const ok = userExists(id);
  if (ok) {
    if (userExistsCache.size >= USER_EXISTS_MAX) userExistsCache.clear();
    userExistsCache.set(id, nowMs + USER_EXISTS_TTL_MS);
  }
  return ok;
}

export function userRecord(id) {
  const row = get(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id]);
  if (!row) throw httpError(404, 'not_found', 'user not found');
  return row;
}

export function updateUserProfile(id, { displayName, bio, avatarColor }) {
  const assignments = [];
  const params = [];
  if (displayName !== undefined) {
    assignments.push('display_name = ?');
    params.push(displayName);
  }
  if (bio !== undefined) {
    assignments.push('bio = ?');
    params.push(bio);
  }
  if (avatarColor !== undefined) {
    assignments.push('avatar_color = ?');
    params.push(avatarColor);
  }
  if (!assignments.length) return userById(id);
  assignments.push('updated_at = ?');
  params.push(Date.now(), id);
  // Only the column names above are interpolated, and they are literals, never input.
  run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  return userById(id);
}

export function userStats(id) {
  userRecord(id);
  const followers = get(`SELECT COUNT(*) AS n FROM follows WHERE user_id = ?`, [id]);
  const following = get(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?`, [id]);
  const likes = get(
    `SELECT COUNT(*) AS n FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.author_id = ?`,
    [id]
  );
  const videos = get(`SELECT COUNT(*) AS n FROM videos WHERE author_id = ?`, [id]);
  return {
    followers: followers.n,
    following: following.n,
    likes_received: likes.n,
    videos: videos.n,
  };
}

function relationRows(id, cursor, limit, direction) {
  const isFollowerSide = direction === 'followers';
  const where = [isFollowerSide ? 'fu.user_id = ?' : 'fu.follower_id = ?'];
  const params = [id];
  if (cursor) {
    where.push(keysetDesc('fu.created_at', 'fu.id'));
    params.push(cursor.k, cursor.k, cursor.i);
  }
  const join = isFollowerSide ? 'u.id = fu.follower_id' : 'u.id = fu.user_id';
  const rows = all(
    `SELECT ${USER_COLUMNS}, fu.created_at AS rel_created_at, fu.id AS rel_id
     FROM follows fu JOIN users u ON ${join}
     WHERE ${where.join(' AND ')}
     ORDER BY fu.created_at DESC, fu.id DESC
     LIMIT ?`,
    [...params, limit + 1]
  );
  return pageOf(rows, limit, (row) => userFromRow(row), (row) => ({ k: row.rel_created_at, i: row.rel_id }));
}

export function listFollowers(id, cursor, limit) {
  userRecord(id);
  return relationRows(id, cursor, limit, 'followers');
}

export function listFollowing(id, cursor, limit) {
  userRecord(id);
  return relationRows(id, cursor, limit, 'following');
}

export function setFollow(followerId, targetId, on) {
  if (followerId === targetId) throw httpError(400, 'invalid_request', 'you cannot follow yourself');
  userRecord(targetId);
  if (on) {
    run(
      `INSERT INTO follows (follower_id, user_id, created_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND user_id = ?)`,
      [followerId, targetId, Date.now(), followerId, targetId]
    );
  } else {
    run(`DELETE FROM follows WHERE follower_id = ? AND user_id = ?`, [followerId, targetId]);
  }
  const count = get(`SELECT COUNT(*) AS n FROM follows WHERE user_id = ?`, [targetId]);
  return { following: on, followers: count.n };
}

export function isFollowing(followerId, targetId) {
  return Boolean(get(`SELECT 1 AS ok FROM follows WHERE follower_id = ? AND user_id = ? LIMIT 1`, [followerId, targetId]));
}

/* ----------------------------------------------------------------- videos -- */

export function registerMediaObject({ mediaKey, ownerId, bytes, contentType, origin }) {
  run(
    `INSERT INTO media_objects (media_key, owner_id, bytes, content_type, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(media_key) DO UPDATE SET bytes = excluded.bytes, content_type = excluded.content_type`,
    [mediaKey, ownerId || null, bytes || 0, contentType || 'video/mp4', origin || 'upload', Date.now()]
  );
}

export function insertVideo({ authorId, caption, url, poster, mediaKey, duration, width, height, createdAt, sortKey, views, shares }) {
  const created = createdAt || Date.now();
  const result = run(
    `INSERT INTO videos (author_id, caption, url, poster, media_key, duration, width, height, views, shares, sort_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [authorId, caption || '', url || '', poster || '', mediaKey || '', duration || 0,
      width || 1080, height || 1920, views || 0, shares || 0, sortKey || created, created]
  );
  return Number(result.lastInsertRowid);
}

export function videoExists(id) {
  return Boolean(get(`SELECT 1 AS ok FROM videos WHERE id = ? LIMIT 1`, [id]));
}

function videoOrThrow(id, viewer = 0) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) throw httpError(404, 'not_found', 'video not found');
  const row = get(`${VIDEO_SELECT} WHERE v.id = ? LIMIT 1`, [viewer, viewer, viewer, numeric]);
  if (!row) throw httpError(404, 'not_found', 'video not found');
  return row;
}

export function getVideo(id, viewer) {
  return videoOrThrow(id, viewer);
}

export function feedVideos(viewer, cursor, limit, { followedOnly = false } = {}) {
  if (followedOnly && !viewer) return { items: [], next_cursor: null };
  const where = [];
  const params = [viewer, viewer, viewer];
  if (followedOnly) {
    where.push('v.author_id IN (SELECT user_id FROM follows WHERE follower_id = ?)');
    params.push(viewer);
  }
  if (cursor) {
    where.push(keysetDesc('v.sort_key', 'v.id'));
    params.push(cursor.k, cursor.k, cursor.i);
  }
  const rows = all(
    `${VIDEO_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY v.sort_key DESC, v.id DESC LIMIT ?`,
    [...params, limit + 1]
  );
  return pageOf(rows, limit, videoFromRow, (row) => ({ k: row.sort_key, i: row.id }));
}

export function authorVideos(authorId, viewer, cursor, limit) {
  userRecord(authorId);
  const where = ['v.author_id = ?'];
  const params = [viewer, viewer, viewer, authorId];
  if (cursor) {
    where.push(keysetDesc('v.sort_key', 'v.id'));
    params.push(cursor.k, cursor.k, cursor.i);
  }
  const rows = all(
    `${VIDEO_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.sort_key DESC, v.id DESC LIMIT ?`,
    [...params, limit + 1]
  );
  return pageOf(rows, limit, videoFromRow, (row) => ({ k: row.sort_key, i: row.id }));
}

export function incrementViews(id) {
  const numeric = Number(id);
  const changes = run(`UPDATE videos SET views = views + 1 WHERE id = ?`, [numeric]).changes;
  if (!changes) throw httpError(404, 'not_found', 'video not found');
  return get(`SELECT views AS n FROM videos WHERE id = ?`, [numeric]).n;
}

export function incrementShares(id) {
  const numeric = Number(id);
  const changes = run(`UPDATE videos SET shares = shares + 1 WHERE id = ?`, [numeric]).changes;
  if (!changes) throw httpError(404, 'not_found', 'video not found');
  return get(`SELECT shares AS n FROM videos WHERE id = ?`, [numeric]).n;
}

export function mediaOwner(mediaKey) {
  const row = get(`SELECT owner_id AS owner FROM media_objects WHERE media_key = ? LIMIT 1`, [mediaKey]);
  return row ? row.owner : undefined;
}

export function countersFor(videoId) {
  const row = get(
    `SELECT
       (SELECT COUNT(*) FROM likes WHERE video_id = ?) AS likes,
       (SELECT COUNT(*) FROM favorites WHERE video_id = ?) AS favorites,
       (SELECT COUNT(*) FROM comments WHERE video_id = ?) AS comments`,
    [videoId, videoId, videoId]
  );
  return row;
}

export function setVideoLike(viewer, videoId, on) {
  const video = videoOrThrow(videoId, viewer);
  transaction(() => {
    if (on) {
      run(
        `INSERT INTO likes (video_id, user_id, created_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM likes WHERE video_id = ? AND user_id = ?)`,
        [video.id, viewer, Date.now(), video.id, viewer]
      );
    } else {
      run(`DELETE FROM likes WHERE video_id = ? AND user_id = ?`, [video.id, viewer]);
    }
  });
  return { counters: countersFor(video.id), video };
}

export function setVideoFavorite(viewer, videoId, on) {
  const video = videoOrThrow(videoId, viewer);
  transaction(() => {
    if (on) {
      run(
        `INSERT INTO favorites (video_id, user_id, created_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM favorites WHERE video_id = ? AND user_id = ?)`,
        [video.id, viewer, Date.now(), video.id, viewer]
      );
    } else {
      run(`DELETE FROM favorites WHERE video_id = ? AND user_id = ?`, [video.id, viewer]);
    }
  });
  return { counters: countersFor(video.id), video };
}

/* ---------------------------------------------------------------- comments -- */

export function insertComment({ videoId, authorId, parentId, content, createdAt }) {
  const video = videoOrThrow(videoId);
  if (parentId) {
    const parent = get(`SELECT video_id FROM comments WHERE id = ? LIMIT 1`, [parentId]);
    if (!parent) throw httpError(400, 'invalid_request', 'parent comment does not exist');
    if (parent.video_id !== video.id) throw httpError(400, 'invalid_request', 'parent comment belongs to another video');
  }
  const result = run(
    `INSERT INTO comments (video_id, author_id, parent_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    [video.id, authorId, parentId || null, content, createdAt || Date.now()]
  );
  return commentById(Number(result.lastInsertRowid), authorId);
}

export function commentById(id, viewer) {
  const numeric = Number(id);
  const row = get(`${COMMENT_SELECT} WHERE c.id = ? LIMIT 1`, [viewer, numeric]);
  return row ? commentFromRow(row) : null;
}

export function listComments(videoId, viewer, cursor, limit) {
  const video = videoOrThrow(videoId, viewer);
  const where = ['c.video_id = ?'];
  const params = [viewer, video.id];
  if (cursor) {
    where.push(keysetDesc('c.created_at', 'c.id'));
    params.push(cursor.k, cursor.k, cursor.i);
  }
  const rows = all(
    `${COMMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
    [...params, limit + 1]
  );
  const page = pageOf(rows, limit, commentFromRow, (row) => ({ k: row.created_at, i: row.id }));
  const total = get(`SELECT COUNT(*) AS n FROM comments WHERE video_id = ?`, [video.id]);
  return { ...page, total: total.n };
}

export function deleteComment(id, viewer) {
  const numeric = Number(id);
  const row = get(`SELECT id, author_id, video_id FROM comments WHERE id = ? LIMIT 1`, [numeric]);
  if (!row) throw httpError(404, 'not_found', 'comment not found');
  if (row.author_id !== viewer) throw httpError(403, 'forbidden', 'only the author can delete a comment');
  run(`DELETE FROM comments WHERE id = ?`, [row.id]);
  return { video_id: row.video_id };
}

/* ---------------------------------------------------------------- messages -- */

export function threadKeyFor(a, b) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

export function ensureThread(viewer, peerId) {
  userRecord(peerId);
  const key = threadKeyFor(viewer, peerId);
  const existing = get(`SELECT id FROM threads WHERE thread_key = ? LIMIT 1`, [key]);
  if (existing) return Number(existing.id);
  const result = run(
    `INSERT INTO threads (thread_key, user_a, user_b, updated_at) VALUES (?, ?, ?, ?)`,
    [key, Math.min(viewer, peerId), Math.max(viewer, peerId), Date.now()]
  );
  return Number(result.lastInsertRowid);
}

export function insertMessage({ threadId, senderId, recipientId, content, createdAt }) {
  const created = createdAt || Date.now();
  return transaction(() => {
    const result = run(
      `INSERT INTO messages (thread_id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      [threadId, senderId, recipientId, content, created]
    );
    const id = Number(result.lastInsertRowid);
    run(`UPDATE threads SET last_message_id = ?, updated_at = ? WHERE id = ?`, [id, created, threadId]);
    markRead(threadId, senderId, id, created);
    return id;
  });
}

function markRead(threadId, userId, lastReadId, at) {
  run(
    `INSERT INTO thread_reads (thread_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id, user_id) DO UPDATE
       SET last_read_id = MAX(thread_reads.last_read_id, excluded.last_read_id), updated_at = excluded.updated_at`,
    [threadId, userId, lastReadId, at]
  );
}

export function markThreadRead(threadId, viewer) {
  const last = get(`SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE thread_id = ?`, [threadId]);
  markRead(threadId, viewer, last.n, Date.now());
}

export function listMessages(threadId, viewer, cursor, limit) {
  const where = ['m.thread_id = ?'];
  const params = [threadId];
  if (cursor) {
    where.push(keysetDesc('m.created_at', 'm.id'));
    params.push(cursor.k, cursor.k, cursor.i);
  }
  const rows = all(
    `SELECT m.id, m.content, m.created_at, m.sender_id FROM messages m
     WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    [...params, limit + 1]
  );
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  const oldest = kept[kept.length - 1];
  return {
    // A transcript reads oldest-first, so the fetched page is reversed while the
    // cursor keeps walking backwards through older messages.
    items: kept.map((row) => messageFromRow(row, viewer)).reverse(),
    next_cursor: hasMore && oldest ? { k: oldest.created_at, i: oldest.id } : null,
  };
}

export function conversations(viewer, limit = 200) {
  const rows = all(
    `WITH mine AS (
       SELECT t.id AS thread_id, t.id AS t_id,
              CASE WHEN t.user_a = ? THEN t.user_b ELSE t.user_a END AS peer_id,
              t.updated_at AS thread_updated_at,
              t.last_message_id AS last_message_id,
              (SELECT COUNT(*) FROM messages m
                WHERE m.thread_id = t.id AND m.sender_id <> ?
                  AND m.id > COALESCE((SELECT r.last_read_id FROM thread_reads r
                                       WHERE r.thread_id = t.id AND r.user_id = ?), 0)) AS unread
       FROM threads t
       WHERE t.user_a = ? OR t.user_b = ?
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT ?)
     SELECT ${USER_COLUMNS}, m.thread_id, m.unread, m.last_message_id, m.thread_updated_at,
            lm.content AS last_content, lm.created_at AS last_created_at
     FROM mine m
     JOIN users u ON u.id = m.peer_id
     LEFT JOIN messages lm ON lm.id = m.last_message_id
     ORDER BY m.thread_updated_at DESC, m.t_id DESC`,
    [viewer, viewer, viewer, viewer, viewer, limit]
  );
  return rows.map((row) => ({
    peer: userFromRow(row),
    last: row.last_message_id ? { content: row.last_content, created_at: row.last_created_at } : null,
    unread: row.unread,
  }));
}

/* ------------------------------------------------------------------ search -- */

function likeTerm(raw) {
  const escaped = String(raw).replace(/[\\%_]/g, (ch) => `\\${ch}`).toLowerCase();
  return `%${escaped}%`;
}

export function search(term, viewer, cursor, { videoLimit, userLimit }) {
  const needle = likeTerm(term);

  let videoRows = [];
  let moreVideos = false;
  if (!(cursor && cursor.vdone)) {
    const where = [`LOWER(v.caption) LIKE ? ${ESCAPE}`];
    const params = [viewer, viewer, viewer, needle];
    if (cursor && Number.isInteger(cursor.vk)) {
      where.push(keysetDesc('v.sort_key', 'v.id'));
      params.push(cursor.vk, cursor.vk, cursor.vi || 0);
    }
    videoRows = all(
      `${VIDEO_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.sort_key DESC, v.id DESC LIMIT ?`,
      [...params, videoLimit + 1]
    );
    moreVideos = videoRows.length > videoLimit;
    videoRows = videoRows.slice(0, videoLimit);
  }

  let userRows = [];
  let moreUsers = false;
  if (!(cursor && cursor.udone)) {
    const where = [`(LOWER(u.username) LIKE ? ${ESCAPE} OR LOWER(u.display_name) LIKE ? ${ESCAPE})`];
    const params = [needle, needle];
    if (cursor && Number.isInteger(cursor.ui)) {
      where.push('u.id > ?');
      params.push(cursor.ui);
    }
    userRows = all(
      `SELECT ${USER_COLUMNS} FROM users u WHERE ${where.join(' AND ')} ORDER BY u.id ASC LIMIT ?`,
      [...params, userLimit + 1]
    );
    moreUsers = userRows.length > userLimit;
    userRows = userRows.slice(0, userLimit);
  }

  const lastVideo = videoRows[videoRows.length - 1];
  const lastUser = userRows[userRows.length - 1];
  const next = {};
  let hasNext = false;
  // A finished side stays finished: dropping the flag would restart it from the
  // top on the next page while the other side was still paging, repeating rows.
  if (moreVideos && lastVideo) {
    next.vk = lastVideo.sort_key;
    next.vi = lastVideo.id;
    hasNext = true;
  } else {
    next.vdone = 1;
  }
  if (moreUsers && lastUser) {
    next.ui = lastUser.id;
    hasNext = true;
  } else {
    next.udone = 1;
  }

  return {
    videos: videoRows.map(videoFromRow),
    users: userRows.map(userFromRow),
    next_cursor: hasNext ? next : null,
  };
}

/* ------------------------------------------------------------------ pages -- */

export function pageOf(rows, limit, mapItem, mapCursor) {
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    items: kept.map(mapItem),
    next_cursor: hasMore && last ? mapCursor(last) : null,
  };
}

export { VIDEO_SELECT, COMMENT_SELECT, USER_COLUMNS };
