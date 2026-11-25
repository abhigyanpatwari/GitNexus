import { registerCases } from '../support/cases.mjs';
import { describe, it } from 'node:test';
import { expect } from 'expect';
import { getRelationships, useFixture } from '../support/fixture.js';

describe('TypeScript instanceof ownership', () => {
  const result = useFixture('ts-instanceof-boundaries', {
    'owners.ts': `
export class Key {
  kind = 'key' as const;
  before() {}
  save() {}
}
export class Other { save() {} }
export class Value {
  kind = 'value' as const;
  before() {}
  save() {}
}
`,
    'entry.ts': `
import { Key, Other, Value } from './owners.js';

export function branches(repo: Key | Value | Other) {
  if (repo instanceof Key) { repo.before(); }
  else { repo.save(); }
}
export function outside(repo: Key | Value) {
  if (repo instanceof Key) { void repo; }
  repo.save();
}
export function unbraced(repo: Key | Value) {
  if (repo instanceof Key) repo.before();
  repo.save();
}
export function reassigned(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    repo = new Value();
    repo.save();
  }
}
export function sequencedWrite(repo: Key | Value, replacement: Value) {
  if (repo instanceof Key) { repo.before(), repo = replacement, repo.save(); }
}
export function unbracedSequence(repo: Key | Value, replacement: Value) {
  if (repo instanceof Key) repo.before(), repo = replacement, repo.save();
}
export function loopSequence(repo: Key | Value, replacement: Value, repeat: boolean) {
  if (repo instanceof Key) {
    while (repeat) repo.before(), repo = replacement, repo.save();
  }
}
export function conditionalWrite(repo: Key | Value, replace: boolean) {
  if (repo instanceof Key) {
    repo.before();
    if (replace) [repo] = [new Value()];
    repo.save();
  }
}
export function loopWrite(repo: Key | Value, values: Value[]) {
  if (repo instanceof Key) {
    repo.before();
    for (repo of values) repo.save();
  }
}
export function wrappedWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    (repo) = new Value();
    repo.save();
  }
}
export function escapedWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    r\\u0065po = new Value();
    repo.save();
  }
}
export function shadowWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    { let repo: Value = new Value(); repo = new Value(); repo.save(); }
    repo.before();
  }
}
export function shadowConstructor(repo: Key | Value) {
  if (repo instanceof Key) {
    const Key = Value;
    void Key;
    repo.save();
  }
}
export function deferred(repo: Key | Value) {
  if (repo instanceof Key) {
    const later = () => repo.save();
    repo = new Value();
    return later;
  }
}
export function stableDeferred(repo: Key | Value) {
  if (repo instanceof Key) {
    const stable = () => repo.save();
    return stable;
  }
}
export function closureWrite(repo: Key | Value) {
  function replace() { repo = new Value(); }
  if (repo instanceof Key) {
    replace();
    repo.save();
  }
}
`,
  });

  const keyBefore = 'Method:owners.ts:Key.before#0';
  const keySave = 'Method:owners.ts:Key.save#0';
  const valueSave = 'Method:owners.ts:Value.save#0';
  registerCases(
    it,
    [
      ['branches', [keyBefore]],
      ['outside', []],
      ['unbraced', [keyBefore]],
      ['reassigned', [keyBefore]],
      ['sequencedWrite', [keyBefore]],
      ['unbracedSequence', [keyBefore]],
      ['loopSequence', []],
      ['conditionalWrite', [keyBefore]],
      ['loopWrite', [keyBefore]],
      ['wrappedWrite', [keyBefore]],
      ['escapedWrite', [keyBefore]],
      ['shadowWrite', [keyBefore, valueSave]],
      ['shadowConstructor', [keySave]],
      ['closureWrite', []],
    ] as const,
    'emits only the proven targets in %s',
    (caller, targets) => {
      const actual = getRelationships(result(), 'CALLS')
        .filter(
          ({ rel, target }) =>
            rel.sourceId === `Function:entry.ts:${caller}` && ['before', 'save'].includes(target),
        )
        .map(({ rel }) => rel.targetId)
        .sort();
      expect(actual).toEqual(targets);
    },
  );

  it('does not carry a mutable narrowing into a deferred callback', () => {
    expect(
      getRelationships(result(), 'CALLS').filter(
        ({ source, rel }) =>
          (source === 'later' || source === 'deferred') && rel.targetId === keySave,
      ),
    ).toEqual([]);
  });

  it('preserves the guarded owner for a callback over an unwritten binding', () => {
    expect(
      getRelationships(result(), 'CALLS')
        .filter(({ rel }) => rel.sourceId.startsWith('Function:entry.ts:stableDeferred.stable@'))
        .map(({ rel }) => rel.targetId),
    ).toEqual([keySave]);
  });
});
