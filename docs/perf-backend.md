# Backend performance & stutter (卡顿) — findings

Scope: the zero-dependency `server/src/**` HTTP service (`node:http` + `node:sqlite`
`DatabaseSync` + `node:crypto` + fs Range streams). Everything below was measured on
this machine (Windows 11, Node v24.13.0, loopback) with the self-contained harness at
`scripts/benchmark.mjs`. No third-party load tools were used (`npx`/autocannon banned).

## How to reproduce

```bash
npm run benchmark                                  # default: c20 x 4000ms, all scenarios
node scripts/benchmark.mjs -c 50 -d 6000
node scripts/benchmark.mjs -s mixed --json

# Controlled A/B in a single build (see "Honest negative results"):
DY_PERF_BASELINE=1 node scripts/benchmark.mjs -s comments,feed,mixed   # old code paths
                     node scripts/benchmark.mjs -s comments,feed,mixed  # optimized paths
```

The harness always boots **its own** server on `DY_PORT` (default 8799) against a
throwaway copy of `server/data/app.sqlite` in `os.tmpdir()`, so it never corrupts
seeded state and never touches the dev server on 8787. It exits non-zero if the child
fails to become healthy, and kills its child + temp dir on exit/Ctrl-C.

## Event-loop lag is the stutter signature

`DatabaseSync` runs synchronously on the main thread. While a query executes, no
`fs.ReadStream` `data` callback can fire, so an in-flight Range response cannot pump
bytes. `node:perf_hooks`' `monitorEventLoopDelay` (exposed on the server via
`GET /api/__perf`, gated behind `DY_ELMONITOR=1`) measures exactly that drift. The
harness prints `ELp99` / `ELmax` alongside every scenario.

The `mixed` scenario is the decisive test: it interleaves `GET /api/feed` with
`GET /media/...?Range` on the same pool, so the API row and the media row share one
event loop. This is what playback actually looks like server-side.

## Baseline (before any change) — c20 x 4000ms

| scenario | p50 | p95 | p99 | req/s | MB/s | ELmax |
|---|---|---|---|---|---|---|
| feed (anon) | 5.4 | 7.8 | 9.3 | 3484 | 47.5 | 16.9 |
| feed (authed) | 6.4 | 9.5 | 10.6 | 2929 | 39.9 | 19.4 |
| comments | 2.6 | 5.3 | 6.5 | 6531 | 5.5 | 37.7 |
| media full | 30.0 | 55.5 | 78.5 | 605 | 651 | 15.9 |
| media range | 14.9 | 29.9 | 39.9 | 1235 | 540 | 13.3 |
| **mixed (api)** | 3.0 | 5.2 | 10.3 | 791 | 10.8 | **24.1** |
| **mixed (media)** | 15.6 | **46.1** | 54.2 | 791 | **346** | 24.1 |

Read the last two rows together. The **same** Range requests that complete at
p95 ≈ 30 ms when run alone degrade to p95 ≈ 46 ms (MB/s 625→346) once feed queries
are interleaved, and event-loop max spikes to 24 ms. That gap is the sync query
holding the loop while media bytes wait — a direct, measurable cause of playback
卡顿 under concurrent load.

## The one clear win: a missing covering index (confirmed 卡顿 lever)

`COMMENT_SELECT` (`server/src/queries.js:33-41`) counts likes per comment with
`(SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id)`. The
`comment_likes` PRIMARY KEY is `(user_id, comment_id)` — `comment_id` is **not** the
leading column, so every comment row forced a **full scan of `comment_likes`**:

```
-- EXPLAIN QUERY PLAN, before
3 0 | SCAN cl USING COVERING INDEX sqlite_autoindex_comment_likes_1
```

Fix: `server/src/db.js` now creates, on open,
`CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id, user_id)`.

```
-- EXPLAIN QUERY PLAN, after
3 0 | SEARCH cl USING COVERING INDEX idx_comment_likes_comment (comment_id=?)
```

Measured (harness, c20 x 3000ms, single build, `comments` scenario, two runs each):

| arm | p50 | p95 | req/s |
|---|---|---|---|
| `DY_PERF_BASELINE=1` (no index) | 2.9 / 2.9 | 5.1 / 5.2 | 6173 / 6218 |
| optimized (index) | **2.4 / 2.4** | **4.6 / 4.7** | **7329 / 7267** |

≈ **+17% req/s, −17% p50**, reproducible across both runs. On the seeded 198-row
table the scan is already cheap, so this only scales in absolute terms once
`comment_likes` grows — but the plan change from SCAN→SEARCH is the structural proof
that the per-comment N+1 scan is gone.

## Honest negative results (measured, did NOT matter)

Three other mitigations were implemented, gated behind the same `DY_PERF_BASELINE=1`
switch, and measured in the same A/B. **None moved feed or mixed latency beyond
run-to-run noise on this dataset.** Reported as-is:

1. **`PRAGMA mmap_size = 67108864`** (64 MB memory-map so hot pages skip `read()`).
   feed (anon) baseline p50 5.6/5.9 vs optimized 5.8/5.7 — indistinguishable. The DB
   is ~180 KB and fully resident in the OS page cache already, so mmap can't help. Kept
   because it is free and would help a multi-hundred-MB DB, but **not a measured win**.

2. **Allocation-free JSON writer** (`server/src/util.js` `sendJson`: `Buffer.byteLength`
   + `res.end(string)` instead of `Buffer.from(payload)` per response). feed MB/s and
   latency unchanged within noise; payloads are ~10 KB and V8 encodes the string once
   either way. Kept (strictly less garbage), **not a measured win**.

3. **Per-request auth user-exists cache** (`server/src/queries.js` `userExistsCached`:
   3 s TTL, bounded to 4096 entries). Previously **every** authenticated request ran a
   synchronous `users` PK probe (`server/src/server.js` `resolveViewer`). Result is
   **marginal and inconsistent across runs**: feed (authed) p50 was 6.4/6.3 (baseline) vs
   6.2/6.7 (optimized) in one 2×2 — flat — but 6.1→5.5 ms and 3016→3350 req/s (+11%) in
   another. The PK probe is sub-millisecond, so removing it is near the noise floor at
   c20. Kept: it removes a query from the authed hot path and should pay off as write
   contention rises, but on this data set it is **not a reliable, reproducible gain**.

At c60 the `mixed (media)` row (p95 114–144 ms in both arms) shows the server saturating
its single event loop regardless of these micro-optimizations. The honest conclusion:
on this machine, the dominant stutter lever is the **index** (kills a real scan); the
mmap/JSON/auth-cache trio is architecturally correct but not yet visible because the
seeded dataset is tiny.

## Verified by inspection / confirmed unchanged

- **Prepared-statement cache actually hits.** `server/src/db.js` `prep()` caches by the
  exact SQL string in the `statements` Map. All SQL strings in `queries.js` are module
  constants or built from a fixed set of fragments (no data interpolated into the text —
  `LIMIT ?` is bound, never concatenated), so the Map is **bounded** and warms after the
  first request per shape. Confirmed: the very first request of the first run shows a
  73–88 ms outlier (cold `db.prepare` compile); every subsequent request is 2–6 ms,
  i.e. compile cost is paid once, not per request.
- **Range/stream backpressure is correct.** `media.js` `pipeOne` pauses the ReadStream
  when `res.write()` returns false and resumes on `drain`; multi-range parts await each
  `writeText`'s drain. A slow client cannot pin unbounded memory.
- **Abort cleanup leaks no handles.** `media.js` `streamFile` registers `req.on('close')`
  / `req.on('aborted')` / `res.on('error')` → `abort()` destroys every open stream in
  the `openStreams` set, and the `finally` block destroys stragglers.
- **Upload never buffers.** `PUT /api/upload` → `media.js` `saveUpload` uses
  `req.pipe(writeStream)` to a `wx` file, capping bytes on `data` without accumulating.
  Functional test on this build: 1,128,375-byte `seed-flower.mp4` uploaded →
  `{"media_key":"mvcsc45n-...","bytes":1128375}`; no-auth → 401; bad type → 415.
- **API contract intact.** Post-change smoke on the optimized build: health 200, feed
  200 + items, comments 200 + `total`, media full 200 (Content-Length = file size),
  media Range 206 with `Content-Range: bytes 0-1023/1128375`, path traversal 400,
  bad token 401, `/api/__perf` 404 when `DY_ELMONITOR` unset.

## After — final optimized build, c20 x 4000ms

| scenario | p50 | p95 | p99 | req/s | MB/s | ELmax |
|---|---|---|---|---|---|---|
| feed (anon) | 5.3 | 7.8 | 9.8 | 3554 | 48.4 | 18.2 |
| feed (authed) | 5.8 | 9.2 | 10.5 | 3170 | 43.2 | 18.9 |
| comments | **2.3** | **4.3** | **5.6** | **7714** | 6.5 | **14.9** |
| media full | 33.6 | 53.4 | 62.9 | 568 | 611 | 14.2 |
| media range | 11.9 | 26.1 | 31.5 | 1489 | 651 | 14.7 |
| **mixed (media)** | **11.3** | **33.3** | 38.7 | 1091 | **477** | **16.3** |

`mixed (media)` p95 46.1 → 33.3 ms and MB/s 346 → 477 versus the baseline table above:
the improvement tracks the comments/feed work falling off the loop, but note this run
to-run gap overlaps the noise band from the A/B — treat the index-driven `comments`
gain as the solid result and the `mixed` gain as directional.

## Files touched (this session)

- `server/src/db.js` — `comment_likes(comment_id,user_id)` covering index; `PRAGMA mmap_size`; `PERF_BASELINE` A/B switch.
- `server/src/queries.js` — bounded TTL `userExistsCached` for the authed hot path.
- `server/src/server.js` — `resolveViewer` uses the cached existence probe.
- `server/src/util.js` — allocation-free `sendJson` (gated for A/B).
- `server/src/perfmon.js` — new: opt-in `monitorEventLoopDelay` collector.
- `server/src/index.js` — starts `perfmon` when `DY_ELMONITOR` is set.
- `scripts/benchmark.mjs` — new self-contained load harness.

## What this machine cannot prove

- **Real-world stutter at scale.** 43 videos / 198 comment_likes / ~11 MB media. The
  index win is structural (SCAN→SEARCH) but its millisecond effect only manifests once
  tables are large; the mmap/JSON/auth changes are genuinely below the noise floor at
  this data size and on this host.
- **Gigabit/NIC throughput.** All tests are loopback; `media full` MB/s (600–670) is
  disk-cache + TCP-loopback bound, not a network ceiling.
- **True mixed-client behavior.** The harness is one process competing with the server
  for CPU; tail spikes at c60 (144–249 ms) partly reflect client-side scheduling, not
  only the server.
- **`worker_threads` offload of `DatabaseSync`.** That is the only structural fix for a
  genuinely large dataset pinning the loop, but it is a significant architecture change
  and was out of scope for zero-dependency mitigation; left as the documented next lever.
