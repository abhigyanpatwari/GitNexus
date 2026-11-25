import { registerCases } from '../support/cases.mjs';
import { describe, it } from 'node:test';
import { expect } from 'expect';
import { getRelationships, useFixture } from '../support/fixture.js';

describe('TypeScript Map iteration tuple positions', () => {
  const result = useFixture('ts-map-tuple-positions', {
    'owners.ts': `
export class Key {
  pair: [number, number] = [1, 2];
  save() {}
}
export class Value {
  save() {}
}
export class Outside {
  save() {}
}
`,
    'entry.ts': `
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
  // @ts-expect-error A for-in loop cannot destructure a property name.
  for (const [, value] in entries) value.save();
}
`,
  });

  const key = 'Method:owners.ts:Key.save#0';
  const value = 'Method:owners.ts:Value.save#0';
  registerCases(
    it,
    [
      ['ordinary', [key, value]],
      ['keyOnly', [key]],
      ['valueOnly', [value]],
      ['elision', [value]],
      ['nested', [value]],
      ['defaultKey', [value]],
      ['asyncElision', [value]],
      ['outerValue', ['Method:owners.ts:Outside.save#0']],
      ['unrelated', []],
      ['forIn', []],
    ] as const,
    'gives %s its exact save targets',
    (caller, expected) => {
      const calls = getRelationships(result(), 'CALLS')
        .filter(
          ({ rel, target }) => rel.sourceId === `Function:entry.ts:${caller}` && target === 'save',
        )
        .map(({ rel }) => rel.targetId)
        .sort();
      expect(calls).toEqual(expected);
    },
  );
});
