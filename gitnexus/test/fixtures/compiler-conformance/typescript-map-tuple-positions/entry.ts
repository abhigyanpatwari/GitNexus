
import { Key, Outside, Value } from './owners.js';

export function ordinary(entries: Map<Key, Value>) {
  for (const [key, value] of entries) {
    key.save();
    value.save();
  }
}
export function keyOnly(entries: Map<Key, Value>) {
  for (const [key, value] of entries) key.save();
}
export function valueOnly(entries: Map<Key, Value>) {
  for (const [key, value] of entries) value.save();
}
export function elision(entries: Map<Key, Value>) {
  for (const [, /* skip the key */ value] of entries) value.save();
}
export function nested(entries: Map<Key, Value>) {
  for (const [{ pair: [first, second] }, value] of entries) value.save();
}
export function defaultKey(entries: Map<Key, Value>) {
  for (const [key = new Key(), value,] of entries) value.save();
}
export async function asyncElision(entries: ReadonlyMap<Key, Value>) {
  for await (const [, value] of entries) value.save();
}
export function outerValue(entries: Map<Key, Value>, value: Outside) {
  for (const [, value] of entries) void value;
  value.save();
}
export function unrelated(entries: Iterable<[Key, Value]>) {
  for (const [, value] of entries) value.save();
}
export function forIn(entries: Map<Key, Value>) {
  // A for-in loop cannot destructure a property name.
  for (const [, value] in entries) value.save();
}

export async function asyncIterable(entries: AsyncIterable<[Key, Value]>) {
  for await (const [, value] of entries) value.save();
}
export async function asyncGenerator(entries: AsyncGenerator<readonly [Key, Value], void, unknown>) {
  for await (const [key, value] of entries) { key.save(); value.save(); }
}
export function syncLoopOverAsync(entries: AsyncIterable<[Key, Value]>) {
  // @ts-expect-error A synchronous loop cannot consume an async-only iterator.
  for (const [, value] of entries) value.save();
}

export function named(entries: Iterable<[key: Key, value: Value]>) {
  for (const [first, second] of entries) { first.save(); second.save(); }
}
export function afterRest(entries: Iterable<[...prefix: unknown[], last: Value]>) {
  for (const [, second] of entries) {
    // @ts-expect-error The second slot may be an unknown prefix element.
    second.save();
  }
}

function entryOwner(key: string, value: number): Key;
function entryOwner(key: number, value: string): Value;
function entryOwner(key: string | number, value: string | number) {
  return typeof key === 'string' ? new Key() : new Value();
}
export function mapOverloads(entries: Map<string, number>, reverse: ReadonlyMap<number, string>) {
  for (const [key, value] of entries) {
    const owner = entryOwner(key, value);
    owner.save();
  }
  for (const [key, value] of reverse) {
    const owner = entryOwner(key, value);
    owner.save();
  }
}
export function mapTupleArgument(entries: Map<string, [number, string]>) {
  for (const [, args] of entries) {
    const owner = entryOwner(...args);
    owner.save();
  }
}

export function setEntries(entries: Set<[Key, Value]>) {
  for (const [key, value] of entries) { key.save(); value.save(); }
}
export async function readonlySetEntries(entries: ReadonlySet<readonly [item: Value, id: Key]>) {
  for await (const [first, second] of entries) { first.save(); second.save(); }
}
export function nonTupleSet(entries: Set<string>) {
  for (const [, value] of entries) {
    // @ts-expect-error An iterated string yields characters.
    value.save();
  }
}
// @ts-expect-error A Set has one element type argument.
export function invalidSetArity(entries: Set<[Key, Value], Outside>) {
  for (const [key] of entries) key.save();
}
