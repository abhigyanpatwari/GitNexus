// Multi-action Zustand-shape store: the regression case the single-pair
// `bump` fixture in `store.ts` masked.
//
// Mirrors the dominant Zustand idiom from the bug report:
//
//   create<State>()(persist((set) => ({
//     addItem: (item) => doA(item),
//     removeItem: (item) => doB(item),
//     fetchData: async () => doC(),
//   })))
//
// With the pre-fix `pair`-with-arrow query patterns, all three
// pair-function defs landed in the same `(set) => ({...})` callback's
// `ownedDefs`. `resolveCallerGraphId.ownedDefs.find(d => d.type === 'Function')`
// then returned `addItem` for every walk-up — every call inside
// `removeItem` and `fetchData` mis-attributed to `addItem`. `gitnexus_context("removeItem")`
// returned zero outgoing edges; `gitnexus_impact("doB", direction:"upstream")`
// missed `removeItem` entirely.
//
// After moving `@declaration.function` to the inner `arrow_function`,
// each pair-arrow gets its own scope's `ownedDefs` populated with its own
// def. Calls inside `removeItem` now stop at `removeItem`'s arrow scope,
// resolve to `removeItem`, and the per-action attribution is correct.

import { create, persist } from './store';

interface MultiAction {
  readonly count: number;
  readonly addItem: (item: number) => void;
  readonly removeItem: (item: number) => void;
  readonly fetchData: () => void;
}

export const doA = (_item: number): void => {};
export const doB = (_item: number): void => {};
export const doC = (): void => {};

export const useMultiActionStore = create<MultiAction>()(
  persist((set) => ({
    count: 0,
    addItem: (item) => {
      doA(item);
      set({ count: 1 });
    },
    removeItem: (item) => {
      doB(item);
      set({ count: 0 });
    },
    fetchData: () => {
      doC();
    },
  })),
);
