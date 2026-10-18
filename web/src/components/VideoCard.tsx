import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Video } from '../api/types';
import { ActionRail } from './ActionRail';
import { Avatar } from './Avatar';
import { VerifiedIcon } from './icons';
import { videoPool } from '../media/videoPool';
import { reportView, toggleLike } from '../store/feed';
import { Link } from '../router/Link';
import { formatCount, tagOf, timeAgo } from '../utils/format';

type Props = {
  video: Video;
  index: number;
  active: boolean;
  registerItem: (index: number, el: HTMLElement | null) => void;
};

function spawnBurst(host: HTMLDivElement | null) {
  if (!host) return;
  const node = document.createElement('div');
  node.className = 'burst';
  node.innerHTML =
    '<svg viewBox="0 0 24 24" width="84" height="84" aria-hidden="true"><path d="M12 20.6 4.7 13.6a4.5 4.5 0 0 1 6.4-6.4l.9.8.9-.8a4.5 4.5 0 0 1 6.4 6.4Z" fill="#fe2c55"/></svg>';
  host.appendChild(node);
  node.addEventListener('animationend', () => node.remove(), { once: true });
}

export const VideoCard = memo(function VideoCard({ video, index, active, registerItem }: Props) {
  const slotRef = useCallback((el: HTMLElement | null) => videoPool.registerSlot(index, el), [index]);
  const itemRef = useCallback((el: HTMLElement | null) => registerItem(index, el), [index, registerItem]);
  const frameRef = useRef<HTMLDivElement>(null);
  const burstRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  const author = video.author;
  const caption = video.caption.trim();
  /* hoisted out of the render path: the tag regex + the aspect-ratio style object used to be
     rebuilt on every re-render of the card (a like tap re-renders it twice) */
  const tags = useMemo(() => tagOf(caption), [caption]);
  const frameStyle = useMemo(() => ({ aspectRatio: `${video.width || 9} / ${video.height || 16}` }), [video.width, video.height]);

  useEffect(() => {
    if (!active) return;
    reportView(video.id);
  }, [active, video.id]);

  /* the 2-line clamp is a visual truncate, so scrollHeight === clientHeight while it is applied
     and the old "scrollHeight - clientHeight > 4" test never fired: long captions painted at
     full height and tap-to-expand stayed dead. The clamp is only decided with the clamp OFF
     (one forced layout per caption change, never per frame), and in a layout effect so the
     temporary unclamped box is never painted. */
  useLayoutEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const prevDisplay = el.style.display;
    const prevOverflow = el.style.overflow;
    el.style.display = 'block';
    el.style.overflow = 'visible';
    const natural = el.scrollHeight;
    el.style.display = prevDisplay;
    el.style.overflow = prevOverflow;
    setClamped(Number.isFinite(lineHeight) ? natural > lineHeight * 2 + 2 : natural > 44);
  }, [caption]);

  /* docs-perf-notes: the progress bar is driven from a rAF loop that writes one transform
     and one text node directly. Routing timeupdate through React state would re-render the
     card ~4x/sec and keep the main thread busy during the swipe.
     Baseline measurement: the old loop rewrote transform + textContent on EVERY frame, which
     cost 1 forced layout and 1 style recalc per idle frame (180 layouts / 180 frames in 3s,
     181ms of main-thread task time for a bar nobody looks at). Writes are now change-gated
     and the loop is parked while the clip is paused. */
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let el: HTMLVideoElement | null = null;
    let lastRatio = -1;
    let lastText = '';

    const write = () => {
      if (!el) return;
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      if (dur <= 0) return;
      const ratio = Math.min(1, el.currentTime / dur);
      if (fillRef.current && Math.abs(ratio - lastRatio) > 0.0004) {
        lastRatio = ratio;
        fillRef.current.style.transform = `scaleX(${ratio})`;
      }
      if (timeRef.current) {
        const text = `${el.currentTime.toFixed(1)}s / ${dur.toFixed(0)}s`;
        if (text !== lastText) {
          lastText = text;
          timeRef.current.textContent = text;
        }
      }
    };

    const paint = () => {
      raf = 0;
      write();
      if (el && !el.paused) raf = requestAnimationFrame(paint);
    };

    const start = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    function onState() {
      const badge = badgeRef.current;
      if (badge) badge.classList.toggle('show', !!el && el.paused);
      write();
      if (el && !el.paused) start();
      else stop();
    }

    const onFrame = () => frameRef.current?.classList.add('live-frame');

    const detach = (target: HTMLVideoElement) => {
      target.removeEventListener('pause', onState);
      target.removeEventListener('play', onState);
      target.removeEventListener('loadeddata', onFrame);
    };

    const attach = () => {
      const next = videoPool.elementFor(index);
      if (next === el) return;
      /* a released slot has no element: drop the listeners instead of keeping a dangling
         handle on a <video> that now belongs to another card */
      if (el) detach(el);
      el = next;
      if (!el) {
        stop();
        return;
      }
      detach(el);
      el.addEventListener('pause', onState, { passive: true });
      el.addEventListener('play', onState, { passive: true });
      el.addEventListener('loadeddata', onFrame, { passive: true });
      onState();
      if (el.readyState >= 2) onFrame();
    };

    attach();
    const off = videoPool.onSync(attach);
    return () => {
      stop();
      off();
      if (el) detach(el);
      frameRef.current?.classList.remove('live-frame');
    };
  }, [active, index]);

  const onScrubStart = (e: PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    const track = e.currentTarget;
    const rect = track.getBoundingClientRect();
    const el = videoPool.elementFor(index);
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const wasPaused = el.paused;
    const seek = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      el.currentTime = ratio * el.duration;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${ratio})`;
    };
    const end = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
      if (!wasPaused) void el.play().catch(() => undefined);
    };
    const move = (ev: globalThis.PointerEvent) => seek(ev.clientX);
    seek(e.clientX);
    el.pause();
    /* capture keeps pointerup/pointercancel on the track: without it a drag released
       outside the 18px strip never unbound this pair and every gesture added another.
       it throws when the pointer is already gone, so scrubbing must survive the miss */
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* listeners below still catch a release made inside the strip */
    }
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  };

  return (
    <article ref={itemRef} className={`feed-item${active ? ' active' : ''}`} data-index={index}>
      <div className="card-stage">
        <div className="video-frame" ref={frameRef} style={frameStyle}>
          {video.poster ? <img className="card-poster" src={video.poster} alt="" decoding="async" draggable={false} /> : null}
          <div className="video-slot" ref={slotRef} />
          <button
            className="tap-layer"
            aria-label="播放或暂停"
            onClick={() => videoPool.togglePlay()}
            onDoubleClick={() => {
              spawnBurst(burstRef.current);
              if (!video.liked) toggleLike(video);
            }}
          />
          <div className="burst-layer" ref={burstRef} />
          <div className="play-badge" ref={badgeRef} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="56" height="56">
              <path d="M8.4 5.4 18.6 12 8.4 18.6Z" fill="rgba(255,255,255,.92)" />
            </svg>
          </div>
          <div className="card-meta">
            <Link to={`/user/${author.id}`} className="meta-author">
              <Avatar user={author} size={26} />
              <span className="meta-name">
                @{author.display_name || author.username}
                {author.verified ? <VerifiedIcon size={13} className="inline-verified" /> : null}
              </span>
            </Link>
            <p
              ref={captionRef}
              className={`caption${clamped && !expanded ? ' clamp' : ''}`}
              onClick={() => (clamped ? setExpanded((v) => !v) : undefined)}
            >
              {caption || '暂无描述'}
            </p>
            <div className="meta-sub">
              <span className="meta-time">{timeAgo(video.created_at)}</span>
              {tags.map((t) => (
                <Link key={t} to={`/search?q=${encodeURIComponent(`#${t}`)}`} className="tag">
                  #{t}
                </Link>
              ))}
              <span className="meta-views">{formatCount(video.stats.views)}播放</span>
            </div>
          </div>
          <div className="scrub" onPointerDown={onScrubStart}>
            <div className="scrub-fill" ref={fillRef} />
          </div>
          <span className="scrub-time" ref={timeRef} />
        </div>
        <ActionRail video={video} />
      </div>
    </article>
  );
});
