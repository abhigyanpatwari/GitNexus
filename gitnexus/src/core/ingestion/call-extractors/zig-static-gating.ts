// gitnexus/src/core/ingestion/call-extractors/zig-static-gating.ts

/**
 * Zig static-gating resolver.
 *
 * Detects calls inside `if (CONST_FALSE)` blocks (and trivial boolean
 * extensions: `and`, `or`, simple negation) so the call edge can be
 * tagged with `staticGated: true`.  The flag lets impact-analysis
 * consumers filter out paper-tiger callers that live in dead branches
 * gated behind a comptime-known `false` constant.
 *
 * Conservative by design: we only tag an edge when we can prove the
 * gating expression evaluates to `false`.  Anything ambiguous → live.
 *
 * v1 supports two scopes of resolution:
 *
 *   (a) **File-local** consts (`pub const FOO = false;`) — built per
 *       Zig file once and cached.
 *   (b) **One-hop @import alias** (`const cfg = @import("./cfg.zig");
 *       if (cfg.FOO) { ... }`) — resolved via the existing Zig import
 *       resolver, with a separate per-file alias map.
 *
 * Out of scope for v1:
 *   - Multi-hop: `cfg.sub.FOO` (we only handle one identifier dot one).
 *   - Re-exported consts across multiple files.
 *   - Runtime-evaluated bools (`const FOO = computeIt();`).
 *   - Field re-aliasing (`const FOO = OTHER;`).
 *
 * Wire-up: see ./configs/zig.ts — the call extractor's
 * `extractLanguageCallSite` hook walks ancestors and consults the
 * resolver to decide whether to emit `staticGated: true`.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { resolveZigImportInternal } from '../import-resolvers/zig.js';
import type { ZigBuildZonConfig } from '../language-config.js';

/** Maximum number of `if_statement` ancestors we walk above a call. */
const MAX_IF_ANCESTORS = 5;

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

/**
 * Walk the top-level of a Zig source file and collect `@import` alias
 * declarations:
 *
 *   `const cfg = @import("./cfg.zig");`  →  Map { 'cfg' → 'src/cfg.zig' }
 *
 * Imports that don't resolve to a file in the repo (`@import("std")`,
 * package deps without a build.zig.zon path, etc.) are skipped.
 */
export function buildZigImportAliasMap(
  rootNode: SyntaxNode,
  currentFilePath: string,
  allFilePaths: Set<string>,
  buildZon: ZigBuildZonConfig | null | undefined,
): ZigImportAliasMap {
  const out = new Map<string, string>();
  for (const child of rootNode.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const entry = extractImportAlias(child, currentFilePath, allFilePaths, buildZon);
    if (entry) out.set(entry.name, entry.target);
  }
  return out;
}

/**
 * Worker-side variant of `buildZigImportAliasMap` that emits the raw
 * `@import("...")` path strings without resolving them — workers don't
 * have access to the global file list / build.zig.zon needed for path
 * resolution.  The main thread later resolves each entry via
 * `resolveZigImportInternal` when aggregating cross-file gating context.
 *
 *   `const cfg = @import("./cfg.zig");`  →  Map { 'cfg' → './cfg.zig' }
 */
export function buildZigRawImportAliasMap(rootNode: SyntaxNode): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const child of rootNode.namedChildren) {
    if (child.type !== 'variable_declaration') continue;
    const entry = extractRawImportAlias(child);
    if (entry) out.set(entry.name, entry.importPath);
  }
  return out;
}

function extractRawImportAlias(decl: SyntaxNode): { name: string; importPath: string } | null {
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
  let importPath: string | undefined;

  for (const c of decl.namedChildren) {
    if (c.type === 'identifier' && name === undefined) {
      name = c.text;
      continue;
    }
    if (c.type === 'builtin_function') {
      const ident = c.namedChildren.find((cc) => cc.type === 'builtin_identifier');
      if (!ident || ident.text !== '@import') continue;
      const args = c.namedChildren.find((cc) => cc.type === 'arguments');
      if (!args) continue;
      const str = args.namedChildren.find((cc) => cc.type === 'string');
      if (!str) continue;
      const content = str.namedChildren.find((cc) => cc.type === 'string_content');
      if (content) importPath = content.text;
    }
  }

  if (name === undefined || importPath === undefined) return null;
  return { name, importPath };
}

function extractImportAlias(
  decl: SyntaxNode,
  currentFilePath: string,
  allFilePaths: Set<string>,
  buildZon: ZigBuildZonConfig | null | undefined,
): { name: string; target: string } | null {
  // Require `const` (the idiomatic spelling for `@import` aliases).
  // `var cfg = @import(...)` is technically legal but would let a
  // later assignment shadow the import; we don't follow assignments.
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
  let importPath: string | undefined;

  for (const c of decl.namedChildren) {
    if (c.type === 'identifier' && name === undefined) {
      name = c.text;
      continue;
    }
    if (c.type === 'builtin_function') {
      // Look for @import("...") shape.
      const ident = c.namedChildren.find((cc) => cc.type === 'builtin_identifier');
      if (!ident || ident.text !== '@import') continue;
      const args = c.namedChildren.find((cc) => cc.type === 'arguments');
      if (!args) continue;
      const str = args.namedChildren.find((cc) => cc.type === 'string');
      if (!str) continue;
      const content = str.namedChildren.find((cc) => cc.type === 'string_content');
      if (content) importPath = content.text;
    }
  }

  if (name === undefined || importPath === undefined) return null;
  const resolved = resolveZigImportInternal(currentFilePath, importPath, allFilePaths, buildZon);
  if (!resolved) return null;
  return { name, target: resolved };
}

// ---------------------------------------------------------------------------
// Phase 3: ancestor walk + condition evaluation
// ---------------------------------------------------------------------------

/**
 * Decide whether a call expression sits inside a statically-dead
 * branch of any enclosing `if` statement.
 *
 * Walks up to {@link MAX_IF_ANCESTORS} `if_statement` ancestors,
 * tracking the descent direction (consequence vs alternative) so we
 * can flag the dead branch correctly:
 *
 *    cond=false, via body         → DEAD (gated)
 *    cond=true,  via else_clause  → DEAD (gated)
 *    cond=true,  via body         → live (no signal from this ancestor)
 *    cond=false, via else_clause  → live (no signal)
 *    cond=unknown                 → no signal
 *
 * Returns `true` if ANY ancestor proves the call is dead.  `else if`
 * chains nest naturally as `else_clause → if_statement → ...`, so
 * each level applies the rule independently and the walker visits
 * them all on the way up.
 */
export function isCallStaticGated(
  callNode: SyntaxNode,
  localBools: ZigBoolConstMap,
  importAliases: ZigImportAliasMap,
  lookupBoolsForPath: ZigBoolConstLookup,
): boolean {
  let child: SyntaxNode = callNode;
  let parent: SyntaxNode | null = callNode.parent;
  let ifCount = 0;
  while (parent && ifCount < MAX_IF_ANCESTORS) {
    if (parent.type === 'if_statement') {
      ifCount++;
      const direction = ifBranchDirection(parent, child);
      if (direction !== 'condition') {
        const cond = findIfCondition(parent);
        if (cond) {
          const result = evalCond(cond, localBools, importAliases, lookupBoolsForPath, 0);
          if (result === false && direction === 'consequence') return true;
          if (result === true && direction === 'alternative') return true;
        }
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Given an `if_statement` and a direct child node we just ascended
 * from, classify which slot of the if the child sits in.
 *
 * Returns `'consequence'` when the child is the body (the THEN
 * branch), `'alternative'` when the child is the `else_clause` (or
 * the call lives inside its subtree, which it does because we walked
 * up through it), and `'condition'` when — pathologically — the call
 * lives inside the condition expression itself.  Conditions don't
 * gate themselves, so the caller treats `'condition'` as no-op.
 */
function ifBranchDirection(
  ifNode: SyntaxNode,
  ascendedFrom: SyntaxNode,
): 'consequence' | 'alternative' | 'condition' {
  if (ascendedFrom.type === 'else_clause') return 'alternative';
  const body = ifNode.childForFieldName('body');
  // tree-sitter wraps each accessor call in a fresh JS object, so
  // reference equality (`a === b`) is unreliable even when both
  // wrappers point at the same underlying syntax node.  Compare by
  // the stable numeric `id` instead — every wrapper for one node
  // exposes the same `id`.
  if (body && nodesEqual(body, ascendedFrom)) return 'consequence';
  // Fall through: must be the condition expression.
  return 'condition';
}

/** Reference-equal-by-stable-id check for tree-sitter syntax nodes. */
function nodesEqual(a: SyntaxNode, b: SyntaxNode): boolean {
  // The native binding exposes a numeric `id` per node.  TypeScript's
  // `SyntaxNode` typing doesn't surface it, so we widen to `unknown`
  // and read defensively — if the runtime lacks `id`, fall back to
  // structural equality on byte range + type.
  const aId = (a as unknown as { id?: number }).id;
  const bId = (b as unknown as { id?: number }).id;
  if (typeof aId === 'number' && typeof bId === 'number') return aId === bId;
  return (
    a.type === b.type &&
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex
  );
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
      if (
        obj?.type !== 'identifier' ||
        member?.type !== 'identifier'
      ) {
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

    case 'error_union_type': {
      // tree-sitter-zig misparses prefix `!FOO` (boolean negation) as
      // `error_union_type` because the same `!` token is used for
      // error-union types.  We handle the pragmatic case: a single
      // resolvable identifier inside an `error_union_type` whose
      // immediate parent is an `if_statement` condition position.
      // Negate the inner value.
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
