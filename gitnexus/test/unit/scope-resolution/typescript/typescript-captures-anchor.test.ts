/**
 * U8 (B5 from PR #1693 review) — TS capture ancestor-walk regression coverage.
 *
 * PR #1693 rewrote `emitTsScopeCaptures` to walk from each captured node's
 * own subtree (`findSelfOrAncestorOfType[s]` + `pickFirstNode`) instead of
 * re-scanning the whole AST from the root via `findNodeAtRange`. Lane 4 of
 * the production-readiness review proved the new path is semantically
 * equivalent to the prior range-based lookup for every anchor the TS
 * query emits — but the existing `typescript-captures.test.ts` doesn't
 * pin the specific sharp edges that an over-aggressive ancestor walk
 * would break. This file does.
 *
 * Each test exercises a capture class whose anchor type is one the
 * rewrite explicitly handles: `call_expression`, `new_expression`,
 * `import_statement` / `export_statement`, `call_expression` with
 * `import` (dynamic), and the JSX-anchored `@reference.call.*` form
 * that must NOT synthesize an outer call. Assertions are exact `.toBe(N)`
 * per DoD §2.7.
 */
import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';

function countMatches(src: string, predicate: (tags: string[]) => boolean): number {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches.filter((m) => predicate(Object.keys(m))).length;
}

function countMatchesTsx(src: string, predicate: (tags: string[]) => boolean): number {
  // TSX-specific query path: file extension drives query selection inside
  // emitTsScopeCaptures. Without `.tsx` the JSX call-anchored variants
  // never fire, so this test would silently pass on the TypeScript-only
  // path instead of exercising the JSX-anchor case the rewrite cares about.
  const matches = emitTsScopeCaptures(src, 'test.tsx');
  return matches.filter((m) => predicate(Object.keys(m))).length;
}

describe('captures.ts ancestor-walk rewrite (U8 / B5)', () => {
  it('member call `obj.foo()` emits exactly one @reference.call.member capture', () => {
    // call_expression anchor → self in ancestor walk. Baseline case the
    // rewrite must preserve: a direct member call captures once via
    // @reference.call.member, not zero (would mean ancestor walk lost
    // the anchor) and not two (would mean the walk over-emitted).
    const count = countMatches('function run(obj: { foo(): void }): void { obj.foo(); }', (t) =>
      t.includes('@reference.call.member'),
    );
    expect(count).toBe(1);
  });

  it('dynamic import gets decomposed to @import.statement with kind=dynamic', () => {
    // import(...) is captured by the raw query as @import.dynamic
    // (call_expression with `import` function). captures.ts then
    // decomposes it via splitImportStatement, which re-emits a normalized
    // @import.statement match with @import.kind set to "dynamic" — so the
    // central extractor sees ONE uniform import shape regardless of
    // static-vs-dynamic. The raw @import.dynamic tag does NOT survive
    // into the output stream after decomposition.
    const matches = emitTsScopeCaptures(
      'async function load() { const mod = await import("./helper"); return mod; }',
      'test.ts',
    );
    const dyn = matches.filter(
      (m) => '@import.statement' in m && m['@import.kind']?.text === 'dynamic',
    );
    expect(dyn.length).toBe(1);
    // The decomposed source-string capture carries the literal with
    // surrounding quotes stripped (the decomposer normalizes before
    // emitting the synthetic @import.source marker — downstream
    // consumers receive the bare module specifier).
    expect(dyn[0]['@import.source']?.text).toBe('./helper');
  });

  it('JSX <Foo /> emits a call.free capture (TSX-only query path) but no arity synthesis', () => {
    // Both jsx_self_closing_element and jsx_opening_element with an
    // identifier name pattern in the TSX query emit @reference.call.free
    // (see query.ts lines 899-905). Lane 4 of the production-readiness
    // review documented the design: the capture surfaces so downstream
    // consumers know the JSX component is referenced, but arity
    // synthesis (findSelfOrAncestorOfType('call_expression')) returns
    // null because the anchor is a jsx_*_element, NOT a call_expression
    // — so no @declaration.parameter-count is attached. Pre-rewrite, the
    // range-based lookup also returned null. This pins both: the capture
    // exists AND arity is not synthesized.
    const matches = emitTsScopeCaptures('function App() { return <Foo />; }', 'test.tsx');
    const jsxCalls = matches.filter((m) => '@reference.call.free' in m);
    expect(jsxCalls.length).toBe(1);
    // No spurious arity synthesis on the JSX-anchored capture. If a
    // future refactor "helpfully" walks JSX → call_expression, this
    // assertion fails and the implementer revisits the design.
    expect('@declaration.parameter-count' in jsxCalls[0]).toBe(false);
  });

  it('constructor call `new Foo(1, 2)` emits exactly one @reference.call.constructor capture', () => {
    // new_expression anchor → self in ancestor walk.
    const count = countMatches(
      'class Foo { constructor(_a: number, _b: number) {} }\nconst x = new Foo(1, 2);',
      (t) => t.includes('@reference.call.constructor'),
    );
    expect(count).toBe(1);
  });

  it('named import `import { foo } from "./a"` emits exactly one @import.statement', () => {
    const count = countMatches('import { foo } from "./a";\nconst x = foo();', (t) =>
      t.includes('@import.statement'),
    );
    expect(count).toBe(1);
  });

  it('namespace import `import * as ns from "./a"` emits exactly one @import.statement', () => {
    const count = countMatches('import * as ns from "./a";\nconst x = ns.foo();', (t) =>
      t.includes('@import.statement'),
    );
    expect(count).toBe(1);
  });

  it('re-export `export { foo } from "./a"` emits exactly one @import.statement', () => {
    // export_statement with a source string IS captured as @import.statement
    // (re-exports are pseudo-imports for graph purposes). Ancestor-walk
    // targets `['import_statement', 'export_statement']` so the
    // export_statement anchor matches itself.
    const count = countMatches('export { foo } from "./a";', (t) =>
      t.includes('@import.statement'),
    );
    expect(count).toBe(1);
  });

  it('class method override produces a method capture per class (no collapse, no over-capture)', () => {
    // Two run() methods, one per class, both must capture distinctly.
    // Pins that the FUNCTION_DECL_TAGS / @declaration.method ancestor-walk
    // doesn't accidentally merge override sites onto the parent class.
    const count = countMatches(
      'class Base { run(): number { return 1; } }\nclass Child extends Base { run(): number { return 2; } }',
      (t) => t.includes('@declaration.method'),
    );
    expect(count).toBe(2);
  });

  it('member read `obj.foo` (no call) emits exactly one @reference.read.member capture', () => {
    // member_expression anchor → self in ancestor walk. Read-only access
    // (not followed by call parens) is the relevant case — a member that
    // IS called is captured under @reference.call.member instead.
    const count = countMatches(
      'function run(obj: { foo: number }): number { return obj.foo; }',
      (t) => t.includes('@reference.read.member'),
    );
    expect(count).toBe(1);
  });
});
