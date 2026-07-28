/**
 * #2701 / #2699 follow-up — the TS/JS function node-type lists must agree with
 * the queries that produce them.
 *
 * Four lists describe "which node types are function-like", maintained by hand
 * in four files:
 *
 *   1. `query.ts`      — the `@scope.function` / `@receiver-owner.this`
 *                        patterns (what becomes a scope, and which scopes bind
 *                        their own `this`)
 *   2. `captures.ts`   — `FUNCTION_NODE_TYPES`, which feeds `functionNodeTypes`
 *                        into callable-flow capture synthesis AND the
 *                        body-block filter
 *   3. `receiver-binding.ts` — `THIS_REBINDING_BOUNDARY_TYPES`, where the
 *                        enclosing-type walk stops
 *   4. `type-extractors/typescript.ts` — `THIS_BOUNDARY_NODE_TYPES`, where the
 *                        type-env AST walk stops. Its own docstring already
 *                        claims it is "kept in sync with `@receiver-owner.this`
 *                        in query.ts" — this test is what makes that true.
 *
 * Drift between them is silent — it produces wrong edges, not errors. Real
 * instance: `generator_function` (the EXPRESSION form, `const g = function* ()
 * {}`) was added to both queries for #2701 and is present in both `this`-
 * boundary lists, but was missing from both `FUNCTION_NODE_TYPES`.
 *
 * That particular gap was measured to change no graph output today — the
 * `this` boundary was already correct via the query marker, and a
 * generator-expression binding emits a `Const` node, so its call does not
 * resolve either way. So this test is not backfilling a live bug; it is
 * removing the class of bug, which the four-way hand-sync otherwise makes a
 * matter of vigilance. It fails on that drift, which is the point.
 *
 * Lists 1 and 2 are asserted EQUAL. Lists 3 and 4 are asserted as subsets with
 * an explicit allowlist, because they encode a different question: a
 * `method_definition` binds its own `this` (so it is marked in the query) but
 * the class IS its `this`-owner (so neither walk may stop there).
 */
import { describe, expect, it } from 'vitest';
import { TYPESCRIPT_SCOPE_QUERY } from '../../src/core/ingestion/languages/typescript/query.js';
import { JAVASCRIPT_SCOPE_QUERY } from '../../src/core/ingestion/languages/javascript/query.js';
import { FUNCTION_NODE_TYPES as TS_FUNCTION_NODE_TYPES } from '../../src/core/ingestion/languages/typescript/captures.js';
import { FUNCTION_NODE_TYPES as JS_FUNCTION_NODE_TYPES } from '../../src/core/ingestion/languages/javascript/captures.js';
import { THIS_REBINDING_BOUNDARY_TYPES } from '../../src/core/ingestion/languages/typescript/receiver-binding.js';
import { THIS_BOUNDARY_NODE_TYPES } from '../../src/core/ingestion/type-extractors/typescript.js';

/**
 * Node types of every single-line `(node_type) @capture …` pattern in a query
 * that carries `capture`.
 *
 * Only single-line patterns are matched. A multi-line `@scope.function` pattern
 * would be missed — but it would then be missing from the extracted set while
 * still present in `FUNCTION_NODE_TYPES`, so the equality assertions below fail
 * loudly rather than silently under-checking. Comment lines start with `;;` and
 * cannot match the leading `(`.
 */
const nodeTypesCapturedAs = (query: string, capture: string): Set<string> => {
  const found = new Set<string>();
  const pattern = /^\((\w+)\)((?:[ \t]+@[\w.-]+)+)[ \t]*$/gm;
  for (const match of query.matchAll(pattern)) {
    const captures = match[2]!.trim().split(/\s+/);
    if (captures.includes(capture)) found.add(match[1]!);
  }
  return found;
};

const sorted = (types: Iterable<string>): string[] => [...types].sort();

describe('the @scope.function patterns and FUNCTION_NODE_TYPES agree', () => {
  it('TypeScript', () => {
    const fromQuery = nodeTypesCapturedAs(TYPESCRIPT_SCOPE_QUERY, '@scope.function');

    expect(fromQuery.size).toBeGreaterThan(0);
    expect(sorted(fromQuery)).toEqual(sorted(TS_FUNCTION_NODE_TYPES));
  });

  it('JavaScript', () => {
    const fromQuery = nodeTypesCapturedAs(JAVASCRIPT_SCOPE_QUERY, '@scope.function');

    expect(fromQuery.size).toBeGreaterThan(0);
    expect(sorted(fromQuery)).toEqual(sorted(JS_FUNCTION_NODE_TYPES));
  });
});

describe('the @receiver-owner.this markers and THIS_REBINDING_BOUNDARY_TYPES agree', () => {
  // `object` is a boundary but never a function scope: an object literal
  // rebinds `this` to itself, and it is captured as `@scope.object`.
  const NOT_A_FUNCTION_SCOPE = new Set(['object']);

  // Marked in the query (they bind their own `this`) but deliberately NOT walk
  // boundaries: for a method the enclosing class IS the `this`-owner, so
  // stopping there would delete every correct `this.x` resolution. The
  // signature forms carry no body at all.
  const OWNS_THIS_BUT_CLASS_IS_THE_OWNER = [
    'abstract_method_signature',
    'function_signature',
    'method_definition',
    'method_signature',
  ];

  it('TypeScript: every walk boundary is a query-marked this-owner', () => {
    const marked = nodeTypesCapturedAs(TYPESCRIPT_SCOPE_QUERY, '@receiver-owner.this');
    const boundaries = [...THIS_REBINDING_BOUNDARY_TYPES].filter(
      (type) => !NOT_A_FUNCTION_SCOPE.has(type),
    );

    expect(marked.size).toBeGreaterThan(0);
    expect(boundaries.filter((type) => !marked.has(type))).toEqual([]);
  });

  it('TypeScript: the markers that are NOT boundaries are exactly the method forms', () => {
    const marked = nodeTypesCapturedAs(TYPESCRIPT_SCOPE_QUERY, '@receiver-owner.this');

    expect(sorted([...marked].filter((type) => !THIS_REBINDING_BOUNDARY_TYPES.has(type)))).toEqual(
      OWNS_THIS_BUT_CLASS_IS_THE_OWNER,
    );
  });

  it('JavaScript: every walk boundary is a query-marked this-owner', () => {
    // `receiver-binding.ts` is shared — `javascript/captures.ts` imports
    // `synthesizeTsReceiverBinding` — so the same boundary set governs JS.
    const marked = nodeTypesCapturedAs(JAVASCRIPT_SCOPE_QUERY, '@receiver-owner.this');
    const boundaries = [...THIS_REBINDING_BOUNDARY_TYPES].filter(
      (type) => !NOT_A_FUNCTION_SCOPE.has(type),
    );

    expect(marked.size).toBeGreaterThan(0);
    expect(boundaries.filter((type) => !marked.has(type))).toEqual([]);
  });

  it('the type-env walk boundary matches the enclosing-type walk boundary', () => {
    // Two walks, two lists, one rule. They differ only by `object`: the
    // enclosing-type walk must stop at an object literal (`this` is the
    // literal), while the type-env walk never reaches one — it is not a
    // function scope.
    const marked = nodeTypesCapturedAs(TYPESCRIPT_SCOPE_QUERY, '@receiver-owner.this');

    expect(sorted(THIS_BOUNDARY_NODE_TYPES)).toEqual(
      sorted([...THIS_REBINDING_BOUNDARY_TYPES].filter((type) => !NOT_A_FUNCTION_SCOPE.has(type))),
    );
    expect([...THIS_BOUNDARY_NODE_TYPES].filter((type) => !marked.has(type))).toEqual([]);
  });

  it('an arrow is marked in neither — it inherits `this` lexically', () => {
    const tsMarked = nodeTypesCapturedAs(TYPESCRIPT_SCOPE_QUERY, '@receiver-owner.this');
    const jsMarked = nodeTypesCapturedAs(JAVASCRIPT_SCOPE_QUERY, '@receiver-owner.this');

    expect(tsMarked.has('arrow_function')).toBe(false);
    expect(jsMarked.has('arrow_function')).toBe(false);
    expect(THIS_REBINDING_BOUNDARY_TYPES.has('arrow_function')).toBe(false);
  });
});
