/**
 * Coverage for `interpretJavaTypeBinding` type-name normalization, focused on
 * F41 (#1928): generics must be stripped BEFORE the qualifier so a qualified
 * generic *type argument* (`Map<String, com.example.User>`) is not corrupted
 * into `User>` by an early `lastIndexOf('.')` cut.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { interpretJavaTypeBinding } from '../../../../../src/core/ingestion/languages/java/interpret.js';

const ZERO_RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;
const cap = (name: string, text: string): Capture => ({ name, text, range: ZERO_RANGE });

/** Build an annotation-source type binding (`Type name;`). */
function binding(typeText: string, sourceTag = '@type-binding.annotation'): CaptureMatch {
  return {
    '@type-binding.name': cap('@type-binding.name', 'x'),
    '@type-binding.type': cap('@type-binding.type', typeText),
    [sourceTag]: cap(sourceTag, typeText),
  };
}

/** The normalized `rawTypeName` for a given raw type string. */
function raw(typeText: string): string | undefined {
  return interpretJavaTypeBinding(binding(typeText))?.rawTypeName;
}

describe('interpretJavaTypeBinding — type normalization (F41 #1928)', () => {
  it('strips a qualifier from a plain qualified type', () => {
    assert.equal(raw('com.example.User'), 'User');
  });

  it('strips generics from an unqualified generic base', () => {
    assert.equal(raw('BaseModel<T>'), 'BaseModel');
  });

  it('strips generics AND qualifier from a qualified generic base', () => {
    assert.equal(raw('com.example.BaseModel<T>'), 'BaseModel');
  });

  it('retains the container around a qualified generic argument (the F41 bug)', () => {
    // Before the fix: stripQualifier ran first → `User>` (trailing bracket).
    assert.equal(raw('Map<String, com.example.User>'), 'Map');
  });

  it('retains a single-arg container with a qualified argument', () => {
    assert.equal(raw('List<com.example.User>'), 'List');
  });

  it('retains a qualified container', () => {
    assert.equal(raw('java.util.List<User>'), 'List');
  });

  it('retains simple containers until an operation yields their element', () => {
    assert.equal(raw('List<User>'), 'List');
    assert.equal(raw('Optional<User>'), 'Optional');
  });

  it('retains a two-arg map', () => {
    assert.equal(raw('Map<String, User>'), 'Map');
  });

  for (const example of [
    ['User[]', 'User[]'],
    ['User[][]', 'User[][]'],
    ['List<User>[]', 'List[]'],
    ['pkg.Box<User>[][]', 'Box[][]'],
  ] as const) {
    it(`preserves all dimensions of ${example[0]}`, () => {
      const [written, expected] = example;

      assert.equal(raw(written), expected);
    });
  }

  it('passes through a plain simple type', () => {
    assert.equal(raw('User'), 'User');
  });

  it('falls back to the raw class name for an unrecognized nested generic', () => {
    // Nested generic args defeat the single/two-arg element extraction; the
    // erasure fallback keeps the outer class name (pre-existing behavior).
    assert.equal(raw('List<Map<String, User>>'), 'List');
  });

  it('keeps the outer class for a QUALIFIED nested generic element (guards the strip order)', () => {
    // Unlike `List<Map<String, User>>` (no dot inside the args, so it yields
    // `List` under both strip orders), this input has a qualified nested
    // element: the OLD order (stripQualifier first) cut inside the generic and
    // produced a corrupted `Foo<String>>`; only generics-first yields `List`.
    // This is the case that actually fails if the F41 reorder regresses.
    assert.equal(raw('List<com.x.Foo<String>>'), 'List');
  });

  it('returns null for a bare `var` with no concrete type', () => {
    assert.equal(interpretJavaTypeBinding(binding('var')), null);
  });
});
