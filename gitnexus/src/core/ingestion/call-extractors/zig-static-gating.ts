// gitnexus/src/core/ingestion/call-extractors/zig-static-gating.ts

/**
 * Zig static-gating resolver.
 *
 * Detects calls inside `if (CONST_FALSE)` blocks (and trivial boolean
 * extensions: `and`, `or`, `==`/`!=`, parentheses, and prefix `!` negation,
 * which tree-sitter-zig parses as `error_union_type`) so the call edge can be
 * tagged with `staticGated: true`.  The flag lets impact-analysis
 * consumers filter out paper-tiger callers that live in dead branches
 * gated behind a comptime-known `false` constant.
 *
 * Conservative by design: we only tag an edge when we can prove the
 * gating expression evaluates to `false`.  Anything ambiguous → live.
 *
 * Scope of v1:
 *
 *   (a) **File-local** consts (`pub const FOO = false;`, plus const-to-const
 *       aliases up to 5 hops), built once per file by `buildZigBoolConstMap`.
 *   (b) **Cross-file** (`const cfg = @import("./cfg.zig"); if (cfg.FOO)`) is
 *       NOT resolved yet. The evaluator keeps the seam for it (`importAliases`
 *       + `lookupBoolsForPath`, consumed by the `field_expression` case), but
 *       the only caller passes an empty alias map and a lookup that always
 *       returns `undefined`, because the capture emitter runs in the parse
 *       worker and sees only the current file. Tracked in #3162. Until then
 *       every `cfg.FOO` condition folds to unknown, i.e. live.
 *
 * Also out of scope: multi-hop member access (`cfg.sub.FOO`), re-exported
 * consts, runtime-evaluated bools (`const FOO = computeIt();`), and
 * `builtin.mode` gates.
 *
 * Wire-up: `stampZigStaticGating` in ../languages/zig/captures.ts calls
 * `collectZigStaticGatedRanges` once per file and marks every call capture
 * whose position falls inside a dead range with `@reference.static-gated`;
 * the scope-resolution pipeline carries that marker to the CALLS edge.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Maximum recursion depth when evaluating a boolean condition expression. */
const MAX_COND_DEPTH = 4;

/** A definite truth value, or `undefined` for "unknown / cannot prove". */
type TriBool = boolean | undefined;

/**
 * Per-file table of comptime-known booleans:
 *   `pub const FOO: bool = false;`  →  Map { 'FOO' → false }
 *   `pub const BAR = true;`         →  Map { 'BAR' → true }
 *
 * Constants whose RHS is anything other than a bare `boolean` literal
 * (e.g. function calls, struct accesses) are intentionally absent —
 * they resolve to `undefined`.
 */
export type ZigBoolConstMap = ReadonlyMap<string, boolean>;

/**
 * Per-file `@import` alias map, mapping a local identifier to the
 * resolved absolute file path of the imported module.  Used for the
 * `cfg.FOO` cross-file lookup pattern.
 *
 *   `const cfg = @import("./cfg.zig");`  →  Map { 'cfg' → 'src/cfg.zig' }
 */
export type ZigImportAliasMap = ReadonlyMap<string, string>;

/**
 * Cross-file lookup: given an alias-resolved file path, return that
 * file's known-bool map.  Implemented by the caller — the resolver
 * itself stays stateless.
 */
export type ZigBoolConstLookup = (filePath: string) => ZigBoolConstMap | undefined;

// ---------------------------------------------------------------------------
// Phase 2: per-file extraction
// ---------------------------------------------------------------------------

/** Cap on alias-chain hops walked when resolving `const A = B; const B = C; ...`. */
const MAX_ALIAS_HOPS = 5;

/**
 * Walk the top-level of a Zig source file and collect known-bool
 * constants.  Two passes:
 *
 *   Pass 1: collect every top-level `const X = <expr>` where the RHS
 *           is either a `boolean` literal (recorded in `literals`) or
 *           a single `identifier` (recorded in `aliases`).
 *   Pass 2: walk each alias entry up to `MAX_ALIAS_HOPS` hops; if the
 *           chain terminates at a known-bool literal, record `X` with
 *           the literal's value. Cycles, chains exceeding the cap, and
 *           chains exiting file scope (unknown identifier at the root)
 *           bail to "unknown".
 *
 * Only `const` decls qualify (not `var`). The function is permissive
 * about modifier tokens (`pub`, type annotation) — it reads only the
 * identifier name and the RHS expression shape.
 */
export function buildZigBoolConstMap(rootNode: SyntaxNode): ZigBoolConstMap {
  const literals = new Map<string, boolean>();
  const aliases = new Map<string, string>();
  for (const child of rootNode.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const entry = extractBoolConstOrAlias(child);
    if (!entry) continue;
    if (entry.kind === 'literal') {
      literals.set(entry.name, entry.value);
    } else {
      aliases.set(entry.name, entry.aliasOf);
    }
  }

  // Pass 2: resolve alias chains.
  for (const [name, target] of aliases) {
    const resolved = resolveAliasChain(name, target, literals, aliases);
    if (resolved !== undefined) {
      literals.set(name, resolved);
    }
  }

  return literals;
}

function resolveAliasChain(
  start: string,
  firstTarget: string,
  literals: ReadonlyMap<string, boolean>,
  aliases: ReadonlyMap<string, string>,
): boolean | undefined {
  // Walk: start → firstTarget → aliases.get(firstTarget) → ... up to MAX_ALIAS_HOPS.
  // Cycle protection via a visited set seeded with `start` itself.
  const visited = new Set<string>();
  visited.add(start);
  let current: string = firstTarget;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    if (visited.has(current)) return undefined; // cycle
    visited.add(current);
    const lit = literals.get(current);
    if (lit !== undefined) return lit;
    const next = aliases.get(current);
    if (next === undefined) return undefined; // chain exits file scope or hits unknown
    current = next;
  }
  return undefined; // hop cap exceeded
}

type RawDecl =
  | { kind: 'literal'; name: string; value: boolean }
  | { kind: 'alias'; name: string; aliasOf: string };

function extractBoolConstOrAlias(decl: SyntaxNode): RawDecl | null {
  // Require `const` and exclude `var`. tree-sitter-zig parses both with
  // the same `variable_declaration` shape; the qualifier is an anonymous
  // child token. A `pub var FOO = false;` is mutable global state — its
  // initial value is NOT a comptime constant and must not feed gating.
  let isConst = false;
  let isVar = false;
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (!c || c.isNamed) continue;
    if (c.type === 'const') isConst = true;
    else if (c.type === 'var') isVar = true;
  }
  if (!isConst || isVar) return null;

  let name: string | undefined;
  let value: boolean | undefined;
  let aliasOf: string | undefined;

  for (const c of decl.namedChildren) {
    if (c.type === 'identifier' && name === undefined) {
      name = c.text;
      continue;
    }
    if (c.type === 'boolean') {
      const t = c.text;
      if (t === 'true') value = true;
      else if (t === 'false') value = false;
    } else if (c.type === 'identifier' && name !== undefined && aliasOf === undefined) {
      // Second `identifier` child is the RHS alias target:
      //   `const B = A;`  → name='B', aliasOf='A'.
      aliasOf = c.text;
    }
  }

  if (name === undefined) return null;
  if (value !== undefined) return { kind: 'literal', name, value };
  if (aliasOf !== undefined) return { kind: 'alias', name, aliasOf };
  return null;
}

// ---------------------------------------------------------------------------
// Phase 3: dead-range collection + condition evaluation
// ---------------------------------------------------------------------------

/**
 * Every source range that is statically dead in this file: the body of an
 * `if` whose condition folds to `false`, and the `else` clause of an `if`
 * whose condition folds to `true`. Both the statement form (`if (c) { .. }`)
 * and the expression form (`const x = if (c) a else b;`) are walked; the
 * arms differ only in how the grammar exposes them, see `ifExpressionArms`.
 * Line/col ranges, so a capture layer that
 * only keeps `Capture.range` (no node) can still stamp its call sites —
 * that is how the scope-resolution provider consumes this module.
 *
 * One walk per file over every `if`, so a call site is classified by
 * position lookup; nesting needs no special case because an inner branch
 * inside a dead body is inside the dead body's range already.
 */
export interface ZigGatedRange {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

export function collectZigStaticGatedRanges(
  rootNode: SyntaxNode,
  localBools: ZigBoolConstMap,
  importAliases: ZigImportAliasMap,
  lookupBoolsForPath: ZigBoolConstLookup,
): readonly ZigGatedRange[] {
  const out: ZigGatedRange[] = [];
  for (const node of rootNode.descendantsOfType(['if_statement', 'if_expression'])) {
    const cond = findIfCondition(node);
    const result = cond
      ? evalCond(cond, localBools, importAliases, lookupBoolsForPath, 0)
      : undefined;
    let dead: SyntaxNode | null = null;
    if (node.type === 'if_statement') {
      if (result === false) dead = node.childForFieldName('body');
      if (result === true)
        dead = node.namedChildren.find((c) => c.type === 'else_clause') ?? null;
    } else {
      const arms = ifExpressionArms(node);
      if (result === false) dead = arms.consequence;
      if (result === true) dead = arms.alternative;
    }
    if (dead) {
      out.push({
        startLine: dead.startPosition.row + 1,
        startCol: dead.startPosition.column,
        endLine: dead.endPosition.row + 1,
        endCol: dead.endPosition.column,
      });
    }
  }
  return out;
}

/**
 * The two arms of an `if_expression` (`const x = if (c) a else b;`). Unlike
 * `if_statement` the grammar gives them no field names and no `else_clause`
 * wrapper: the consequence is the first named child after the closing `)`
 * of the condition, the alternative is the first named child after the
 * anonymous `else` token. Either may be absent.
 */
function ifExpressionArms(node: SyntaxNode): {
  consequence: SyntaxNode | null;
  alternative: SyntaxNode | null;
} {
  let consequence: SyntaxNode | null = null;
  let alternative: SyntaxNode | null = null;
  let slot: 'none' | 'consequence' | 'alternative' = 'none';
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (!c.isNamed) {
      if (c.type === ')' && slot === 'none') slot = 'consequence';
      else if (c.type === 'else') slot = 'alternative';
      continue;
    }
    if (slot === 'consequence' && !consequence) consequence = c;
    else if (slot === 'alternative' && !alternative) alternative = c;
  }
  return { consequence, alternative };
}

/** Is a (1-based line, 0-based col) position inside one of `ranges`? */
export function isPositionStaticGated(
  line: number,
  col: number,
  ranges: readonly ZigGatedRange[],
): boolean {
  for (const r of ranges) {
    if (line < r.startLine || line > r.endLine) continue;
    if (line === r.startLine && col < r.startCol) continue;
    if (line === r.endLine && col >= r.endCol) continue;
    return true;
  }
  return false;
}

/** Pick the condition node out of an `if_statement`. The condition is
 * the first named child (the body / else branches come after). */
function findIfCondition(ifNode: SyntaxNode): SyntaxNode | null {
  return ifNode.namedChildren[0] ?? null;
}

/**
 * Evaluate a boolean condition expression to a tribool.
 *
 * Handles only the shapes we can resolve symbolically; everything else
 * returns `undefined` ("unknown — treat as live").
 */
function evalCond(
  node: SyntaxNode,
  localBools: ZigBoolConstMap,
  importAliases: ZigImportAliasMap,
  lookupBoolsForPath: ZigBoolConstLookup,
  depth: number,
): TriBool {
  if (depth > MAX_COND_DEPTH) return undefined;

  switch (node.type) {
    case 'boolean': {
      // Bare literal: `if (false)`.
      if (node.text === 'true') return true;
      if (node.text === 'false') return false;
      return undefined;
    }

    case 'identifier': {
      // Bare flag check: `if (FOO)`.
      const v = localBools.get(node.text);
      return v === undefined ? undefined : v;
    }

    case 'field_expression': {
      // `cfg.FOO` — alias hop.
      const obj = node.namedChildren[0];
      const member = node.namedChildren[1];
      if (obj?.type !== 'identifier' || member?.type !== 'identifier') {
        return undefined;
      }
      const targetFile = importAliases.get(obj.text);
      if (!targetFile) return undefined;
      const targetBools = lookupBoolsForPath(targetFile);
      if (!targetBools) return undefined;
      const v = targetBools.get(member.text);
      return v === undefined ? undefined : v;
    }

    case 'binary_expression': {
      // `lhs and rhs` / `lhs or rhs` / `lhs == rhs` / `lhs != rhs`.
      const op = findOperatorToken(node);
      const lhs = node.namedChildren[0];
      const rhs = node.namedChildren[1];
      if (!lhs || !rhs) return undefined;
      const l = evalCond(lhs, localBools, importAliases, lookupBoolsForPath, depth + 1);
      const r = evalCond(rhs, localBools, importAliases, lookupBoolsForPath, depth + 1);
      if (op === 'and') {
        // `false and *` = false; `* and false` = false.
        if (l === false || r === false) return false;
        if (l === true && r === true) return true;
        return undefined;
      }
      if (op === 'or') {
        // Only `false or false` is provably false.
        if (l === false && r === false) return false;
        if (l === true || r === true) return true;
        return undefined;
      }
      if (op === '==') {
        // Equality folds when both sides are known booleans.
        // `FOO == false` ↔ `!FOO`; `FOO == true` ↔ `FOO`.
        if (l === undefined || r === undefined) return undefined;
        return l === r;
      }
      if (op === '!=') {
        if (l === undefined || r === undefined) return undefined;
        return l !== r;
      }
      // Other comparison ops (<, >, …) — not booleans we can prove.
      return undefined;
    }

    case 'parenthesized_expression': {
      // `(cond)`: transparent.
      const inner = node.namedChildren[0];
      if (!inner) return undefined;
      return evalCond(inner, localBools, importAliases, lookupBoolsForPath, depth + 1);
    }

    case 'error_union_type': {
      // tree-sitter-zig has no unary `!` node: prefix `!cond` (boolean
      // negation) parses as `error_union_type` because the same `!` token
      // introduces error-union types. In condition position that reading is
      // never a type, so negate whatever the operand folds to: an
      // identifier, a literal, or a parenthesized compound like `!(A and B)`.
      const inner = node.namedChildren[0];
      if (!inner) return undefined;
      const v = evalCond(inner, localBools, importAliases, lookupBoolsForPath, depth + 1);
      if (v === undefined) return undefined;
      return !v;
    }

    default:
      return undefined;
  }
}

/**
 * Pull the textual operator (e.g. "and", "or") out of a
 * `binary_expression`.  In tree-sitter-zig, the operator is an
 * anonymous child token whose `type` equals the operator string.
 */
function findOperatorToken(binExpr: SyntaxNode): string | undefined {
  for (let i = 0; i < binExpr.childCount; i++) {
    const c = binExpr.child(i);
    if (!c) continue;
    if (!c.isNamed) {
      // Anonymous tokens for these ops carry their text as the type.
      if (c.type === 'and' || c.type === 'or' || c.type === '==' || c.type === '!=') {
        return c.type;
      }
    }
  }
  return undefined;
}
