
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
