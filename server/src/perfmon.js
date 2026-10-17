import { monitorEventLoopDelay } from 'node:perf_hooks';

// Off unless DY_ELMONITOR is set, so production requests never pay for it.
// `monitorEventLoopDelay` is a Node built-in: it schedules a ~10ms timer that a
// lagging loop cannot service on time, and the drift is exactly what stalls a
// media byte from being written. That drift is the server-side signature of 卡顿.
let delay = null;
let started = false;

export function startPerfMon() {
  if (started || !process.env.DY_ELMONITOR) return;
  delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  started = true;
}

export function perfSnapshot({ reset = false } = {}) {
  if (!delay) return { enabled: false };
  const toMs = (ns) => Math.round((ns / 1e6) * 1000) / 1000;
  const stats = {
    enabled: true,
    elMeanMs: toMs(delay.mean),
    elMaxMs: toMs(delay.max),
    elP50Ms: toMs(delay.percentile(50)),
    elP99Ms: toMs(delay.percentile(99)),
    elExceeds10ms: delay.exceeds,
  };
  if (reset) {
    delay.reset();
    stats.reset = true;
  }
  return stats;
}

export function stopPerfMon() {
  if (delay) {
    delay.disable();
    delay = null;
  }
  started = false;
}
