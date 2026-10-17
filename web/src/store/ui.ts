import { createStore, useStore } from './reactive';
import { uid } from '../utils/storage';
import type { Video } from '../api/types';

export type Toast = { id: string; text: string; tone: 'info' | 'error' | 'ok' };

type UiState = {
  toasts: Toast[];
  commentsVideo: Video | null;
  commentsOpen: boolean;
  soundOn: boolean;
};

const persistedSound = (() => {
  try {
    return localStorage.getItem('dy:sound') === '1';
  } catch {
    return false;
  }
})();

export const uiStore = createStore<UiState>({
  toasts: [],
  commentsVideo: null,
  commentsOpen: false,
  soundOn: persistedSound
});

/* docs-perf-notes: one subscription per primitive slice. `useUi()` used to hand out the
   whole state object, so every toast / drawer open / sound flip re-rendered App and with it
   the sidebar, top bar, tab bar and the feed page (measured 11 component renders per comment
   tap). Narrow selectors mean only the component that reads that slice re-renders. */
export function useToasts(): Toast[] {
  return useStore(uiStore, (s) => s.toasts);
}

export function useCommentsOpen(): boolean {
  return useStore(uiStore, (s) => s.commentsOpen);
}

export function useCommentsVideo(): Video | null {
  return useStore(uiStore, (s) => s.commentsVideo);
}

export function useSoundOn(): boolean {
  return useStore(uiStore, (s) => s.soundOn);
}

export function isSoundOn(): boolean {
  return uiStore.get().soundOn;
}

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = uid();
  uiStore.set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  window.setTimeout(() => {
    uiStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, 2600);
}

export function openComments(video: Video) {
  uiStore.set({ commentsVideo: video, commentsOpen: true });
}

export function closeComments() {
  uiStore.set({ commentsOpen: false });
}

export function setSound(on: boolean) {
  uiStore.set({ soundOn: on });
  try {
    localStorage.setItem('dy:sound', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
