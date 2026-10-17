export function safeLocalStorage(prefix: string) {
  const key = (k: string) => `${prefix}:${k}`;
  return {
    get(k: string): string | null {
      try {
        return localStorage.getItem(key(k));
      } catch {
        return null;
      }
    },
    set(k: string, v: string) {
      try {
        localStorage.setItem(key(k), v);
      } catch {
        /* storage disabled */
      }
    },
    remove(k: string) {
      try {
        localStorage.removeItem(key(k));
      } catch {
        /* storage disabled */
      }
    }
  };
}

export const store = safeLocalStorage('dy');

export function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 760px)').matches;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
