import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { Video } from '../api/types';
import type { FeedKind } from '../store/feed';
import { loadMoreFeed } from '../store/feed';
import { videoPool, type SlotPlan } from '../media/videoPool';
import { setSound, uiStore } from '../store/ui';
import { VideoCard } from './VideoCard';

const WINDOW = 3;
const THRESHOLDS = [0.02, 0.3, 0.55, 0.8, 1];

type Props = {
  feedKey: string;
  kind: FeedKind;
  items: Video[];
  empty?: ReactNode;
};

export const FeedScroller = memo(function FeedScroller({ feedKey, kind, items, empty }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const itemEls = useRef(new Map<number, HTMLElement>());
  const observed = useRef(new Set<HTMLElement>());
  const [active, setActive] = useState(0);
  const [cardH, setCardH] = useState(0);

  const count = items.length;
  const visible = Math.min(WINDOW, count);
  const start = count <= WINDOW ? 0 : Math.min(Math.max(active - 1, 0), count - WINDOW);
  const end = start + visible - 1;
  const planKey = `${start}|${end}|${active}|${items[start]?.id ?? ''}|${items[end]?.id ?? ''}`;

  /* docs-perf-notes: the active index comes from IntersectionObserver ratios, never from
     offsetTop / getBoundingClientRect inside a scroll handler, so swipes stay on the
     compositor thread and no forced layout is inserted between frames.
     One observer per mount; cards register through a stable ref callback and the per-render
     work is a Set diff over <=3 entries. The previous version ran disconnect() +
     querySelectorAll() + observe() on EVERY render (and never disconnected on unmount). */
  const syncObservation = useCallback(() => {
    const io = ioRef.current;
    if (!io) return;
    const next = new Set(itemEls.current.values());
    for (const el of observed.current) if (!next.has(el)) io.unobserve(el);
    for (const el of next) io.observe(el);
    observed.current = next;
  }, []);

  const registerItem = useCallback((index: number, el: HTMLElement | null) => {
    if (el) itemEls.current.set(index, el);
    else itemEls.current.delete(index);
  }, []);

  useLayoutEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        let bestIndex = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.55) continue;
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestIndex = Number((entry.target as HTMLElement).dataset.index);
          }
        }
        if (bestIndex >= 0) setActive((cur) => (cur === bestIndex ? cur : bestIndex));
      },
      { root, threshold: THRESHOLDS }
    );
    ioRef.current = io;
    syncObservation();
    return () => {
      io.disconnect();
      ioRef.current = null;
      observed.current = new Set();
    };
  }, [syncObservation]);

  useLayoutEffect(() => {
    syncObservation();
  });

  useLayoutEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const measure = () => {
      const h = root.clientHeight;
      setCardH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const plan: SlotPlan[] = [];
    for (let i = start; i <= end; i++) {
      const video = items[i];
      if (!video) continue;
      plan.push({ index: i, video, role: i === active ? 'active' : i < active ? 'prev' : 'next' });
    }
    videoPool.setPlan(plan);
  }, [planKey]);

  useLayoutEffect(() => {
    if (active < count - 2) return;
    loadMoreFeed(feedKey, kind);
  }, [active, count, feedKey, kind]);

  const lastFeed = useRef(feedKey);
  useEffect(() => {
    if (lastFeed.current === feedKey) return;
    lastFeed.current = feedKey;
    setActive(0);
    const root = scrollerRef.current;
    if (root) root.scrollTop = 0;
  }, [feedKey]);

  /* the keyboard handler reads live values from a ref, so window carries exactly one
     listener for the life of the feed instead of a remove/add pair on every swipe */
  const navRef = useRef({ active, count, cardH });
  useLayoutEffect(() => {
    navRef.current = { active, count, cardH };
  });

  const goTo = useCallback((index: number) => {
    const { count: total, cardH: h } = navRef.current;
    const clamped = Math.min(Math.max(index, 0), Math.max(0, total - 1));
    setActive(clamped);
    const root = scrollerRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`.feed-item[data-index="${clamped}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else root.scrollTo({ top: clamped * h, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      /* space activates the focused control; stealing it would break every rail / tab button
         and the app-wide Ctrl-K shortcut reads as a plain "k" otherwise.
         a keydown can target document/window, which has no closest() to call */
      const onControl = !!(t && typeof t.closest === 'function' && t.closest('button, a, [role="button"]'));
      if (e.code === 'Space' && onControl) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        goTo(navRef.current.active + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        goTo(navRef.current.active - 1);
      } else if (e.code === 'Space') {
        e.preventDefault();
        videoPool.togglePlay();
      } else if (e.key === 'm') {
        setSound(!uiStore.get().soundOn);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo]);

  const cards = useMemo(() => {
    const out: ReactNode[] = [];
    for (let i = start; i <= end; i++) {
      const video = items[i];
      if (!video) continue;
      out.push(<VideoCard key={video.id} video={video} index={i} active={i === active} registerItem={registerItem} />);
    }
    return out;
  }, [start, end, active, items, registerItem]);

  return (
    <div className="feed-scroll" ref={scrollerRef} data-feed={feedKey}>
      <div className="feed-spacer" style={{ height: start * cardH }} />
      {cards}
      {count === 0 ? empty : null}
      <div className="feed-spacer" style={{ height: Math.max(0, count - end - 1) * cardH }} />
    </div>
  );
});
