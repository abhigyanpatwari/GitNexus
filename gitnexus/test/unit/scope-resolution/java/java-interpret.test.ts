/**
 * Coverage for `interpretJavaTypeBinding` type-name normalization, focused on
 * F41 (#1928): generics must be stripped BEFORE the qualifier so a qualified
 * generic *type argument* (`Map<String, com.example.User>`) is not corrupted
 * into `User>` by an early `lastIndexOf('.')` cut.
 */

import { describe, it, expect } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { interpretJavaTypeBinding } from '../../../../src/core/ingestion/languages/java/interpret.js';

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
    expect(raw('com.example.User')).toBe('User');
  });

  it('strips generics from an unqualified generic base', () => {
    expect(raw('BaseModel<T>')).toBe('BaseModel');
  });

  it('strips generics AND qualifier from a qualified generic base', () => {
    expect(raw('com.example.BaseModel<T>')).toBe('BaseModel');
  });

  it('does not corrupt a qualified generic TYPE ARGUMENT (the F41 bug)', () => {
    // Before the fix: stripQualifier ran first → `User>` (trailing bracket).
    expect(raw('Map<String, com.example.User>')).toBe('User');
  });

  it('extracts the element type from a single-arg container with qualified arg', () => {
    expect(raw('List<com.example.User>')).toBe('User');
  });

  it('extracts the element type from a qualified container', () => {
    expect(raw('java.util.List<User>')).toBe('User');
  });

  it('extracts the element type from a simple container', () => {
    expect(raw('List<User>')).toBe('User');
    expect(raw('Optional<User>')).toBe('User');
  });

  it('extracts the value type from a two-arg map', () => {
    expect(raw('Map<String, User>')).toBe('User');
  });

  it('passes through a plain simple type', () => {
    expect(raw('User')).toBe('User');
  });

  it('falls back to the raw class name for an unrecognized nested generic', () => {
    // Nested generic args defeat the single/two-arg element extraction; the
    // erasure fallback keeps the outer class name (pre-existing behavior).
    expect(raw('List<Map<String, User>>')).toBe('List');
  });

  it('keeps the outer class for a QUALIFIED nested generic element (guards the strip order)', () => {
    // Unlike `List<Map<String, User>>` (no dot inside the args, so it yields
    // `List` under both strip orders), this input has a qualified nested
    // element: the OLD order (stripQualifier first) cut inside the generic and
    // produced a corrupted `Foo<String>>`; only generics-first yields `List`.
    // This is the case that actually fails if the F41 reorder regresses.
    expect(raw('List<com.x.Foo<String>>')).toBe('List');
  });

  it('returns null for a bare `var` with no concrete type', () => {
    expect(interpretJavaTypeBinding(binding('var'))).toBeNull();
  });
});
