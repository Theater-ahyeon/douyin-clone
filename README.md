# FastVideo — 抖音风格全栈短视频平台（Web / Windows / Android 三端）

一个**独立实现（clean-room）**的短视频社交平台，复刻抖音的产品形态与界面语言：竖屏滑动信息流、点赞/评论/收藏/分享、关注与关注流、私信、搜索、上传、个人主页。

包含三个客户端 + 一个零依赖后端：

| 端 | 目录 | 技术 | 产物 |
|---|---|---|---|
| 网页端 | `web/` | React 18 + Vite + TypeScript | `web/dist` |
| Windows 桌面端 | `desktop/` | Electron 44 | `.exe` / NSIS 安装包 |
| 安卓端 | `android/` | Kotlin + WebView（compileSdk 35） | `app-debug.apk` |
| 服务端 | `server/` | Node 24 内置模块，**零第三方依赖** | `127.0.0.1:8787` |

> **免责声明**：本项目仅用于学习与技术研究，与字节跳动无关，不含任何抖音/TikTok 的代码、商标、图标、字体或视频内容。界面复刻的是版式与交互模式（布局、配色值、信息层级），所有代码与图形资源均为原创。种子视频来自 MDN 的 CC0 共享素材。请勿用于仿冒、爬取或任何违反平台条款与法律的用途。

---

## 1. 快速开始

要求 **Node ≥ 22.5**（开发验证于 v24.13.0）。

```bash
npm install            # 安装 web 工作区依赖（react / vite / typescript）
npm run seed           # 建库 + 生成 8 用户 / 40 视频 / 136 评论 / 关注 / 私信
npm run dev            # 同时起 API(:8787) 与 Vite(:5173)
```

打开 <http://127.0.0.1:5173>。任意已播种用户名（如 `alice_walker`）配合密码 `password123` 登录，或自行注册。

**离线播种**（不联网时）：

```bash
npm run seed -- --from /path/to/your/videos   # 摄入本地 mp4/webm
```

40 条视频复用少量 CC0 素材（联网时抓到 5 个文件），因此 `media_objects` 少于视频数是正常的；`--from` 的素材数量决定离线播种能生成多少条**可播放**的视频，缺到的素材退化为纯色 poster 卡片。

端口可换：`DY_PORT=8888 DY_WEB_PORT=5180 npm run dev`，Vite 代理会跟随 `DY_PORT`，不用改配置。全部环境变量在 `server/src/config.js` 顶部集中注释。

**单端口生产模式**（前端与 API 同源，SPA 回退）：

```bash
npm run build          # 产出 web/dist
npm start              # 仅 :8787 同时提供静态资源与 API
```

---

## 2. 架构

```
                    ┌──────────────────────────────┐
   浏览器 ──────────▶│  Vite dev :5173              │  开发期代理 /api /media
   Electron ───────▶│  node:http 服务 :8787        │  生产期同源托管 web/dist
   Android WebView ─▶│  ┌────────  ┌───────────┐  │
                    │  │ router │─▶│  api.js   │  │  28 个端点
                    │  └────────┘  └──────────┘  │
                    │                    │        │
                    │      ┌─────────────┼─────┐  │
                    │      ▼             ▼     ▼  │
                    │  queries.js    media.js auth│
                    │  (keyset 分页) (Range 流式)  │
                    │      │             │        │
                    │      ▼             ▼        │
                    │  node:sqlite   data/videos/ │
                    │  (WAL)         (0.5–5MB)    │
                    └──────────────────────────────┘
```

- **服务端零第三方依赖**：只用 `node:http`、`node:sqlite`、`node:crypto`、`node:fs`。没有 express/fastify/ORM/jwt 库，因此没有供应链依赖面，`npm install` 也不需要编译原生模块（Windows 上尤其重要）。
- **数据库**：Node 24 内置 `node:sqlite`（`DatabaseSync`，本机免 `--experimental-sqlite` flag）。WAL 模式、外键开启、全部查询走 prepared statement + 绑定参数。
- **媒体**：`fs.createReadStream` 管道 + 显式背压处理，支持单/多区间 `Range`。
- **前端状态**：自研极简响应式 store（`web/src/store/reactive.ts`），无 Redux/Zustand 依赖。
- **路由**：自研 hash 路由（`web/src/router/`），无 react-router 依赖。

详细分层说明见各子文档：

- [`docs/perf-frontend.md`](docs/perf-frontend.md) — 前端卡顿分析与视频池/虚拟化
- [`docs/perf-backend.md`](docs/perf-backend.md) — 后端压测、索引与流式性能
- [`docs/feature-parity.md`](docs/feature-parity.md) — 与抖音的功能对齐规格：可观察行为、差距归类、明确不做的部分
- [`desktop/README.md`](desktop/README.md) — Windows 端打包与安全 IPC
- [`android/README.md`](android/README.md) — 安卓端构建、安装与 WebView 安全策略

---

## 3. 功能矩阵

**信息流**：推荐流 / 关注流、CSS scroll-snap 竖滑、键盘 `Space` 播放暂停、`J/K/↑/↓` 切换、点击暂停、进度条 hover 拖拽、静音开关、倍速。

**互动**：点赞（乐观更新 + 失败回滚 + 心跳粒子动画）、收藏、评论（一级回复、点赞、删除自己的评论）、分享计数、播放量上报。

**社交**：关注/取关（头像上的 `+` 角标）、粉丝与关注列表、个人主页（作品/喜欢双 Tab 九宫格）、他人主页。

**内容**：上传页（拖拽 + 本地预览 + XHR 真实进度条 + 元数据表单）、注册媒体、封面自动生成。

**发现**：搜索（视频 + 用户，250ms 防抖 + 可中止请求）、话题标签。

**消息**：会话列表（未读计数）、私信线程。

**账号**：注册/登录、JWT 风格 HMAC token、个人资料编辑（昵称/简介/头像色）。

---

## 4. API 契约

Base `http://127.0.0.1:8787`，鉴权 `Authorization: Bearer <token>`。

| 方法 | 路径 |
|---|---|
| `POST` | `/api/auth/register` · `/api/auth/login` |
| `GET PATCH` | `/api/users/me` |
| `GET` | `/api/feed` · `/api/following-feed` · `/api/videos/:id` · `/api/users/:id` · `/api/users/:id/videos` · `/api/users/:id/followers` · `/api/users/:id/following` |
| `POST` | `/api/videos` · `/api/videos/:id/like` · `/api/videos/:id/favorite` · `/api/videos/:id/views` · `/api/videos/:id/share` · `/api/videos/:id/comments` · `/api/users/:id/follow` · `/api/messages/:userId` |
| `DELETE` | `/api/videos/:id/like` · `/api/videos/:id/favorite` · `/api/comments/:id` · `/api/users/:id/follow` |
| `GET` | `/api/videos/:id/comments` · `/api/search?q=` · `/api/conversations` · `/api/messages/:userId` |
| `PUT` | `/api/upload`（**裸字节流**，元数据走 `X-Meta` 头，非 multipart） |
| `GET HEAD` | `/media/:filename`（支持 `Range`） |

分页一律 **keyset cursor**（base64url 不透明游标，按 `(sort_key,id)` 前进），不使用 `OFFSET`，因此深翻页不退化。

已实测通过的行为：错误密码 `401`、缺失 token `401`、伪造 token `401`、重名注册 `409 username_taken`、引用他人上传的 `media_key` `403 media_not_owned`、路径穿越 `400`、超长请求体 `413`、空上传体 `400 empty_upload`、`Range` 返回 `206` 且带 `Content-Range: bytes 1848-2047/2048`、非法区间（`bytes=5-3`）按 RFC 9110 忽略并回 `200` 整体。

---

## 5. 性能工程（本项目重点）

短视频产品的性能本质是**「别把解码器和主线程挤爆」**。三组独立优化：

### 5.1 前端：视频池 + 虚拟化

`web/src/media/videoPool.ts` 维护**固定 3 个 `<video>` 元素**（前/中/后），通过 re-parent 复用到当前卡片，而不是每张卡各挂一个视频节点。实测：任意时刻 DOM 中 `.pool-video` 恒为 3，其中仅 1 个 `paused:false`。

- 活跃项 `preload="auto"`，下一项 `metadata` + 字节区间预热，其余 `none`；切换活跃索引时中止在途加载。
- 活跃索引由 `IntersectionObserver` 驱动，滚动监听全部 `{passive:true}`，滚动回调内不做同步 `getBoundingClientRect`。
- 点赞/评论状态放在卡片树之外的 store，点一次赞不重绘整个信息流。
- 动画只用 `transform`/`opacity`。
- 路由级 `React.lazy` 代码分割。

**构建产物**（`vite build`）：74 模块，首屏 `index.js` **186.15 kB / gzip 60.53 kB**，CSS 27.67 kB / gzip 6.50 kB，各页面独立分片 0.5–9.1 kB。

### 5.2 后端：压测驱动的索引修复

`scripts/benchmark.mjs`（零依赖自研压测器，自带临时库副本、并发池、p50/p95/p99、事件循环延迟、Range 吞吐）。

**真实修复**：`comment_likes` 主键是 `(user_id, comment_id)`，而按评论统计点赞走 `WHERE comment_id = ?`，非前导列 → **每条评论一次全表扫描**。新增 `idx_comment_likes_comment(comment_id, user_id)` 后：

```
EXPLAIN QUERY PLAN
  修复前: SCAN cl USING COVERING INDEX sqlite_autoindex_comment_likes_1
  修复后: SEARCH cl USING COVERING INDEX idx_comment_likes_comment (comment_id=?)

comments 端点  p50 2.8 → 2.3 ms      req/s 6107 → 7350 (+20%)
```

**混合场景暴露的卡顿**：`media range` 单独压测 30 ms / 625 MB/s，但与 feed 交错时掉到 46 ms / 346 MB/s —— 同步 SQL 阻塞事件循环、拖住字节泵，这正是 `DatabaseSync` 架构的固有代价。

**诚实的负面结果**（已实现但在此数据量下测不出收益，保留是因为对大数据量方向正确）：`PRAGMA mmap_size`、零分配 `sendJson`、`userExists` TTL 缓存。

### 5.3 已修复的界面缺陷（可复现证据）

用浏览器几何探针实测定位，非猜测：

1. **poster 盖住播放中的视频** —— `.card-poster` 为 `z-index:2` 的 `<img>` 且未设 `object-fit`，按 540×960 原比例居中，导致中间被渐变遮住、视频只在两侧露出。改为 `z-index:0` + `object-fit:cover`，并修正淡出选择器 `.feed-item.live-frame` → `.video-frame.live-frame`（**原选择器永不匹配，poster 从来没消失过**）。现实测 `opacity:0 / visibility:hidden`。
2. **操作栏定位到页面顶部** —— 实测 `y:9` 而卡片起于 `y:56`，且贴右边缘被裁切。改为锚定在卡片内、底部对齐。现桌面端 `{x:907,y:219,w:78,h:425}` 完整落在卡片内。
3. **文案重复叠印** —— 根因在服务端：`syntheticPoster` 把 caption 烤进了 SVG 的 `<text>`，于是「第二行字」画在图片里。已改为 `<title>`（保留无障碍语义、不再绘制文字）。

---

## 6. 三端构建

### Windows 桌面端

```bash
cd desktop && npm install
npm run dev      # 指向 Vite :5173
npm run start    # 生产：自举内嵌后端并加载 web/dist
npm run build:win
```

产物（本机已实际打包成功）：`Douyin Clone-1.0.0-portable.exe`（111,607,537 B）、`Douyin Clone-1.0.0-setup.exe`（122,611,506 B，NSIS）。

安全要点：`contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`；IPC 经 `ipc-schema.cjs` 白名单校验，渲染进程拿不到 `ipcRenderer`；非应用来源链接一律 `setWindowOpenHandler` 拒绝并交系统浏览器；单实例锁；退出时回收 fork 的后端子进程，不留孤儿占用 8787。

### 安卓端

```bash
cd android
JAVA_HOME="<jdk17>" ANDROID_HOME="E:\Android\Sdk" ./gradlew.bat assembleDebug
```

产物（本机已编译）：`app/build/outputs/apk/debug/app-debug.apk` **974,560 B**。

```
$ aapt dump badging app-debug.apk
package: name='com.fastvideo.android.debug' versionName='1.0.0-debug'
sdkVersion:'24'   targetSdkVersion:'35'   compileSdkVersion:'35'
launchable-activity: name='com.fastvideo.android.MainActivity'
```

模拟器默认连 `http://10.0.2.2:8787`（宿主 loopback）；真机用齿轮设置页填局域网 IP。运行时截图见 `android/verification/`（信息流播放、搜索、返回键走历史、离线错误面板、重试恢复）。

WebView 安全策略：仅信任配置来源，跨源导航拒绝；`mediaPlaybackRequiresUserGesture=false`（信息流自动播放）、`domStorageEnabled=true`（token 存 localStorage）、`mixedContentMode=NONE`、`allowFileAccess=false`、`safeBrowsingEnabled=true`；`onPermissionRequest` 对非配置来源不放行摄像头/麦克风；未开启 `allowUniversalAccessFromFileURLs`。

---

## 7. 目录结构

```
douyin-clone/
├── server/src/        index router api queries media db auth models config server static util perfmon
├── web/src/           api/ components/ hooks/ media/ pages/ router/ store/ styles/ utils/
├── desktop/           main.cjs preload.cjs src/ electron-builder.yml
├── android/           app/src/main/java/…  gradle/  verification/
├── scripts/           seed.mjs  dev.mjs  start.mjs  benchmark.mjs
└── docs/              perf-frontend.md  perf-backend.md  feature-parity.md
```

---

## 8. 已知限制（不粉饰）

- **同步 SQL 阻塞事件循环**：`DatabaseSync` 在主线程执行，重查询会拖慢并发 Range 响应（已量化，见 §5.2）。根治方案是把 DB 移到 `worker_threads` actor，本项目未实施（改动面大）。
- **无真实推荐算法**：`/api/feed` 是按热度权重的确定性排序，不是协同过滤。
- **无转码/多码率**：上传什么码率就发什么，没有 HLS/DASH 自适应；生产需接 ffmpeg 管线。
- **无对象存储/CDN**：媒体落本地磁盘，`Range` 由 Node 自己服务。
- **无限流与风控**：`POST /api/videos/:id/views` 匿名可调且不计数去重，播放量/分享数可被脚本刷；真实产品需要设备指纹与频控（本项目的签名逆向结论仅用于理解结构，未复刻其风控）。
- **搜索是 `LIKE` 子串**：没有 FTS5 倒排，中文分词与相关性排序都没有；离线播种语料少时更容易空结果。
- **私信无实时推送**：拉取式，无 WebSocket。
- **审核、风控、埋点、直播、电商**等抖音真实系统未实现。
- **桌面端未做像素级视觉验收**：以 DOM 几何断言验证布局正确性，未逐屏比对。
- **APK 未做真机安装验证**（本机无连接设备），但已在模拟器上采集运行时截图。
- **后台暂停不完全**：`videoPool` 监听 `visibilitychange` 暂停/恢复全部媒体元素，安卓壳另外调 `webView.onPause()/pauseTimers()`；两者叠加在实测机型有效，但个别 WebView 版本在 Activity 挂起时不触发 page-visibility，可能后台续播声音。
- 种子视频元数据（1080×1920）与实际素材（MDN `flower.webm` 为横屏）不完全一致，故桌面端视频框按 9:16 留黑边。

---

## 9. 测试与验证命令

```bash
npm run typecheck      # tsc --noEmit，0 error
npm run build          # vite build
npm run seed           # 造演示数据（--from <dir> 可灌本地视频）
npm run dev            # 起 API + 前端，另开终端
npm run smoke          # 25 条契约断言；默认打 http://127.0.0.1:8787，可用 DY_SMOKE_BASE 指向别处
npm run benchmark      # 自研压测器，输出 p50/p95/p99 + 事件循环延迟 + Range 吞吐
node --check server/src/*.js
node desktop/src/check.cjs        # 桌面端静态守卫：IPC 白名单/发送方校验/菜单与导航目标一致/打包清单
```

`npm run smoke` 覆盖鉴权（错误口令 401、伪造/缺失 token 401、重名注册 409）、发布授权（用别人的 `media_key` 发布 403）、计数（点赞/取消、分享、播放）、游标分页不重复、413 体积上限、路径穿越 400，以及三条 Range 语义（后缀区间 206、非法区间按 RFC 9110 忽略、不可满足区间 416）。它会往目标库写数据，请对着临时库或演示库跑。

CI（`.github/workflows/ci.yml`）在 Node 24 上跑 typecheck、`node --check`、桌面守卫、vite build，并对临时库起一次真实 API 服务做 `/api/health` + 注册/登录/发布/分享/越权引用的端到端断言。

安卓端依赖 Android SDK 与 JDK，CI 未覆盖，本地执行：

```bash
cd android && ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest :app:lintDebug
```

---

## 10. 许可

MIT。见 [LICENSE](LICENSE)。再次强调：不含任何字节跳动资产，不得用于仿冒其官方产品。
