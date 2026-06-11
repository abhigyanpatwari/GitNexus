/**
 * Regression tests for Kotlin parsing-layer coverage gaps (issue #1919).
 *
 * Mirrors dart-coverage.test.ts / python-parsing-coverage.test.ts: the scope-layer
 * assertions exercise emitKotlinScopeCaptures directly; F49 also exercises the
 * legacy KOTLIN_QUERIES structure-query bank (the live spurious-edge source).
 *
 * F47 — callable references (`::method`, `Type::new`, `obj::method`) were never
 * captured: KOTLIN_SCOPE_QUERY had no callable_reference rule, so they never
 * participated in call-graph resolution.
 *
 * F49 — the legacy KOTLIN_QUERIES infix rule captured ALL three simple_identifier
 * children of an infix_expression (`a to b` → `a`, `to`, `b`) as @call.name,
 * emitting spurious call references for the operands. The fix anchors the
 * capture to the operator (the middle child) only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { emitKotlinScopeCaptures } from '../../../src/core/ingestion/languages/kotlin/captures.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
const Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
import { KOTLIN_QUERIES } from '../../../src/core/ingestion/tree-sitter-queries.js';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// F47 — callable references (scope layer)
// ---------------------------------------------------------------------------

const CALLABLE_REFS = `fun useCallableRefs() {
    val a = ::topLevelFn
    val b = String::length
    val c = obj::method
    val d = Type::new
}`;

/** All call references emitted for the source, as { name, receiver, form }. */
function callReferences(
  src: string,
): Array<{ name: string; receiver?: string; form: 'free' | 'member' }> {
  const matches = emitKotlinScopeCaptures(src, 'test.kt') as CaptureMatch[];
  const out: Array<{ name: string; receiver?: string; form: 'free' | 'member' }> = [];
  for (const m of matches) {
    if (m['@reference.call.free'] !== undefined && m['@reference.name'] !== undefined) {
      out.push({ name: m['@reference.name'].text, form: 'free' });
    } else if (m['@reference.call.member'] !== undefined && m['@reference.name'] !== undefined) {
      out.push({
        name: m['@reference.name'].text,
        receiver: m['@reference.receiver']?.text,
        form: 'member',
      });
    }
  }
  return out;
}

describe('F47 — Kotlin callable references (scope layer)', () => {
  it('captures a bare `::topLevelFn` reference as a free call', () => {
    const refs = callReferences(CALLABLE_REFS);
    const free = refs.find((r) => r.name === 'topLevelFn');
    expect(free).toBeDefined();
    expect(free!.form).toBe('free');
  });

  it('captures `String::length` as a member call with receiver String', () => {
    const refs = callReferences(CALLABLE_REFS);
    const ref = refs.find((r) => r.name === 'length');
    expect(ref).toBeDefined();
    expect(ref!.form).toBe('member');
    expect(ref!.receiver).toBe('String');
  });

  it('captures `obj::method` as a member call with receiver obj', () => {
    const refs = callReferences(CALLABLE_REFS);
    const ref = refs.find((r) => r.name === 'method');
    expect(ref).toBeDefined();
    expect(ref!.form).toBe('member');
    expect(ref!.receiver).toBe('obj');
  });

  it('captures `Type::new` (constructor reference) as a member call with receiver Type', () => {
    const refs = callReferences(CALLABLE_REFS);
    const ref = refs.find((r) => r.name === 'new');
    expect(ref).toBeDefined();
    expect(ref!.form).toBe('member');
    expect(ref!.receiver).toBe('Type');
  });

  it('emits exactly one call reference per callable_reference (no double-match)', () => {
    const refs = callReferences(CALLABLE_REFS).filter((r) =>
      ['topLevelFn', 'length', 'method', 'new'].includes(r.name),
    );
    expect(refs.map((r) => r.name).sort()).toEqual(['length', 'method', 'new', 'topLevelFn']);
  });

  it('does not capture the receiver type as its own free call', () => {
    const refs = callReferences(CALLABLE_REFS);
    // String / Type / obj are receivers, never standalone call targets.
    expect(refs.some((r) => r.form === 'free' && r.name === 'String')).toBe(false);
    expect(refs.some((r) => r.form === 'free' && r.name === 'Type')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F47 — callable references resolve to CALLS edges end-to-end (worker path)
// ---------------------------------------------------------------------------

describe('F47 — Kotlin callable references (end-to-end)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'kotlin-coverage'), () => {});
  }, 60000);

  it('resolves a bare `::topLevelFn` reference to a CALLS edge on the local function', () => {
    const calls = getRelationships(result, 'CALLS');
    const ref = calls.find((c) => c.source === 'useCallableRefs' && c.target === 'topLevelFn');
    expect(ref).toBeDefined();
  });

  it('resolves an `obj::method` member reference to a CALLS edge on Obj.method', () => {
    const calls = getRelationships(result, 'CALLS');
    const ref = calls.find((c) => c.source === 'useCallableRefs' && c.target === 'method');
    expect(ref).toBeDefined();
  });

  it('runs through the worker pool (parity: capture edits survive the worker boundary)', () => {
    expect(result.usedWorkerPool).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F49 — infix-call query captures only the operator (legacy structure bank)
// ---------------------------------------------------------------------------
//
// Characterized end-to-end (issue #1919): the live spurious @call.name edges
// for `a to b` originate from the legacy KOTLIN_QUERIES bank (still wired as
// provider.treeSitterQueries / used by the worker structure phase). The
// registry KOTLIN_SCOPE_QUERY has no infix rule, so the fix is in
// tree-sitter-queries.ts only. These tests compile that live query and assert
// the call captures directly.

/** @call.name capture texts produced by the live KOTLIN_QUERIES structure bank. */
function structureCallNames(src: string): string[] {
  const parser = new Parser();
  parser.setLanguage(Kotlin as Parameters<Parser['setLanguage']>[0]);
  const query = new Parser.Query(Kotlin as Parameters<Parser['setLanguage']>[0], KOTLIN_QUERIES);
  const tree = parser.parse(src);
  const names: string[] = [];
  for (const match of query.matches(tree.rootNode)) {
    for (const c of match.captures) {
      if (c.name === 'call.name') names.push(c.node.text);
    }
  }
  return names;
}

describe('F49 — Kotlin infix call captures only the operator', () => {
  it('`val p = a to b` captures exactly one call (`to`), zero for the operands', () => {
    const names = structureCallNames(`fun f() {\n    val p = a to b\n}`);
    expect(names).toEqual(['to']);
  });

  it('`a to b to c` captures only the `to` operators, never the operands', () => {
    const names = structureCallNames(`fun f() {\n    val q = a to b to c\n}`);
    expect(names.sort()).toEqual(['to', 'to']);
    expect(names.includes('a')).toBe(false);
    expect(names.includes('b')).toBe(false);
    expect(names.includes('c')).toBe(false);
  });

  it('a normal call `foo(a, b)` still produces exactly one call to `foo`', () => {
    const names = structureCallNames(`fun f() {\n    foo(a, b)\n}`);
    expect(names).toEqual(['foo']);
  });
});
