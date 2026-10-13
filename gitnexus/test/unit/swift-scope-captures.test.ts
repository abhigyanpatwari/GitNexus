import { describe, expect, it } from 'vitest';
import { emitSwiftScopeCaptures } from '../../src/core/ingestion/languages/swift/captures.js';

describe('Swift additive call captures', () => {
  it('captures each free call and its own arity in an additive expression', () => {
    const captures = emitSwiftScopeCaptures(
      'func run() -> String { return first() + second(value: 7) }',
      'calls.swift',
    );
    expect(
      captures
        .filter((capture) => capture['@reference.call.free'])
        .map((capture) => [capture['@reference.name'].text, capture['@reference.arity'].text])
        .sort(),
    ).toEqual([
      ['first', '0'],
      ['second', '1'],
    ]);
    const calls = captures.filter((capture) => capture['@reference.call.free']);
    expect(calls.map((capture) => capture['@reference.call.free'].text)).toEqual([
      'first()',
      'second(value: 7)',
    ]);
    for (const capture of calls) {
      expect(capture['@reference.call.free'].range.startCol).toBe(
        capture['@reference.name'].range.startCol,
      );
    }
  });

  it('does not reinterpret a parenthesized callable expression as a RHS call', () => {
    const captures = emitSwiftScopeCaptures(
      'func run() -> String { return (first() + second)(value: 7) }',
      'calls.swift',
    );
    expect(
      captures
        .filter((capture) => capture['@reference.call.free'])
        .map((capture) => capture['@reference.name'].text),
    ).toEqual(['first']);
  });
});
