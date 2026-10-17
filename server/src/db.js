import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DATA_DIR, DB_FILE } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  bio           TEXT    NOT NULL DEFAULT '',
  avatar_color  TEXT    NOT NULL DEFAULT '#fe2c55',
  verified      INTEGER NOT NULL DEFAULT 0,
  -- internal flag so scripts/seed.mjs --force can identify demo rows; never exposed by the API
  seeded        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_objects (
  id           INTEGER PRIMARY KEY,
  media_key    TEXT    NOT NULL UNIQUE,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  content_type TEXT    NOT NULL DEFAULT 'video/mp4',
  origin       TEXT    NOT NULL DEFAULT 'upload',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id        INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption   TEXT    NOT NULL DEFAULT '',
  url       TEXT    NOT NULL DEFAULT '',
  poster    TEXT    NOT NULL DEFAULT '',
  media_key TEXT    NOT NULL DEFAULT '',
  duration  REAL    NOT NULL DEFAULT 0,
  width     INTEGER NOT NULL DEFAULT 1080,
  height    INTEGER NOT NULL DEFAULT 1920,
  -- like/comment/favourite totals are counted from their own indexed tables so a
  -- cached counter can never drift; only these two have no backing table.
  shares    INTEGER NOT NULL DEFAULT 0,
  views     INTEGER NOT NULL DEFAULT 0,
  -- sort_key is the recommendation rank, frozen at insert time. Rewriting it on
  -- every like would make an in-flight keyset cursor skip or repeat rows.
  sort_key  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_rank   ON videos(sort_key DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_videos_author ON videos(author_id, sort_key DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_videos_media  ON videos(media_key);

CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_pair ON likes(video_id, user_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id, id DESC);

CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_pair ON favorites(video_id, user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, id DESC);

CREATE TABLE IF NOT EXISTS follows (
  id          INTEGER PRIMARY KEY,
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  CHECK (follower_id <> user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_pair ON follows(follower_id, user_id);
CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(user_id, id DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_video  ON comments(video_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id              INTEGER PRIMARY KEY,
  thread_key      TEXT    NOT NULL UNIQUE,
  user_a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_id INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_a ON threads(user_a, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_b ON threads(user_b, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS thread_reads (
  thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
`;

let database = null;
const statements = new Map();

// Performance A/B switch. When DY_PERF_BASELINE=1 the server skips the read-path
// mitigations (mmap, the comment_likes covering index, the user-exists cache, the
// allocation-free JSON writer) so scripts/benchmark.mjs can compare "before" and
// "after" in a single build. Production never sets it; behavior defaults to fast.
export const PERF_BASELINE = process.env.DY_PERF_BASELINE === '1';

// node:sqlite rejects JS booleans and `undefined` as bind values.
function normalizeParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

// Additive-only migrations: `CREATE TABLE IF NOT EXISTS` never touches an existing
// table, so columns introduced later have to be added explicitly.
function addMissingColumns(db, table, additions) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const [name, ddl] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

export function openDatabase() {
  if (database) return database;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -20000');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  if (!PERF_BASELINE) {
    // Memory-map the DB file: hot read-only pages (videos/likes/comments scanned on
    // every feed request) are served straight from the page cache with no read()
    // syscall, shortening how long each synchronous query pins the event loop.
    db.exec('PRAGMA mmap_size = 67108864');
  }
  db.exec(SCHEMA);
  if (!PERF_BASELINE) {
    // The comment_likes PK is (user_id, comment_id), so the per-comment like COUNT
    // in COMMENT_SELECT (WHERE comment_id = ?) had no index with comment_id leading
    // and degraded to a full SCAN of comment_likes for every comment row. This
    // covering index lets SQLite answer the count from an index range scan instead.
    db.exec('CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id, user_id)');
  }
  addMissingColumns(db, 'users', [['seeded', 'INTEGER NOT NULL DEFAULT 0']]);
  database = db;
  return db;
}

export function getDb() {
  return database || openDatabase();
}

export function closeDatabase() {
  if (!database) return;
  statements.clear();
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* checkpoint is best effort on shutdown */
  }
  database.close();
  database = null;
}

export function prep(sql) {
  const db = getDb();
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

export function run(sql, params = []) {
  return prep(sql).run(...params.map(normalizeParam));
}

export function get(sql, params = []) {
  const row = prep(sql).get(...params.map(normalizeParam));
  return row === undefined ? null : { ...row };
}

export function all(sql, params = []) {
  return prep(sql).all(...params.map(normalizeParam)).map((row) => ({ ...row }));
}

export function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-aborted transaction is not an error worth masking */
    }
    throw error;
  }
}

export function dbFile() {
  return path.resolve(DB_FILE);
}
