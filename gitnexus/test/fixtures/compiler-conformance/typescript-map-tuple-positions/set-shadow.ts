import type { Key, Value } from './owners.js';

type Set<T> = Iterable<readonly [number, string]>;
type ReadonlySet<T> = Iterable<readonly [number, string]>;

export function shadowed(entries: Set<[Key, Value]>, readonlyEntries: ReadonlySet<[Key, Value]>) {
  for (const [key] of entries) {
    // @ts-expect-error The local iterator yields a number in the first slot.
    key.save();
  }
  for (const [, value] of readonlyEntries) {
    // @ts-expect-error The local iterator yields a string in the second slot.
    value.save();
  }
}
