import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';

/** Return the `@reference.arity` of the call named `callName`, or undefined. */
function arityOf(source: string, callName: string): string | undefined {
  const matches = emitJavaScopeCaptures(source, 'Fixture.java').map((m) =>
    Object.fromEntries(Object.entries(m).map(([tag, cap]) => [tag, cap.text])),
  );
  const call = matches.find(
    (m) => m['@reference.name'] === callName && m['@reference.arity'] !== undefined,
  );
  return call?.['@reference.arity'];
}

// Java argument-list nodes interleave `block_comment` / `line_comment` with the
// real arguments; arity (which feeds call-processor symbol-ID generation) must
// exclude them. The removed `comment` literal never matched — the grammar emits
// `block_comment` / `line_comment`. (#1920 / PR #1937 tri-review)
describe('Java call arity excludes interleaved comments', () => {
  it('ignores a block comment between arguments', () => {
    assert.equal(arityOf('class A { void m(){ foo(a, /* x */ b, c); } }', 'foo'), '3');
  });

  it('ignores a line comment between arguments', () => {
    assert.equal(arityOf('class A { void m(){ foo(a, // hi\n b); } }', 'foo'), '2');
  });

  it('ignores a leading block comment on the first argument', () => {
    assert.equal(arityOf('class A { void m(){ foo(/* lead */ a); } }', 'foo'), '1');
  });

  it('excludes comments in a constructor (object_creation_expression) call', () => {
    assert.equal(arityOf('class A { void m(){ new Bar(a, /*c*/ b); } }', 'Bar'), '2');
  });

  it('regression: a comment-free call counts normally', () => {
    assert.equal(arityOf('class A { void m(){ foo(a, b, c); } }', 'foo'), '3');
  });
});
