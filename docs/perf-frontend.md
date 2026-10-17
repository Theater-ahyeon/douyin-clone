# Feed front-end performance work (clean-room Douyin clone)

Scope: `web/**` — the vertical feed (`FeedPage` → `FeedScroller` → `VideoCard` → `videoPool`)
and the store/router plumbing that decides how many components re-render when a card is tapped.
Purely perf-motivated changes; no visual design was altered (`index.css` and every component
style/class output is byte-identical — CSS chunk hash `index-Ch8YFw4B.css` is unchanged).

All numbers below come from production builds served by `vite preview` and driven by a headless
Chrome 155 over the Chrome DevTools Protocol (`Performance.getMetrics`, `Network.*` events, a
`longtask` `PerformanceObserver`, rAF frame-gap sampling, and a temporary `performance.mark()`
render counter that has since been removed from the tree). Node v24.13.0, Windows 11,
1280×800 viewport, logged in as `alice_walker`, 10 scripted swipes per run, 2 runs per build.

## 1. Baseline: what actually existed

Claims from the task brief that turned out to be **true** (verified in the browser, not read off
the source):

- The 3-element `<video>` pool is real. In a live feed only **3 `<video>` elements are attached
  to the document** (`videosAttached: 3`) and only **3 cards exist in the DOM** (`cardsInDom: 3`)
  regardless of feed length — the ±1 virtualization in `FeedScroller` works.
- Non-adjacent cards never mount, so they never create decoders.
- `feed.css` already animates **transform/opacity only**; no layout-property animation to fix.
- Cards are already `memo`-wrapped, and `store/feed.ts#patchVideo` replaces only the changed
  `Video` object identity, so a like tap does **not** re-render the other cards.
- Poster URLs are ~740-char base64 SVG strings produced once by `normalizeVideo`
  (`web/src/api/endpoints.ts`), not rebuilt per render — the "huge inline data: SVG recreated
  every render" concern did **not** apply here. No fix was made for it.
- The server honours `Range` and sends `Cache-Control: public, max-age=31536000, immutable`
  on `/media`, so a byte warm-up really does translate into a cached first segment.

Claims/defects that turned out to be **false or real problems**, with baseline measurements:

| # | Defect | Baseline measurement |
|---|--------|----------------------|
| 1 | Whole-state store hooks (`useUi()`, `useAuth()`) re-rendered everything that subscribes — the comment drawer alone re-rendered the whole shell | **20 component renders per comment tap**, incl. `App`, `Sidebar`, `TopBar`, `BottomTabs`, `Toaster`, `FeedPage`, `FeedScroller` |
| 2 | `FeedScroller`'s IntersectionObserver effect had **no dependency array**: every render ran `io.disconnect(); io.takeRecords(); root.querySelectorAll('.feed-item[data-index]').forEach(observe)`, and the observer was never disconnected on unmount (leak) | full-window **layout count 100–101 per interaction window**, 121 during a feed refresh |
| 3 | Idle feed (no input at all) still ran a 60 Hz rAF loop that rewrote `textContent` and `style.transform` unconditionally → forced layout **every idle frame** | **1.00 layout + 1.00 recalc per idle frame**, 181.1 / 145.7 ms of main-thread task time in a 3 s idle window |
| 4 | Next-card prime issued **two `load()` calls** (`bind()` set `preload='none'` + `load()`, then `armPreload()` set `metadata` + `load()` again) and the byte warm-up used `res.arrayBuffer()` — an unbounded read of the whole file into memory | **22 media requests / 641 KB** for 10 swipes; warm-up bytes proportional to file size, not to a window |
| 5 | `window` `keydown` listener was removed and re-added on **every active-index change** | re-bound once per swipe |
| 6 | `Avatar` was unmemoized and rebuilt a gradient style object inline on every parent render | **5.8 Avatar renders per swipe** |
| 7 | Router re-emitted a fresh state on no-op hash updates (`read()` builds a new `URLSearchParams`, so `Object.is` always saw a "change") | every subscriber notified on a navigation to the current route |

## 2. Fixes (in the requested priority order)

Decoded streams / element reuse (already correct — kept, hardened, and documented):

- `web/src/media/videoPool.ts:128-147` — `bind()` now performs **exactly one** `src` + `load()`
  per prime and sets `preload` from the slot role at bind time:
  `active → auto`, `next → metadata`, `idle → none`. When the slot already holds the right
  video it only downgrades `preload` and returns, so rotating roles no longer re-fetches and
  **does not throw away the buffered range**.
  Prevents: the double `load()` per swipe (two decoder setups + two aborts for the same clip)
  and buffer eviction on role change.
- `web/src/media/videoPool.ts:140` + `:39-41` — non-adjacent slots stay `preload='none'`
  and are `pause()`d; element pool size is still 3. Nothing else is ever attached.

Prefetch window and aborts:

- `web/src/media/videoPool.ts:175-195` — `armPreload()` no longer calls `load()`; it
  `abortWarm()`s whenever the `next` target changes and only then arms metadata + warm-up.
- `web/src/media/videoPool.ts:7, 197-224, 229-248` — warm-up is capped at
  `WARM_BYTES = 320 KB`, is idempotent per URL (`warmUrl` / `warmDone`), and **streams the body
  with `reader.read()` and `cancel()`s at the cap** instead of `arrayBuffer()`.
  Prevents: unbounded video-byte prefetch (a 40 MB clip used to be fully read into memory).
  Metadata beyond the next-1 clip is never requested — the HTTP warm-up targets exactly next-1,
  and slots further away get `preload='none'` which suppresses even the metadata request.

Scroll handlers / layout reads:

- `web/src/components/FeedScroller.tsx:62-87` — the IntersectionObserver is created **once**
  in a `useLayoutEffect` with a real cleanup (`io.disconnect()`), driven by
  `THRESHOLDS = [0.02, 0.3, 0.55, 0.8, 1]` (`:19`); the active index comes only from IO
  callbacks.
- `web/src/components/FeedScroller.tsx:48-60, 89-91` — `syncObservation()` diffs an `index → el`
  `Map` against the previously observed `Set` (O(≤3) work) instead of `querySelectorAll` +
  full re-observe; `registerItem` is a ref callback (`VideoCard.tsx:30`).
- `web/src/components/FeedScroller.tsx:93-133, 160-167` — hot values (`active`, `count`,
  `cardH`) are read through a `navRef` so `goTo` is `useCallback([])`-stable and the single
  `keydown` listener is bound once per mount. `keydown` keeps `preventDefault()` so it cannot be
  `passive`; everything that can be passive already is (`VideoCard.tsx:125-127`,
  `videoPool.ts:292`, `router.ts:36`).
  Prevents: a forced `querySelectorAll` + observer teardown/rebuild per render, and one
  layout-read burst per frame while momentum scrolling.

Render isolation:

- `web/src/store/ui.ts:33-49` and `web/src/store/auth.ts:24-28` — the whole-state `useUi()` /
  `useAuth()` hooks were replaced by slice hooks (`useToasts`, `useCommentsOpen`,
  `useCommentsVideo`, `useSoundOn`, `isSoundOn`, `useAuthStatus`, `useAuthSheet`); dead
  `paused` state / `setPaused()` were deleted (`noUnusedLocals` would not allow leftovers).
- `web/src/App.tsx:22-47` — the two store-dependent side effects moved out of `App` into
  null-rendering leaves (`SoundBridge`, `BootBridge`), so `App` subscribes only to `useRoute()`
  and renders `null` for every interaction-state change.
- `web/src/pages/FeedPage.tsx:15-34, 53` — HUD and refresh button are separate subscribers and
  the `empty` subtree is `useMemo`'d.
- `web/src/components/FeedScroller.tsx:28`, `Avatar.tsx:21-24`, `ActionRail.tsx:41-48` —
  `FeedScroller` and `Avatar` are now `memo`-wrapped, `Avatar` memoizes its gradient style, and
  the rail passes a stable `useCallback` click handler (previously a fresh arrow per render,
  which would have defeated `memo` on `Avatar`).
- `web/src/router/router.ts:28-44` — no-op hash updates and `navigate()` to the current route
  return early instead of notifying every subscriber.

Painting only:

- `web/src/components/VideoCard.tsx:68-115` — the progress loop is change-gated: it writes
  `style.transform = scaleX(ratio)` only when the ratio moved by >0.0004 and `textContent` only
  when the formatted string changed, and it stops requesting frames as soon as the element is
  paused (`onState` → `start`/`stop`). Progress is expressed as a transform, never `width`.

## 3. After

Production builds, same harness, 2 runs each.

Idle feed, per-frame cost over a 3 s no-input window:

| metric | before | after |
|---|---|---|
| layouts / frame | 1.00 / 1.00 | **0.17 / 0.17** |
| main-thread task ms (3 s idle) | 181.1 / 145.7 | **138.5 / 138.4** |

Scrolling, 10 scripted swipes:

| metric | before | after |
|---|---|---|
| layouts per swipe | 55.5 / 39.4 | **10.2 / 10.1** |
| layout ms per swipe window | 75.7 / 52.1 | **28.6 / 24.4** |
| style recalc ms per swipe | ~51–56 | ~57–68 (unchanged: dominated by the transform writes that must stay) |
| task ms per swipe window | 608 / 483 | 636 / 454 (within noise) |
| `Avatar` renders per swipe | 5.8 | **1.8** |
| `FeedScroller` renders per swipe | 2.2 | 2.1 |
| media requests / 10 swipes | 21 / 22 | 20 / 20 |
| media bytes / 10 swipes | 641 KB | 659 KB cold, **0 KB warm** (immutable cache) |
| `<video>` attached / cards in DOM | 3 / 3 | **3 / 3 (unchanged)** |

Taps (first 150 ms after the tap, component renders):

| interaction | before | after |
|---|---|---|
| like | 13 renders, 10 layouts, 15 ms task | **8 renders, 3 layouts, 11.6 ms task** |
| comment (open drawer) | **20 renders** — App, Sidebar, TopBar, BottomTabs, Toaster, FeedPage, FeedScroller, CommentsDrawer×2, CommentsBody×3, Avatar×6 | **9 renders** — CommentsDrawer×2, CommentsBody×3, Avatar×4; **everything outside the drawer renders 0 times** |
| comment, task ms | 21.8 / 21.0 | **18.5 / 12.6** |
| full-window layouts (like / comment) | 101 / 100 | **18 / 19** |
| feed refresh | 6 `FeedScroller` renders, 121 layouts, 12.1 ms layout | **3 renders, 23 layouts, 3.3 ms layout** |

Chunk sizes (from disk, `gzipSync` level 9; baseline `web/dist` vs final):

| chunk | before raw | before gz | after raw | after gz | Δ gz |
|---|---|---|---|---|---|
| `index.js` | 184,906 | 59,846 | 185,705 | 60,077 | +231 B |
| `FeedPage.js` | 7,906 | 3,504 | 8,843 | 3,825 | +321 B |
| `ActionRail.js` | 1,615 | 738 | 1,641 | 756 | +18 B |
| `VideoPage.js` | 2,086 | 1,026 | 2,076 | 1,020 | −6 B |
| `UploadPage.js` | 5,809 | 2,661 | 5,801 | 2,657 | −4 B |
| `LoginPage.js` | 585 | 396 | 577 | 390 | −6 B |
| `index.css` | 26,872 | 6,303 | 26,872 | 6,303 | 0 (hash identical) |
| **total** | **243,191** | **80,565** | **244,927** | **81,126** | **+561 B** |

Verification: `node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json` → exit 0;
`vite build` → exit 0 ("✓ 74 modules transformed"). The temporary `performance.mark('r:*')`
counters were removed before the final build (`grep` for them in `web/src` returns nothing).
The +1.7 kB raw / +561 B gz cost is the `memo`/`useCallback`/slice-hook plumbing; it buys the
render and layout reductions above.

## 4. What could not be verified

- **No real device or GPU.** This was headless Chrome with software compositing on a desktop
  machine, so frame-gap and long-task numbers are environment-specific; a phone with hardware
  decoding will show a different absolute curve. I did **not** measure perceptual smoothness
  (no `requestAnimationFrame` dropped-frame trace on real hardware, no `dxdiag`-class GPU info).
- **Decoder thread contention is not observable from JS.** I can prove only 3 `<video>` elements
  are attached and that non-adjacent clips never load, but I cannot count live media/decoder
  threads or measure how much decode competes with the main thread from CDP alone.
- **`preload` on the two idle-ish slots.** Both non-active slots reported `metadata` in the
  after run whenever `active === 0`, because cards 1 and 2 both get role `next` at the top of
  the feed. That is the pool's pre-existing 3-slot plan, not a regression; I left it alone
  rather than changing feed semantics for a marginal byte saving.
- **Single-run noise.** One after run showed a 104 ms long task with 2 gaps > 20 ms
  (max gap 115 ms) that did not reproduce in the second run. I am reporting it as noise rather
  than claiming a regression or a fix; no cause was found in the two runs.
- **Warm-up byte savings** could not be shown as a byte reduction, because the server's
  `immutable` cache already makes the second pass 0 KB. The measurable win is that the fetch is
  now *capped* (streamed and cancelled at 320 KB) instead of reading the whole file into an
  `ArrayBuffer`; the memory behaviour change was verified by reading the code path, not by a
  heap-diff measurement.
- **Long-session leak proof.** The IO disconnect-on-unmount and the once-per-mount keydown
  listener are correct by construction, but I did not run a multi-minute mount/unmount soak with
  a heap snapshot to show detached-node counts going from N to 0.
