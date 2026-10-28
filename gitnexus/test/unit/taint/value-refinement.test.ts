import { describe, expect, it } from 'vitest';
import {
  applyValueEffect,
  joinRefinedValues,
  parseAnchoredAsciiPattern,
  provesInertCommand as evaluateCommand,
  UNKNOWN_VALUE,
  type ValueEffect,
  type RefinedValue,
} from '../../../src/core/ingestion/taint/value-refinement.js';

const provesInertCommand = (value: RefinedValue) =>
  evaluateCommand(value, ['git log -1 ', 'git log -1 --format=%s ', 'git show ']);

describe('bounded value refinements', () => {
  const restriction = { chars: '0123456789abcdef', min: 7, max: 40 };
  const validated: ValueEffect = { kind: 'restrict', value: { kind: 'input' }, restriction };
  const prefix = (text: string, value: ValueEffect): ValueEffect => ({
    kind: 'concat',
    parts: [{ kind: 'literal', value: text }, value],
  });

  it('composes validator and literal construction across function boundaries', () => {
    const args = applyValueEffect(prefix('log -1 ', validated), UNKNOWN_VALUE);
    const command = applyValueEffect(prefix('git ', { kind: 'input' }), args);
    expect(provesInertCommand(command)).toBe(true);
    expect(
      provesInertCommand(
        applyValueEffect(prefix('git log -1 --format=%s ', validated), UNKNOWN_VALUE),
      ),
    ).toBe(true);
    expect(
      provesInertCommand(applyValueEffect(prefix('git show ', validated), UNKNOWN_VALUE)),
    ).toBe(true);
  });

  it.each(['bash -c ', 'git -c alias.foo=!sh foo ', 'git ', 'env '])(
    'does not certify executable or interpreter selection: %s',
    (text) =>
      expect(provesInertCommand(applyValueEffect(prefix(text, validated), UNKNOWN_VALUE))).toBe(
        false,
      ),
  );

  it('keeps an independent unknown contribution unsafe', () => {
    const effect: ValueEffect = {
      kind: 'concat',
      parts: [prefix('git log -1 ', validated), { kind: 'unknown' }],
    };
    expect(provesInertCommand(applyValueEffect(effect, UNKNOWN_VALUE))).toBe(false);
  });

  it('weakens safe/unsafe joins and recursive template growth to unknown', () => {
    const safe = applyValueEffect(prefix('git show ', validated), UNKNOWN_VALUE);
    expect(joinRefinedValues(safe, UNKNOWN_VALUE)).toEqual(UNKNOWN_VALUE);
    const growing = applyValueEffect(prefix('again ', { kind: 'input' }), safe);
    expect(joinRefinedValues(safe, growing)).toEqual(UNKNOWN_VALUE);
  });

  it('does not turn a known incompatible object into a primitive proof', () => {
    const incompatible: RefinedValue = { kind: 'non-string' };
    const first = applyValueEffect(validated, incompatible);
    expect(first).toEqual(incompatible);
    for (const value of [first, joinRefinedValues(incompatible, UNKNOWN_VALUE)]) {
      const second = applyValueEffect(prefix('git show ', validated), value);
      expect(provesInertCommand(second)).toBe(false);
    }
    expect(joinRefinedValues(UNKNOWN_VALUE, incompatible)).toEqual(incompatible);
    expect(applyValueEffect(prefix('git show ', { kind: 'input' }), incompatible)).toEqual(
      incompatible,
    );
  });

  it('discards all proof when an expression exceeds its budget', () => {
    let effect: ValueEffect = validated;
    for (let i = 0; i < 40; i++) effect = { kind: 'restrict', value: effect, restriction };
    expect(applyValueEffect(effect, UNKNOWN_VALUE)).toEqual(UNKNOWN_VALUE);
  });

  it('parses only the bounded, fully anchored ASCII predicate subset', () => {
    expect(parseAnchoredAsciiPattern('^[0-9a-f]{7,40}$', '')).toEqual(restriction);
    expect(parseAnchoredAsciiPattern('^[a-z][0-9]{2}$', '')).toEqual({
      chars: '0123456789abcdefghijklmnopqrstuvwxyz',
      min: 3,
      max: 3,
    });
    for (const [pattern, flags] of [
      ['[0-9a-f]{7,40}', ''],
      ['^[0-9a-f]+$', ''],
      ['^[^;]+$', ''],
      ['^[0-9a-f]{7,40}$', 'g'],
      ['^[0-9a-f]{7,40}$', 'm'],
      ['^(a+)+$', ''],
      ['^[a-z]{1,999999999}$', ''],
    ])
      expect(parseAnchoredAsciiPattern(pattern, flags)).toBeUndefined();
  });
});
