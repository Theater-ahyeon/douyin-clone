#!/usr/bin/env node
/**
 * Seeds the Douyin-clone demo dataset: 8 users, 40 videos, comments, likes,
 * follows and DM threads.
 *
 *   node scripts/seed.mjs                 download CC0 clips, then seed
 *   node scripts/seed.mjs --force         wipe previous seed rows first
 *   node scripts/seed.mjs --from <dir>    ingest your own local .mp4/.webm files
 *   node scripts/seed.mjs --skip-media    never touch the network (offline demo)
 *
 * Every network source below was HEAD-probed (HTTP 200, video/*, < 30 MB) before
 * being hardcoded; if they all fail the seed still completes with poster-only
 * videos so the UI stays demoable.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DB_FILE, MEDIA_DIR } from '../server/src/config.js';
import { closeDatabase, get, openDatabase, run, transaction } from '../server/src/db.js';
import { hashPassword } from '../server/src/auth.js';
import { pickColor, syntheticPoster } from '../server/src/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// Verified reachable on 2026-10-17 via `curl -sIL` (all HTTP 200, video/mp4 or video/webm).
const CC0_SOURCES = [
  { file: 'seed-flower.mp4', url: 'https://mdn.github.io/shared-assets/videos/flower.mp4', size: 1128375, duration: 10, posterHint: 0 },
  { file: 'seed-friday.mp4', url: 'https://mdn.github.io/shared-assets/videos/friday.mp4', size: 515198, duration: 8, posterHint: 1 },
  { file: 'seed-flower.webm', url: 'https://mdn.github.io/shared-assets/videos/flower.webm', size: 554058, duration: 10, posterHint: 2 },
  { file: 'seed-tears.webm', url: 'https://mdn.github.io/shared-assets/videos/tears-of-steel-battle-clip-medium.webm', size: 3451423, duration: 26, posterHint: 3 },
  { file: 'seed-sintel.webm', url: 'https://mdn.github.io/shared-assets/videos/sintel-short.webm', size: 5282875, duration: 52, posterHint: 4 },
];

const MAX_BYTES = 30 * 1024 * 1024;
const SEED_PASSWORD = 'password123';

/* ------------------------------------------------------------------ args --- */

function parseArgs(argv) {
  const out = { force: false, from: null, skipMedia: false, refreshMedia: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') out.force = true;
    else if (arg === '--skip-media' || arg === '--offline') out.skipMedia = true;
    else if (arg === '--refresh-media') out.refreshMedia = true;
    else if (arg === '--from') {
      const value = argv[i + 1];
      if (!value) throw new Error('--from needs a directory of .mp4/.webm files');
      out.from = path.resolve(value);
      i += 1;
    } else if (arg.startsWith('--from=')) out.from = path.resolve(arg.slice('--from='.length));
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log(`usage: node scripts/seed.mjs [--force] [--from <dir>] [--skip-media]

  writes ${path.relative(REPO, DB_FILE)} and ${path.relative(REPO, MEDIA_DIR)}/
  demo logins: <username> / ${SEED_PASSWORD}
`);
}

/* ------------------------------------------------------------------- data -- */

const USERS = [
  { username: 'alice_walker', display_name: '爱丽丝Alice', bio: '城市漫行者 · 每天一条', verified: true },
  { username: 'kenji_plays', display_name: '健二KJ', bio: '吉他和效果器', verified: false },
  { username: 'luna_cuts', display_name: '露娜剪辑', bio: '剪辑教程周更', verified: false },
  { username: 'urbanslices', display_name: '城市切片', bio: '建筑与光线', verified: true },
  { username: 'mocha_milo', display_name: '摩卡Milo', bio: '咖啡与猫', verified: false },
  { username: 'nightowl_dev', display_name: '夜猫程序员', bio: '写代码到凌晨两点', verified: false },
  { username: 'sisi_sh', display_name: '莎莎在上海', bio: '探店 / 街拍', verified: true },
  { username: 'frame_by_frame', display_name: '逐帧动画', bio: '一秒钟 12 张画', verified: false },
];

const CAPTIONS = [
  '下班后的第一条舞，跳得不好但很开心 #舞蹈 #日常',
  '凌晨两点的城市，只有路灯还醒着 #夜景 #治愈',
  '三分钟学会一个和弦走向 #吉他 #音乐教学',
  '把上周的素材剪成了这支片子 #剪辑 #幕后',
  '这家咖啡馆的拉花真的绝了 #探店 #咖啡',
  '我家猫又把我的键盘当床了 #猫 #萌宠',
  '雨后的梧桐区，随手一拍都是电影感 #街拍 #上海',
  '12 帧一秒的手绘动画，画到手抽筋 #动画 #手绘',
  '这个转场我练了 40 遍才顺 #剪辑教程 #技术流',
  '周末爬山，山顶的风把一切都吹走了 #户外 #徒步',
  '程序员的一天：三次上线，两次回滚 #程序员 #日常',
  '老巷子里的早餐摊，二十年没变过 #烟火气 #美食',
  '试着用一镜到底拍这段楼梯 #摄影 #运镜',
  '夜景人像参数放评论区了 #摄影教程 #参数',
  '这首歌的前奏一响我就得起立 #音乐 #现场',
  '搬家第一天，房间空得能回声 #生活记录',
  '地铁里睡着的人们 #纪实 #城市',
  '把烟花放慢 8 倍是这个样子 #慢动作 #烟花',
  '今天的晚霞像是打翻了调色盘 #天空 #治愈',
  '一个人吃火锅也不尴尬 #美食 #一人食',
  '这支舞是给三年前的自己 #舞蹈 #成长',
  '键盘音采样第 12 期 #音乐制作 #采样',
  '旧书店里翻到 1998 年的杂志 #复古 #淘书',
  '雪山脚下的第一个营地 #旅行 #露营',
  '把这个 bug 修好之前我不睡 #程序员 #debug',
  '猫咪慢镜头合集 #萌宠 #慢动作',
  '城市天际线延时，20 倍速 #延时 #摄影',
  '路边摊的炒粉比店里香 #美食 #夜市',
  '用平板画的第 100 张练习 #绘画 #打卡',
  '这段副歌用了三个和弦外音 #乐理 #创作',
  '雨天的玻璃窗最好拍 #氛围感 #摄影',
  '凌晨四点的批发市场 #纪实 #劳动',
  '第一次尝试手持稳定器运镜 #器材 #教程',
  '这条巷子只有 3 米宽 #城市 #细节',
  '把老照片做成动态照片 #怀旧 #剪辑',
  '深夜食堂，只有一碗面 #夜宵 #一人食',
  '这个动作我练了 100 天 #健身 #坚持',
  '街头即兴，路人跟着节奏点头 #街头 #即兴',
  '春天来了，玉兰先开花后长叶 #植物 #春天',
  '把这首歌改成了指弹版本 #吉他 #改编',
];

const COMMENT_TEXTS = [
  '这个运镜太丝滑了', '求 BGM 名字', '已经三连了，更新快点呀', '同款键盘，哈哈',
  '看完想立刻出门走走', '教程救命了', '这段我循环了十遍', '光影绝了',
  '第一次看到你更新，收藏了', '猫咪值得一个频道', '这个转场怎么做的？', '好治愈，晚安',
  '参数再发一次呗', '笑死，太真实了', '支持原创！', '这就是我想过的周末',
  'so smooth 🔥', 'the light here is unreal', 'how did you do the last transition?',
  '打卡 23:40', '已经在评论区问过一遍了：求歌名', '画质可以再高一点吗',
];

const DM_TEXTS = [
  '在吗，看到你那支夜拍了', '在的，刚剪完一条', '调色用的什么 LUT？', '就原生相机加的对比度',
  '学到了，谢谢！', '明天一起拍巷子里那家咖啡店？', '约，早上八点', '我带稳定器',
  '刚那条发出去 2 小时破 10 万了', '恭喜！实至名归', '你的剪辑节奏真的很好', '互相学习',
  'hi，能授权转载吗', '可以，标注原作者就行', '收到，谢谢你', '晚上见',
  'this is great work', 'thanks! took 3 retries', 'see you at the shoot tomorrow', '👌',
];

// Deterministic PRNG so re-seeding yields the same graph (easier to eyeball demos).
function makeRandom(seedText) {
  let h = 2166136261;
  for (const ch of seedText) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return function random(maxExclusive) {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % maxExclusive;
  };
}

/* ------------------------------------------------------------------ media -- */

function download(url, dest, { redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'user-agent': 'douyin-clone-seed/1.0', accept: '*/*' } }, (response) => {
      const code = response.statusCode;
      if (code >= 300 && code < 400 && response.headers.location && redirects > 0) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        download(next, dest, { redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`HTTP ${code}`));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > MAX_BYTES) {
        response.resume();
        reject(new Error(`too large: ${declared} bytes`));
        return;
      }
      const file = fs.createWriteStream(dest, { flags: 'w' });
      let got = 0;
      const abort = (message) => {
        file.destroy();
        response.destroy();
        fs.rm(dest, { force: true }, () => {});
        reject(new Error(message));
      };
      response.on('data', (chunk) => {
        got += chunk.length;
        if (got > MAX_BYTES) abort(`exceeded ${MAX_BYTES} bytes`);
      });
      // pipe() owns the backpressure; the 'data' listener above only counts bytes.
      response.pipe(file);
      // Without this the promise never settles when the peer dies mid-body:
      // no 'finish' on the file, and `request` has left its headers phase.
      response.on('error', (error) => abort(error.message));
      response.on('aborted', () => abort('response aborted'));
      file.on('error', (error) => abort(error.message));
      file.on('finish', () => file.close(() => (got > 0 ? resolve({ file: path.basename(dest), bytes: got }) : abort('empty response'))));
      request.setTimeout(30000, () => abort('timed out'));
    });
    request.on('error', (error) => {
      fs.rm(dest, { force: true }, () => {});
      reject(error);
    });
  });
}

async function acquireMedia(options) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const collected = [];

  if (options.from) {
    const dir = options.from;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`--from ${dir}: ${error.code || error.message}`);
    }
    const videos = entries.filter((entry) => entry.isFile() && /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(entry.name));
    if (!videos.length) throw new Error(`--from ${dir} has no .mp4/.webm/.mov/.mkv/.ogv files`);
    const empty = [];
    for (const entry of videos) {
      const source = path.join(dir, entry.name);
      const bytes = fs.statSync(source).size;
      // a 0-byte file copies happily and seeds a card that can never play (the media route
      // answers every range with 416), so refuse it instead of publishing a dead video
      if (!bytes) {
        empty.push(entry.name);
        continue;
      }
      const target = path.join(MEDIA_DIR, `seed-local-${entry.name.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
      fs.copyFileSync(source, target);
      collected.push({
        file: path.basename(target),
        bytes,
        duration: 15,
        posterHint: collected.length,
      });
    }
    if (empty.length) console.warn(`[seed] --from ${dir}: skipped empty file(s): ${empty.join(', ')}`);
    if (!collected.length) throw new Error(`--from ${dir}: every video file was 0 bytes`);
    console.log(`[seed] ingested ${collected.length} local file(s) from ${dir}`);
    return collected;
  }

  if (options.skipMedia) {
    console.log('[seed] --skip-media: no video files, videos fall back to posters');
    return [];
  }

  const failures = [];
  for (const source of CC0_SOURCES) {
    const target = path.join(MEDIA_DIR, source.file);
    // The content-length we HEAD-probed when pinning this source doubles as an
    // integrity check, so a re-seed reuses the file instead of re-downloading it.
    if (!options.refreshMedia && fs.existsSync(target) && fs.statSync(target).size === source.size) {
      collected.push({ file: source.file, bytes: source.size, duration: source.duration, posterHint: source.posterHint });
      console.log(`[seed] reused ${source.file} (${(source.size / 1024 / 1024).toFixed(2)} MB)`);
      continue;
    }
    try {
      const saved = await download(source.url, target);
      fs.chmodSync(target, 0o644);
      collected.push({ file: saved.file, bytes: saved.bytes, duration: source.duration, posterHint: source.posterHint });
      console.log(`[seed] downloaded ${source.file} (${(saved.bytes / 1024 / 1024).toFixed(2)} MB)`);
    } catch (error) {
      failures.push(`${source.file}: ${error.message}`);
      fs.rm(target, { force: true }, () => {});
    }
  }

  if (failures.length) console.warn(`[seed] some sources failed: ${failures.join(' | ')}`);
  if (!collected.length) {
    console.warn('');
    console.warn('!! [seed] WARNING: every media source failed (no network?).');
    console.warn('!! [seed] Videos will have url:"" and a generated poster only.');
    console.warn('!! [seed] Playable demo: put .mp4/.webm files somewhere and run');
    console.warn(`!! [seed]   node scripts/seed.mjs --from <dir> --force`);
    console.warn('');
  }
  return collected;
}

/* ------------------------------------------------------------------- seed -- */

function count(table, where = '', params = []) {
  return get(`SELECT COUNT(*) AS n FROM ${table}${where}`, params).n;
}

function existingCounts() {
  const out = {};
  for (const table of ['users', 'videos', 'comments', 'likes', 'favorites', 'follows', 'messages', 'threads']) {
    out[table] = count(table);
  }
  return out;
}

function wipeSeeded() {
  transaction(() => {
    // Deleting seeded users cascades videos/comments/likes/threads through FKs, which
    // is why child rows are deliberately not deleted one table at a time.
    run(`DELETE FROM users WHERE seeded = 1`, []);
    run(`DELETE FROM media_objects WHERE media_key LIKE 'seed-%'`, []);
  });
}

function seedDatabase(users, media) {
  const random = makeRandom('douyin-clone-seed');
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const start = Date.now();

  const userIds = [];
  transaction(() => {
    users.forEach((spec, index) => {
      const { salt, hash } = hashPassword(SEED_PASSWORD);
      const createdAt = start - (400 - index * 20) * DAY;
      const result = run(
        `INSERT INTO users (username, password_hash, password_salt, display_name, bio, avatar_color, verified, seeded, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [spec.username, hash, salt, spec.display_name, spec.bio, pickColor(spec.username),
          spec.verified ? 1 : 0, createdAt, createdAt]
      );
      userIds.push(Number(result.lastInsertRowid));
    });
  });

  const videoIds = [];
  transaction(() => {
    CAPTIONS.forEach((caption, index) => {
      const authorIdx = index % userIds.length;
      const authorId = userIds[authorIdx];
      const createdAt = start - (index * 17 * HOUR + random(6) * HOUR);
      const clip = media.length ? media[index % media.length] : null;
      const width = 1080;
      const height = 1920;
      const duration = clip ? clip.duration : 8 + random(45);
      const url = clip ? `/media/${encodeURIComponent(clip.file)}` : '';
      const mediaKey = clip ? clip.file : '';
      if (clip) {
        run(
          `INSERT INTO media_objects (media_key, owner_id, bytes, content_type, origin, created_at)
           VALUES (?, ?, ?, ?, 'seed', ?) ON CONFLICT(media_key) DO UPDATE SET bytes = excluded.bytes`,
          [clip.file, authorId, clip.bytes, clip.file.endsWith('.webm') ? 'video/webm' : 'video/mp4', createdAt]
        );
      }
      const result = run(
        `INSERT INTO videos (author_id, caption, url, poster, media_key, duration, width, height, views, shares, sort_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [authorId, caption, url, syntheticPoster(caption, clip ? clip.posterHint : index), mediaKey, duration, width, height,
          random(40000) + 120, random(900), 0, createdAt]
      );
      videoIds.push({ id: Number(result.lastInsertRowid), authorId, createdAt });
    });
  });

  // Engagement first, then the frozen recommendation key: sort_key must be written
  // after likes/comments exist so popularity is reflected, but never touched again.
  transaction(() => {
    videoIds.forEach((video, index) => {
      const likerCount = random(userIds.length);
      const picked = new Set();
      for (let i = 0; i < likerCount; i += 1) picked.add(userIds[random(userIds.length)]);
      picked.forEach((userId) => {
        run(`INSERT INTO likes (video_id, user_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM likes WHERE video_id = ? AND user_id = ?)`,
          [video.id, userId, video.createdAt + random(72) * HOUR, video.id, userId]);
      });
      if (index % 3 === 0) {
        const favCount = 1 + random(3);
        for (let i = 0; i < favCount; i += 1) {
          const userId = userIds[random(userIds.length)];
          run(`INSERT INTO favorites (video_id, user_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM favorites WHERE video_id = ? AND user_id = ?)`,
            [video.id, userId, video.createdAt + random(50) * HOUR, video.id, userId]);
        }
      }
      // Recommendation key: recency plus a *capped* engagement lift, so a 30-day-old
      // clip can never outrank this morning's uploads. Frozen after this point.
      const lift = Math.min(picked.size, 6) * 2 * HOUR;
      run(`UPDATE videos SET sort_key = ? WHERE id = ?`, [video.createdAt + lift, video.id]);
    });
  });

  transaction(() => {
    userIds.forEach((followerId, index) => {
      const targets = 2 + random(userIds.length - 2);
      const seen = new Set();
      for (let i = 0; i < targets; i += 1) {
        const targetId = userIds[(index + 1 + random(userIds.length - 1)) % userIds.length];
        if (targetId === followerId || seen.has(targetId)) continue;
        seen.add(targetId);
        run(`INSERT INTO follows (follower_id, user_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND user_id = ?)`,
          [followerId, targetId, start - random(120) * DAY, followerId, targetId]);
      }
    });
  });

  transaction(() => {
    videoIds.forEach((video) => {
      const count = random(6);
      for (let i = 0; i < count; i += 1) {
        const authorId = userIds[random(userIds.length)];
        const created = video.createdAt + (i + 1) * random(6) * HOUR;
        const result = run(
          `INSERT INTO comments (video_id, author_id, parent_id, content, created_at) VALUES (?, ?, NULL, ?, ?)`,
          [video.id, authorId, COMMENT_TEXTS[random(COMMENT_TEXTS.length)], created]
        );
        const commentId = Number(result.lastInsertRowid);
        for (let k = 0; k < random(userIds.length); k += 1) {
          // The same user can be drawn twice, so the composite PK needs OR IGNORE.
          run(`INSERT OR IGNORE INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)`,
            [userIds[random(userIds.length)], commentId, created + HOUR]);
        }
        if (i % 3 === 0 && count > 2) {
          const replyAuthorId = video.authorId;
          run(`INSERT INTO comments (video_id, author_id, parent_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
            [video.id, replyAuthorId, commentId, '谢谢支持，下期继续！', created + 2 * HOUR]);
        }
      }
    });
  });

  transaction(() => {
    const pairs = [
      [0, 1], [0, 2], [0, 5], [1, 3], [2, 6], [4, 0], [6, 7],
    ];
    pairs.forEach(([a, b], pairIndex) => {
      const userA = userIds[Math.min(a, b)];
      const userB = userIds[Math.max(a, b)];
      const key = `${userA}:${userB}`;
      const threadResult = run(`INSERT INTO threads (thread_key, user_a, user_b, updated_at) VALUES (?, ?, ?, ?)`,
        [key, userA, userB, start - pairIndex * HOUR]);
      const threadId = Number(threadResult.lastInsertRowid);
      const messages = 3 + random(6);
      let lastId = null;
      let lastAt = start - (messages + pairIndex) * HOUR;
      for (let i = 0; i < messages; i += 1) {
        const sender = i % 2 === 0 ? (a < b ? userA : userB) : (a < b ? userB : userA);
        const recipient = sender === userA ? userB : userA;
        lastAt += (15 + random(90)) * 60 * 1000;
        const result = run(
          `INSERT INTO messages (thread_id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
          [threadId, sender, recipient, DM_TEXTS[(pairIndex * 3 + i) % DM_TEXTS.length], lastAt]
        );
        lastId = Number(result.lastInsertRowid);
      }
      run(`UPDATE threads SET last_message_id = ?, updated_at = ? WHERE id = ?`, [lastId, lastAt, threadId]);
      // The first account has read everything; everyone else still has unread DMs,
      // so /api/conversations shows a non-zero badge out of the box.
      run(`INSERT INTO thread_reads (thread_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)`,
        [threadId, userIds[0], lastId, lastAt]);
    });
  });
}

function report() {
  const counts = {
    users: count('users'),
    videos: count('videos'),
    comments: count('comments'),
    likes: count('likes'),
    favorites: count('favorites'),
    follows: count('follows'),
    threads: count('threads'),
    messages: count('messages'),
    media_objects: count('media_objects'),
  };
  const onDisk = fs.existsSync(MEDIA_DIR)
    ? fs.readdirSync(MEDIA_DIR).filter((name) => /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(name))
    : [];
  const bytes = onDisk.reduce((sum, name) => sum + fs.statSync(path.join(MEDIA_DIR, name)).size, 0);
  console.log('[seed] row counts:');
  for (const [key, value] of Object.entries(counts)) console.log(`  ${key.padEnd(14)} ${value}`);
  console.log(`  media files     ${onDisk.length} (${(bytes / 1024 / 1024).toFixed(2)} MB) in ${path.relative(REPO, MEDIA_DIR)}/`);
  console.log(`  playable videos ${count('videos', ` WHERE url <> ''`)} / ${counts.videos}`);
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  openDatabase();
  const before = existingCounts();
  if ((before.users || before.videos) && !options.force) {
    console.error(`[seed] database already has ${before.users} users / ${before.videos} videos.`);
    console.error('[seed] rerun with --force to wipe previously seeded rows.');
    process.exitCode = 1;
    closeDatabase();
    return;
  }
  if (options.force) {
    wipeSeeded();
    console.log('[seed] removed previous seeded rows');
  }

  const media = await acquireMedia(options);
  const t0 = Date.now();
  seedDatabase(USERS, media);
  report();
  console.log(`[seed] done in ${Date.now() - t0}ms -> ${path.relative(REPO, DB_FILE)}`);
  console.log(`[seed] demo logins: ${USERS.map((u) => u.username).slice(0, 3).join(', ')} … / ${SEED_PASSWORD}`);
  if (!media.length) console.warn('[seed] NOTE: no playable media was acquired, feed videos are poster-only.');
  closeDatabase();
}

main().catch((error) => {
  console.error('[seed] failed:', error && (error.message || error));
  if (process.env.DY_DEBUG === '1') console.error(error && error.stack);
  process.exit(1);
});
