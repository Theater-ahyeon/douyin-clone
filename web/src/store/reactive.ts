import { useSyncExternalStore } from 'react';

export type Store<T extends object> = {
  get: () => T;
  set: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const key of Object.keys(next) as (keyof T)[]) {
        if (!Object.is(state[key], next[key] as T[keyof T])) changed = true;
      }
      if (!changed) return;
      state = { ...state, ...next };
      version++;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }
  };
}

export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  const read = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
