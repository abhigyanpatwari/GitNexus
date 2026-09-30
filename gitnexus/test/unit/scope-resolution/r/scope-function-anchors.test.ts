/**
 * R caller-attribution fix: the R scope query must anchor
 * `@scope.function` on the SAME AST node as `@declaration.function` (the whole
 * `name <- function(...)` assignment) and `@declaration.method` (the
 * `name = function(...)` argument), so a def is owned by its OWN Function scope.
 * Before the fix the two anchors differ, the def is owned by the enclosing
 * Module / outer-function / Class scope, and `resolveCallerGraphId` credits every
 * call in a body to the FIRST callable that scope owns.
 *
 * These tests landed before the fix (as `it.fails`) and pass as ordinary tests
 * with it. Every `it` holds ONE assertion that compares a value, and the
 * lookups never dereference a possibly-missing scope/def, so a failure is
 * always a wrong VALUE, never a thrown TypeError.
 *
 * Positions: lines are 1-based, columns 0-based (the scope `Range` convention).
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, Range, Scope, SymbolDefinition } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';

const FILE = 'R/x.R';

/** Parse + run R's `populateOwners` (the generic `populateClassOwnedMembers`). */
function parse(src: string): ParsedFile | undefined {
  const parsed = extractParsedFile(rProvider, src, FILE);
  if (parsed !== undefined) populateClassOwnedMembers(parsed);
  return parsed;
}

const scopesOf = (src: string): readonly Scope[] => parse(src)?.scopes ?? [];

const fmt = (r: Range): string => `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;

/**
 * The range string of the single occurrence of `snippet` in `src`. Throws at
 * describe time (never inside a test body) when the snippet is missing or
 * ambiguous, so a typo cannot masquerade as an expected failure.
 */
function spanOf(src: string, snippet: string): string {
  const start = src.indexOf(snippet);
  if (start < 0 || src.indexOf(snippet, start + 1) >= 0) {
    throw new Error(`snippet must occur exactly once: ${snippet}`);
  }
  const at = (offset: number): string => {
    const before = src.slice(0, offset);
    const line = before.split('\n').length;
    const col = offset - (before.lastIndexOf('\n') + 1);
    return `${line}:${col}`;
  };
  return `${at(start)}-${at(start + snippet.length)}`;
}

const allDefs = (scopes: readonly Scope[]): SymbolDefinition[] =>
  scopes.flatMap((s) => [...s.ownedDefs]);

const findDef = (
  scopes: readonly Scope[],
  type: string,
  name: string,
): SymbolDefinition | undefined =>
  allDefs(scopes).find((d) => d.nodeId.endsWith(`:${type}:${name}`));

const scopeByRange = (
  scopes: readonly Scope[],
  kind: Scope['kind'],
  range: string,
): Scope | undefined => scopes.find((s) => s.kind === kind && fmt(s.range) === range);

const moduleOf = (scopes: readonly Scope[]): Scope | undefined =>
  scopes.find((s) => s.kind === 'Module');

/** Who owns the def, and where that scope sits. Always an object, so a wrong owner is a value diff. */
function ownerInfo(
  scopes: readonly Scope[],
  type: string,
  name: string,
): { kind: string; parentKind: string | undefined; range: string } | undefined {
  const owner = scopes.find((s) => s.ownedDefs.some((d) => d.nodeId.endsWith(`:${type}:${name}`)));
  if (owner === undefined) return undefined;
  return {
    kind: owner.kind,
    parentKind: scopes.find((s) => s.id === owner.parent)?.kind,
    range: fmt(owner.range),
  };
}

/** Ranges of every ancestor scope, nearest first. */
function ancestorRanges(scopes: readonly Scope[], scope: Scope | undefined): string[] {
  const out: string[] = [];
  let cur = scope === undefined ? undefined : scopes.find((s) => s.id === scope.parent);
  while (cur !== undefined) {
    out.push(fmt(cur.range));
    const parentId = cur.parent;
    cur = scopes.find((s) => s.id === parentId);
  }
  return out;
}

const defNames = (defs: readonly SymbolDefinition[]): string[] =>
  defs.map((d) => d.nodeId.split(':').slice(-1)[0]);

// ─── Sources ────────────────────────────────────────────────────────────────

const FORMS_SRC = [
  'f <- function(x) g(x)',
  'g = function(x) g2(x)',
  'h <<- function(x) g3(x)',
  'k <- \\(x) g4(x)',
  'dotted.name <- function(x) g5(x)',
  '`weird name` <- function(x) g6(x)',
  '',
].join('\n');

const FORMS = [
  { label: '<-', name: 'f', line: 'f <- function(x) g(x)', row: 1 },
  { label: '=', name: 'g', line: 'g = function(x) g2(x)', row: 2 },
  { label: '<<-', name: 'h', line: 'h <<- function(x) g3(x)', row: 3 },
  { label: '\\(x) lambda', name: 'k', line: 'k <- \\(x) g4(x)', row: 4 },
  { label: 'dotted name', name: 'dotted.name', line: 'dotted.name <- function(x) g5(x)', row: 5 },
  {
    label: 'backtick name',
    name: '`weird name`',
    line: '`weird name` <- function(x) g6(x)',
    row: 6,
  },
] as const;

const NESTED_SRC = [
  'outer <- function(x) {',
  '  inner <- function(y) g(y)',
  '  inner(x)',
  '  lapply(x, function(z) h(z))',
  '  sapply(x, FUN = function(z) h2(z))',
  '  tryCatch(e(), error = function(e) h3(e))',
  '}',
  '',
].join('\n');
const OUTER_FN = spanOf(NESTED_SRC, NESTED_SRC.slice(NESTED_SRC.indexOf('function(x) {'), -1));
const INNER_ASSIGN = spanOf(NESTED_SRC, 'inner <- function(y) g(y)');

const R6_SRC = [
  'Acct <- R6::R6Class("Acct",',
  '  public = list(',
  '    cache = build_cache(),',
  '    deposit = function(x) 1,',
  '    run = function() {',
  '      helper <- function() 1',
  '      helper()',
  '    }',
  '  ),',
  '  private = list(',
  '    audit = function() 2',
  '  ),',
  '  active = list(',
  '    balance = function() 3',
  '  )',
  ')',
  '',
].join('\n');

const BARE_R6_SRC = 'Bare <- R6Class("Bare", public = list(get_value = function() 1))\n';
const R5_SRC =
  'Rc <- setRefClass("Rc", methods = list(process = function() 1, other = function() 2))\n';
const FIELD_SRC = 'A <- R6Class("A", public = list(cache = build_cache(), m = function() 1))\n';
const SOLO_SRC = 'solo <- function(x) g(x)';
const MEMBER_SRC = 'obj$f <- function(x) g(x)\nx[["k"]] <- function(y) g(y)\n';

describe('R scope function anchors', () => {
  // ─── Sanity (plain, HEAD-passing) ─────────────────────────────────────────
  it('parses every source in this file', () => {
    const parsed = [
      FORMS_SRC,
      NESTED_SRC,
      R6_SRC,
      BARE_R6_SRC,
      R5_SRC,
      FIELD_SRC,
      SOLO_SRC,
      MEMBER_SRC,
    ].map((src) => parse(src) !== undefined);
    expect(parsed).toEqual([true, true, true, true, true, true, true, true]);
  });

  // ─── Scenario 1 / U1, U2: named forms ─────────────────────────────────────
  describe('named assignment forms (scenario 1)', () => {
    const scopes = scopesOf(FORMS_SRC);

    // U1 (HEAD-failing): the def is owned by a Function scope whose range is
    // the assignment (the def's anchor) and whose parent is the Module.
    for (const form of FORMS) {
      it(`U1 ${form.label}: the def is owned by its own assignment-anchored Function scope`, () => {
        expect(ownerInfo(scopes, 'Function', form.name)).toEqual({
          kind: 'Function',
          parentKind: 'Module',
          range: spanOf(FORMS_SRC, form.line),
        });
      });
    }

    // U2 (HEAD-failing): the Module scope no longer owns any callable.
    it('U2 the Module scope owns no callable def', () => {
      const callables = (moduleOf(scopes)?.ownedDefs ?? []).filter((d) => d.type === 'Function');
      expect(defNames(callables)).toEqual([]);
    });

    // HEAD-passing: the binding of each name is visible from the Module.
    for (const form of FORMS) {
      it(`binds ${form.label} name in the Module scope with origin local`, () => {
        const refs = moduleOf(scopes)?.bindings.get(form.name) ?? [];
        expect(refs.map((r) => r.origin)).toEqual(['local']);
      });
    }

    // HEAD-passing (P1e): scope ids stay unique per file.
    it('keeps scope ids unique', () => {
      expect(new Set(scopes.map((s) => s.id)).size).toBe(scopes.length);
    });

    // HEAD-passing (scenario 7 / P1d): the def id still encodes the assignment start.
    it('keeps the def node ids anchored at the assignment start', () => {
      const expected = FORMS.map((f) => `def:${FILE}#${f.row}:0:Function:${f.name}`).sort();
      expect(
        allDefs(scopes)
          .map((d) => d.nodeId)
          .sort(),
      ).toEqual(expected);
    });
  });

  // ─── Scenario 2 / U3: nested functions ────────────────────────────────────
  describe('nested functions (scenario 2, scenario 3)', () => {
    const scopes = scopesOf(NESTED_SRC);

    // U3 (HEAD-failing)
    it("U3 the inner def is owned by inner's own assignment-anchored Function scope", () => {
      expect(ownerInfo(scopes, 'Function', 'inner')).toEqual({
        kind: 'Function',
        parentKind: 'Function',
        range: INNER_ASSIGN,
      });
    });

    it("U3 outer's function_definition scope owns nothing", () => {
      expect(
        defNames(
          scopeByRange(scopes, 'Function', OUTER_FN)?.ownedDefs ?? [
            { nodeId: 'missing-scope' } as SymbolDefinition,
          ],
        ),
      ).toEqual([]);
    });

    // HEAD-passing: the inner binding lives in outer's function_definition scope.
    it("binds the inner name in outer's function_definition scope", () => {
      const refs = scopeByRange(scopes, 'Function', OUTER_FN)?.bindings.get('inner') ?? [];
      expect(refs.map((r) => r.origin)).toEqual(['local']);
    });

    // HEAD-passing (scenario 3): anonymous / named-argument lambdas own nothing
    // and hang (transitively) under outer's function_definition scope.
    for (const snippet of ['function(z) h(z)', 'function(z) h2(z)', 'function(e) h3(e)']) {
      const anonymous = scopeByRange(scopes, 'Function', spanOf(NESTED_SRC, snippet));
      it(`anonymous "${snippet}" owns no def`, () => {
        expect(
          defNames(anonymous?.ownedDefs ?? [{ nodeId: 'missing-scope' } as SymbolDefinition]),
        ).toEqual([]);
      });
      it(`anonymous "${snippet}" sits under outer's function_definition scope`, () => {
        expect(ancestorRanges(scopes, anonymous).includes(OUTER_FN)).toBe(true);
      });
    }
  });

  // ─── Scenario 4 / U4: R6 and R5 methods, P2 ───────────────────────────────
  describe('R6 / R5 methods (scenario 4)', () => {
    const r6 = scopesOf(R6_SRC);
    const bare = scopesOf(BARE_R6_SRC);
    const r5 = scopesOf(R5_SRC);
    const classOwns = (scopes: readonly Scope[]): string[] =>
      (scopes.find((s) => s.kind === 'Class')?.ownedDefs ?? []).map((d) => d.type);

    // U4 (HEAD-failing): one test each.
    const cases = [
      {
        label: 'R6 public',
        scopes: r6,
        src: R6_SRC,
        name: 'deposit',
        snippet: 'deposit = function(x) 1',
      },
      {
        label: 'R6 private',
        scopes: r6,
        src: R6_SRC,
        name: 'audit',
        snippet: 'audit = function() 2',
      },
      {
        label: 'R6 active',
        scopes: r6,
        src: R6_SRC,
        name: 'balance',
        snippet: 'balance = function() 3',
      },
      {
        label: 'bare R6Class',
        scopes: bare,
        src: BARE_R6_SRC,
        name: 'get_value',
        snippet: 'get_value = function() 1',
      },
      {
        label: 'R5 methods',
        scopes: r5,
        src: R5_SRC,
        name: 'process',
        snippet: 'process = function() 1',
      },
    ];
    for (const c of cases) {
      it(`U4 ${c.label}: the method is owned by a Function scope under the Class, which owns only the class def`, () => {
        expect({
          owner: ownerInfo(c.scopes, 'Method', c.name),
          classOwns: classOwns(c.scopes),
        }).toEqual({
          owner: { kind: 'Function', parentKind: 'Class', range: spanOf(c.src, c.snippet) },
          classOwns: ['Class'],
        });
      });
    }

    // HEAD-passing (P2): ownerId + qualifiedName after populateClassOwnedMembers.
    // HEAD reaches this through branch 2 (defs owned by the Class scope); after
    // the fix through branch 1 (Function scope under Class): the invariant must
    // survive the mechanism swap.
    it('stamps a method ownerId with the class def id', () => {
      const classDef = findDef(r6, 'Class', 'Acct');
      expect(findDef(r6, 'Method', 'deposit')?.ownerId).toBe(classDef?.nodeId);
    });
    it('qualifies a method as Class.method', () => {
      expect(findDef(r6, 'Method', 'deposit')?.qualifiedName).toBe('Acct.deposit');
    });
    it('gives the class def a resolvable id (guards the two P2 assertions above)', () => {
      expect(findDef(r6, 'Class', 'Acct')?.nodeId).toBe(`def:${FILE}#1:0:Class:Acct`);
    });

    // ─── Scenario 8 / U6: nested named helper inside an R6 method ────────────
    // HEAD stamps ownerId = class and qualifiedName `Acct.helper` on it (branch 1
    // matches its method's Function scope, whose parent is the Class). After the
    // fix its scope parent is a Function scope and nothing is stamped
    // (walkers.ts depth invariant); the residual is accepted in the plan.
    it('U6 a nested helper in an R6 method gets no ownerId', () => {
      expect(findDef(r6, 'Function', 'helper')?.ownerId).toBeUndefined();
    });
    it('U6 a nested helper in an R6 method keeps a bare qualifiedName', () => {
      expect(findDef(r6, 'Function', 'helper')?.qualifiedName).toBe('helper');
    });
    it('U6 the method itself keeps ownerId = class and Class.method', () => {
      const run = findDef(r6, 'Method', 'run');
      expect({ ownerId: run?.ownerId, qualifiedName: run?.qualifiedName }).toEqual({
        ownerId: `def:${FILE}#1:0:Class:Acct`,
        qualifiedName: 'Acct.run',
      });
    });
  });

  // ─── Scenario 9 / U7: class body outside any method ───────────────────────
  describe('class-body field default (scenario 9)', () => {
    const scopes = scopesOf(FIELD_SRC);

    // U7 (HEAD-failing): the Class scope owns ONLY the class def.
    it('U7 the Class scope owns only the class def', () => {
      const owned = scopes.find((s) => s.kind === 'Class')?.ownedDefs ?? [];
      expect(owned.map((d) => d.type)).toEqual(['Class']);
    });

    // HEAD-passing: no Function scope contains the field-default call, so the
    // caller walk from it ends at the Class scope (the source is the Class node).
    it('has no Function scope around the field-default call', () => {
      const call = spanOf(FIELD_SRC, 'build_cache()');
      const [start] = call.split('-');
      const [line, col] = start.split(':').map(Number);
      const containing = scopes.filter(
        (s) =>
          s.kind === 'Function' &&
          (s.range.startLine < line || (s.range.startLine === line && s.range.startCol <= col)) &&
          (s.range.endLine > line || (s.range.endLine === line && s.range.endCol >= col)),
      );
      expect(containing.map((s) => fmt(s.range))).toEqual([]);
    });
  });

  // ─── Scenario 5 / U5: single-function file, no trailing newline ───────────
  describe('single-function file without a trailing newline (scenario 5)', () => {
    const scopes = scopesOf(SOLO_SRC);

    it('keeps scope ids unique when the assignment range equals the program range', () => {
      expect(new Set(scopes.map((s) => s.id)).size).toBe(scopes.length);
    });

    // U5 (HEAD-failing)
    it('U5 the def is owned by a Function scope whose parent is the Module', () => {
      expect(ownerInfo(scopes, 'Function', 'solo')).toEqual({
        kind: 'Function',
        parentKind: 'Module',
        range: spanOf(SOLO_SRC, SOLO_SRC),
      });
    });
  });

  // ─── Scenario 6: member-assigned functions ────────────────────────────────
  describe('member-assigned functions (scenario 6)', () => {
    const scopes = scopesOf(MEMBER_SRC);

    it('declares no def for obj$f <- function / x[["k"]] <- function', () => {
      expect(defNames(allDefs(scopes))).toEqual([]);
    });

    it('creates only the function_definition scopes (no assignment-anchored scope)', () => {
      const functionScopes = scopes.filter((s) => s.kind === 'Function').map((s) => fmt(s.range));
      expect(functionScopes.sort()).toEqual(
        [spanOf(MEMBER_SRC, 'function(x) g(x)'), spanOf(MEMBER_SRC, 'function(y) g(y)')].sort(),
      );
    });
  });
});
