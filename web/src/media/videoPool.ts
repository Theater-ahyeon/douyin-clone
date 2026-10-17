import type { Video } from '../api/types';

export type PoolRole = 'active' | 'prev' | 'next';
export type SlotPlan = { index: number; video: Video; role: PoolRole };

const POOL_SIZE = 3;
const WARM_BYTES = 320 * 1024;

type Bind = { index: number; url: string; role: PoolRole } | null;

/* docs-perf-notes: one <video> per card is what makes short-video feeds jank — every
   element holds a decoder, a buffer and its own network stack. We keep exactly 3 elements
   for the whole app and move them between recycled card slots, so at most one stream is
   decoded and the browser never churns through element creation on a swipe. */
class VideoPool {
  private els: HTMLVideoElement[] = [];
  private binds: Bind[] = [];
  private slots = new Map<number, HTMLElement>();
  private plan: SlotPlan[] = [];
  private warm: AbortController | null = null;
  private warmUrl = '';
  private warmDone = '';
  private blocked = false;
  private syncers = new Set<() => void>();
  muted = true;
  onSoundChange: ((muted: boolean) => void) | null = null;

  onSync(cb: () => void): () => void {
    this.syncers.add(cb);
    return () => {
      this.syncers.delete(cb);
    };
  }

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('video');
      el.className = 'pool-video';
      el.playsInline = true;
      el.preload = 'none';
      el.loop = true;
      el.muted = true;
      el.tabIndex = -1;
      el.disablePictureInPicture = true;
      el.setAttribute('aria-hidden', 'true');
      this.els.push(el);
      this.binds.push(null);
    }
  }

  registerSlot(index: number, host: HTMLElement | null) {
    if (host) {
      this.slots.set(index, host);
      if (this.plan.some((p) => p.index === index)) this.sync();
      return;
    }
    this.slots.delete(index);
    const slot = this.indexOfIndex(index);
    if (slot >= 0) this.release(slot);
  }

  private indexOfIndex(index: number): number {
    return this.binds.findIndex((b) => b?.index === index);
  }

  elementFor(index: number): HTMLVideoElement | null {
    const slot = this.indexOfIndex(index);
    return slot >= 0 ? this.els[slot] : null;
  }

  activeSlot(): number {
    return this.binds.findIndex((b) => b?.role === 'active');
  }

  activeElement(): HTMLVideoElement | null {
    const slot = this.activeSlot();
    return slot >= 0 ? this.els[slot] : null;
  }

  activeIndex(): number {
    const slot = this.activeSlot();
    return slot >= 0 ? this.binds[slot]!.index : -1;
  }

  get autoplayBlocked() {
    return this.blocked;
  }

  setPlan(plan: SlotPlan[]) {
    this.plan = plan;
    this.sync();
  }

  private release(slot: number) {
    if (slot < 0) return;
    const el = this.els[slot];
    if (!this.binds[slot]) return;
    el.pause();
    /* clearing src + load() is the only reliable way to cancel a pending media fetch */
    el.removeAttribute('src');
    el.load();
    el.remove();
    this.binds[slot] = null;
  }

  private sync() {
    const wanted = this.plan.filter((p) => this.slots.has(p.index));
    const wantedIndexes = new Set(wanted.map((w) => w.index));
    for (let i = 0; i < this.els.length; i++) {
      const b = this.binds[i];
      if (b && !wantedIndexes.has(b.index)) this.release(i);
    }
    const ordered = [...wanted].sort((a, b) => rank(a.role) - rank(b.role));
    for (const item of ordered) {
      let slot = this.indexOfIndex(item.index);
      if (slot < 0) slot = this.binds.findIndex((b) => b === null);
      if (slot < 0) slot = this.binds.findIndex((b) => b && b.role !== 'active');
      if (slot < 0) continue;
      const held = this.binds[slot];
      if (held && held.index !== item.index) this.release(slot);
      this.bind(slot, item);
    }
    this.playActive();
    this.armPreload();
    for (const cb of [...this.syncers]) cb();
  }

  private bind(slot: number, item: SlotPlan) {
    const el = this.els[slot];
    const prev = this.binds[slot];
    const same = !!prev && prev.index === item.index && prev.url === item.video.url;
    this.binds[slot] = { index: item.index, url: item.video.url, role: item.role };
    const host = this.slots.get(item.index);
    if (host && el.parentElement !== host) host.appendChild(el);
    el.muted = this.muted;
    if (same) {
      /* roles rotate with no network work: a slot promoted to active keeps every byte it has
         already buffered (re-assigning src + load() would drop the buffer and refetch from 0),
         a slot demoted to prev stops asking for more via preload */
      if (item.role !== 'active') el.preload = item.role === 'next' ? 'metadata' : 'none';
      return;
    }
    /* docs-perf-notes: one src assignment and one load() per prime. The old code set
       preload='none' here and let armPreload() flip it to 'metadata' and call load() again,
       which aborted the fetch that had just started (2.1 media requests per swipe). */
    el.preload = item.role === 'active' ? 'auto' : item.role === 'next' ? 'metadata' : 'none';
    el.src = item.video.url;
    el.load();
  }

  private playActive() {
    const slot = this.activeSlot();
    for (let i = 0; i < this.els.length; i++) {
      const el = this.els[i];
      if (i !== slot) {
        if (!el.paused) el.pause();
        continue;
      }
      if (document.hidden) continue;
      const p = el.play();
      if (!p || typeof p.catch !== 'function') continue;
      p.catch(() => {
        if (el.muted) return;
        /* docs-perf-notes: an unmuted play() rejects until the user has gestured; fall back
           to muted instead of leaving a black frame, and tell the UI to flip the speaker. */
        el.muted = true;
        this.muted = true;
        this.blocked = true;
        this.onSoundChange?.(true);
        void el.play().catch(() => undefined);
      });
    }
  }

  private armPreload() {
    const slot = this.activeSlot();
    if (slot >= 0) this.els[slot].preload = 'auto';
    const nextSlot = this.binds.findIndex((b) => b?.role === 'next');
    if (nextSlot < 0) {
      this.abortWarm();
      return;
    }
    const el = this.els[nextSlot];
    /* docs-perf-notes: the upcoming clip gets metadata (already requested by the single
       load() in bind) + a byte-range warm-up, never a play. Flipping preload here is enough
       to keep the media element buffering; calling load() again would restart the fetch. */
    el.preload = 'metadata';
    this.warmUp(el.src);
  }

  private abortWarm() {
    this.warm?.abort();
    this.warm = null;
    this.warmUrl = '';
  }

  private warmUp(url: string) {
    /* idempotent per url: a sync() can fire several times for the same upcoming card
       (setPlan + slot registration), and each repeat used to abort and restart the range
       request, so the warm-up never finished and the bytes were fetched twice */
    if (!url || url === this.warmUrl || url === this.warmDone) return;
    this.abortWarm();
    const ctrl = new AbortController();
    this.warm = ctrl;
    this.warmUrl = url;
    void fetch(url, {
      headers: { Range: `bytes=0-${WARM_BYTES - 1}` },
      signal: ctrl.signal,
      credentials: 'same-origin'
    })
      .then((res) => this.drain(res))
      .then(() => {
        if (this.warm !== ctrl) return;
        this.warm = null;
        this.warmUrl = '';
        this.warmDone = url;
      })
      .catch(() => {
        if (this.warm === ctrl) {
          this.warm = null;
          this.warmUrl = '';
        }
      });
  }

  /* docs-perf-notes: the body is streamed and cancelled at WARM_BYTES, so even a server that
     ignored the Range header could never pull a whole 0.5-5MB clip for a card the user has
     not reached. arrayBuffer() had no such ceiling. */
  private async drain(res: Response): Promise<void> {
    if (!res.ok) return;
    if (!res.body) {
      await res.arrayBuffer();
      return;
    }
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      got += chunk.value?.byteLength ?? 0;
      if (got >= WARM_BYTES) {
        await reader.cancel();
        break;
      }
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.blocked = false;
    for (let i = 0; i < this.els.length; i++) {
      const el = this.els[i];
      el.muted = muted;
      if (!muted && this.binds[i]?.role === 'active' && el.paused) void el.play().catch(() => undefined);
    }
  }

  togglePlay() {
    const el = this.activeElement();
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  resume() {
    this.playActive();
  }

  pauseAll() {
    for (const el of this.els) el.pause();
  }

  seekRatio(ratio: number) {
    const el = this.activeElement();
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    el.currentTime = Math.min(0.999, Math.max(0, ratio)) * el.duration;
  }
}

function rank(role: PoolRole): number {
  return role === 'active' ? 0 : role === 'next' ? 1 : 2;
}

export const videoPool = new VideoPool();

document.addEventListener(
  'visibilitychange',
  () => {
    if (document.hidden) videoPool.pauseAll();
    else videoPool.resume();
  },
  { passive: true }
);
