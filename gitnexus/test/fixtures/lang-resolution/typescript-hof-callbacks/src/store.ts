// Stand-ins for Zustand's `create / persist / devtools`. Defined locally
// so the references resolve to real graph nodes and the test doesn't
// depend on an external library.
//
// The shape mirrors the actual Zustand API closely enough that the
// nested-arrow-in-arguments pattern (which was the worst-case repro in
// the bug report — Zustand store files hit 0% CALLS-edge capture) is
// faithfully reproduced.

type StateCreator<T> = (set: (next: Partial<T>) => void) => T;

export const create = <T>() => {
  return (initializer: (...wrappers: never[]) => StateCreator<T>): T => {
    return initializer()(() => {
      /* runtime no-op for this fixture */
    });
  };
};

export const persist = <T>(creator: StateCreator<T>): StateCreator<T> => creator;

export const devtools = <T>(creator: StateCreator<T>): StateCreator<T> => creator;

interface Counter {
  readonly count: number;
  readonly bump: () => void;
}

// The classic Zustand shape:
//
//   const useStore = create<State>()(devtools(persist((set) => ({ ... }))))
//
// Pre-fix: `useStore` lived as a Variable on the module scope; the
// nested arrow callbacks had empty `ownedDefs`; calls inside them
// walked up to the module's first Function-like def and silently
// mis-attributed (or dropped). After the fix, each named arrow gets
// its def attached to its own scope and HOF-wrapped declarations
// participate in the call graph normally.
export const useStore = create<Counter>()(
  devtools(
    persist((set) => ({
      count: 0,
      bump: () => set({ count: 1 }),
    })),
  ),
);
