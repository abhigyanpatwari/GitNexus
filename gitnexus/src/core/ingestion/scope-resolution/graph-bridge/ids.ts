/**
 * Scope-resolution → legacy graph-node ID bridging.
 *
 * Two functions:
 *   - `resolveDefGraphId` — turn a scope-resolution `SymbolDefinition`
 *     into the graph's node id for the corresponding legacy node.
 *   - `resolveCallerGraphId` — walk a scope chain from a reference
 *     site upward to find the enclosing function/method/class and
 *     return its graph-node id. Falls back to the File node for
 *     module-level calls so those still get an edge source.
 *
 * Next-consumer contract: language-agnostic. Any OO language with
 * file-level module semantics (TypeScript, Java, Go, Kotlin) can
 * reuse `resolveCallerGraphId` as-is. Languages with different
 * top-level semantics (COBOL programs, Rust crate modules) may want
 * a different file-level fallback — cross that bridge when they
 * migrate.
 */

import type { NodeLabel, ParameterTypeClass, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';
import {
  AMBIGUOUS_POSITION,
  localNameKey,
  positionKey,
  qualifiedKey,
  simpleKey,
  type GraphNodeLookup,
} from '../graph-bridge/node-lookup.js';
import {
  isOverloadableCallable,
  isPositionQualifiedLocalLabel,
} from '../../utils/callable-labels.js';
import { templateConstraintsIdTag } from '../../utils/template-arguments.js';
import { parameterShapeIdTag } from '../../utils/method-props.js';
/**
 * Labels that may legitimately ANCHOR a CALLS/ACCESSES edge as the
 * source ("caller"). A Variable / Property can be the TARGET of an
 * edge (e.g., a write-access to `user.name`), but it cannot be a
 * caller — variables don't execute code, so attributing a call to a
 * sibling Variable in the same scope produces nonsense edges like
 * `Variable:create → Function:create` (which the simpleKey fallback
 * in `resolveDefGraphId` then silently rewrites to
 * `Function:create → Function:create`, a self-loop that doesn't exist
 * in the source).
 *
 * Module-level call expressions inside a `const X = expr(args)`
 * declaration are the canonical case where this used to fail: the
 * walk-up over module scope's ownedDefs (only Variables) would land
 * on the FIRST Variable, get name-aliased to its sibling Function
 * with the same simple name, and emit a self-CALLS. With this label
 * restricted to function/class-likes, those calls correctly fall
 * through to the File-node fallback at the bottom of the walk.
 */
function isCallerAnchorLabel(label: NodeLabel): boolean {
  return (
    label === 'Function' ||
    label === 'Method' ||
    label === 'Constructor' ||
    label === 'Module' ||
    label === 'Class' ||
    label === 'Interface' ||
    label === 'Struct' ||
    label === 'Enum'
  );
}

function rangeContainsPoint(
  range: { startLine: number; startCol: number; endLine: number; endCol: number },
  at: { startLine: number; startCol: number },
): boolean {
  if (at.startLine < range.startLine || at.startLine > range.endLine) return false;
  if (at.startLine === range.startLine && at.startCol < range.startCol) return false;
  if (at.startLine === range.endLine && at.startCol > range.endCol) return false;
  return true;
}

const isCallableDef = (d: SymbolDefinition): boolean =>
  d.type === 'Function' || d.type === 'Method' || d.type === 'Constructor';

/**
 * True when `range` is the body of `def` itself — the scope's start position
 * equals the def's declaration position.
 *
 * Safe to compare directly: `scope-extractor.ts` builds a def id as
 * `def:<filePath>#<startLine>:<startCol>:<type>:<name>` from the same `Range`
 * a scope carries, so both sides share one coordinate base and need no
 * conversion. (Do not "fix" this against the 1-based reading in
 * `defStartLine`'s docblock — what matters here is that the two sides agree
 * with each other, not which base they use.)
 */
function scopeIsCallableBody(
  range: { startLine: number; startCol: number },
  def: SymbolDefinition,
): boolean {
  const m = def.nodeId.match(/#(\d+):(\d+):/);
  if (m === null) return false;
  return Number(m[1]) === range.startLine && Number(m[2]) === range.startCol;
}

/** Pick the callable that owns `atRange` when multiple overloads share a class scope. */
function pickCallerCallableDef(
  scope: {
    readonly id: ScopeId;
    readonly range: { startLine: number; startCol: number; endLine: number; endCol: number };
    readonly ownedDefs: readonly SymbolDefinition[];
  },
  scopes: ScopeResolutionIndexes,
  atRange?: { startLine: number; startCol: number },
): SymbolDefinition | undefined {
  if (atRange !== undefined) {
    for (const childId of scopes.scopeTree.getChildren(scope.id)) {
      const child = scopes.scopeTree.getScope(childId);
      if (child === undefined) continue;
      if (!rangeContainsPoint(child.range, atRange)) continue;
      const childCallable = child.ownedDefs.find(isCallableDef);
      if (childCallable === undefined) continue;
      if (child.kind === 'Function') return childCallable;
      // A Block-kind scope is a callable boundary ONLY when the scope IS that
      // callable's own body. Kotlin `lambda_literal` and Ruby `do_block`/`block`
      // are @scope.block deliberately (#1757 smart casts), so the kind gate
      // alone would never let a closure there become a call SOURCE (#2699).
      //
      // But relaxing the gate to accept ANY Block owning a callable is wrong:
      // a nested `fun foo()` declared inside a block is owned by that block, so
      // a call made at BLOCK level — outside foo — would be misattributed to
      // foo. The alignment test discriminates them. For a closure the
      // declaration and the scope sit on the SAME node (the anchor discipline
      // documented in javascript/query.ts), so their start positions match; for
      // a nested function the block starts at `{` and the def starts at the
      // declaration, so they do not.
      if (child.kind === 'Block' && scopeIsCallableBody(child.range, childCallable)) {
        return childCallable;
      }
    }
  }
  return scope.ownedDefs.find(isCallableDef);
}

/**
 * Look up a `SymbolDefinition` in the graph node lookup.
 *
 * Tries the type-prefixed fully-qualified key FIRST. That's the only
 * correct key when:
 *   - Two classes in the same file define a method with the same
 *     simple name (`class User: def save` + `class Document: def save`).
 *   - A top-level function and a class method share a simple name
 *     (`def save` + `class User: def save` — the Function's qualifier
 *     is just `save`, which would alias the Method's simple-key slot
 *     without the type prefix).
 *
 * Falls back to the simple name for definitions whose qualifier the
 * lookup didn't capture (rare, but keeps cross-file simple-name
 * resolution working for languages that don't yet synthesize
 * qualifiers).
 */
/**
 * Extract the 1-based declaration line from a scope-resolution def id.
 * Shape: `def:<filePath>#<line>:<col>:<...>`; `undefined` when it doesn't match.
 */
function defStartLine(nodeId: string | undefined): number | undefined {
  if (nodeId === undefined) return undefined;
  const m = nodeId.match(/#(\d+):(\d+):/);
  if (m === null) return undefined;
  const line = Number(m[1]);
  return Number.isFinite(line) ? line : undefined;
}

/**
 * Trailing segment of a dotted qualified name (`Outer.inner` -> `inner`),
 * with any function-local `@line:col` identity suffix stripped
 * (`run.pick@5:10` -> `pick`).
 *
 * The graph node's `name` property is the bare source name, so the position
 * key must compare against that — the position it carries is already the
 * disambiguator, and leaving the suffix on would make every local miss.
 */
function simpleNameOf(qualifiedName: string): string {
  const dot = qualifiedName.lastIndexOf('.');
  const tail = dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
  return tail.replace(/@\d+:\d+$/, '');
}

export function resolveDefGraphId(
  filePath: string,
  def: {
    /** Scope-resolution def id — carries the declaration position (#2699). */
    nodeId?: string;
    qualifiedName?: string;
    type?: NodeLabel;
    parameterTypes?: readonly string[];
    parameterTypeClasses?: readonly ParameterTypeClass[];
    parameterCount?: number;
    templateArguments?: readonly string[];
    templateConstraints?: unknown;
    /** #1982 bridge-held namespace path; see `SymbolDefinition.namespacePrefix`. */
    namespacePrefix?: string;
  },
  nodeLookup: GraphNodeLookup,
): string | undefined {
  const qn = def.qualifiedName;
  if (qn === undefined || qn.length === 0) return undefined;
  if (def.type !== undefined) {
    // Position key FIRST (#2699). A def and its graph node are the same
    // construct, so they share a source line — the only evidence that
    // separates a function-local declaration from a same-named file-level one
    // without either side having to model the scope chain. Node ids are
    // 0-based, def ids 1-based. An `AMBIGUOUS_POSITION` tombstone (two
    // callables on one line) falls through to the name-based keys below.
    const line = defStartLine(def.nodeId);
    if (line !== undefined && isPositionQualifiedLocalLabel(def.type)) {
      const simple = simpleNameOf(qn);
      const posHit = nodeLookup.get(positionKey(filePath, def.type, line - 1, simple));
      if (posHit !== undefined && posHit !== AMBIGUOUS_POSITION) return posHit;
      // FAIL CLOSED when a function-local of this name exists in the file (#2699
      // follow-up). Falling through to the name keys would end at the label-agnostic,
      // first-write-wins `simpleKey` below and alias this def onto whichever same-named
      // callable was registered first — reproducibly minting a FALSE edge for a
      // multiline `const pick =` (the declaration and its initializer land on different
      // lines, so the position join misses). A missing edge is the correct failure
      // direction for a graph whose consumers include `impact`; a fabricated caller is
      // not. Gated on `localNameKey` so this ONLY fires where the collision is real —
      // a file with no such local keeps its previous fallback behaviour, which is what
      // preserves legitimate anchor differences such as a Vue SFC's `lineOffset`.
      if (nodeLookup.get(localNameKey(filePath, def.type, simple)) !== undefined) {
        return undefined;
      }
    }
    // SFINAE / `requires`-clause disambiguation (issue #1579) — try the
    // constraint-fingerprinted key FIRST. Two function-template overloads
    // with identical `parameterTypes` but mutually-exclusive SFINAE
    // constraints route to their distinct graph nodes via this key.
    // Must run before the parameter-types key because both overloads
    // share the latter.
    if (
      (def.type === 'Function' || def.type === 'Method') &&
      def.templateConstraints !== undefined
    ) {
      const cKey = qualifiedKey(
        filePath,
        def.type,
        `${qn}${templateConstraintsIdTag(def.templateConstraints)}`,
      );
      const cHit = nodeLookup.get(cKey);
      if (cHit !== undefined) return cHit;
    }
    if (
      isOverloadableCallable(def.type) &&
      def.parameterTypes !== undefined &&
      def.parameterTypeClasses !== undefined
    ) {
      const shapeTag = parameterShapeIdTag(def.parameterTypes, def.parameterTypeClasses);
      if (shapeTag !== '') {
        const shapeKey = qualifiedKey(filePath, def.type, `${qn}${shapeTag}`);
        const shapeHit = nodeLookup.get(shapeKey);
        if (shapeHit !== undefined) return shapeHit;
      }
    }
    // Overload disambiguation: when the def carries parameter types,
    // try the parameter-typed key first so same-name same-arity
    // overloads route to their distinct graph nodes. Constructors are
    // included so a C# `: this(int)` / `: base(int)` chain, a Java
    // `this(int)`/`super(int)` chain, or `new Foo(int)` resolves to the
    // matching ctor overload instead of first-wins collapsing onto
    // another `Foo` ctor (a self-loop) — #1928 F38 / #2046.
    if (
      isOverloadableCallable(def.type) &&
      def.parameterTypes !== undefined &&
      def.parameterTypes.length > 0
    ) {
      const pKey = qualifiedKey(filePath, def.type, `${qn}~${def.parameterTypes.join(',')}`);
      const pHit = nodeLookup.get(pKey);
      if (pHit !== undefined) return pHit;
    }
    // Arity-disambiguating key (see node-lookup.ts): route a same-name overload
    // to the structure node with the matching parameter count. Critical for a
    // zero-arg overload (no parameterTypes) that would otherwise collapse onto a
    // sibling overload via the source-order-dependent qualified key.
    if (isOverloadableCallable(def.type) && def.parameterCount !== undefined) {
      const aKey = qualifiedKey(filePath, def.type, `${qn}#${def.parameterCount}`);
      const aHit = nodeLookup.get(aKey);
      if (aHit !== undefined) return aHit;
    }
    if (
      (def.type === 'Class' ||
        def.type === 'Struct' ||
        def.type === 'Interface' ||
        def.type === 'Enum' ||
        def.type === 'Record') &&
      def.templateArguments !== undefined &&
      def.templateArguments.length > 0
    ) {
      const tKey = qualifiedKey(filePath, def.type, `${qn}~${def.templateArguments.join(',')}`);
      const tHit = nodeLookup.get(tKey);
      if (tHit !== undefined) return tHit;
    }
    const qualifiedHit = nodeLookup.get(qualifiedKey(filePath, def.type, qn));
    if (qualifiedHit !== undefined) return qualifiedHit;
    // #1982: some scope-extractors qualify a type by its enclosing CLASS chain
    // (`A.Inner`) but drop the enclosing NAMESPACE, while the structure-phase
    // node is keyed by the full path (`NS.A.Inner`). Retry with the
    // namespace-prefixed key (tagged by `tagNamespacePrefixes`) BEFORE the
    // simple-name fallback, so same-tail nested bases don't collapse across
    // sibling namespace members via `simpleKey`.
    const nsPrefix = def.namespacePrefix;
    if (nsPrefix !== undefined && nsPrefix.length > 0) {
      const nsHit = nodeLookup.get(qualifiedKey(filePath, def.type, `${nsPrefix}.${qn}`));
      if (nsHit !== undefined) return nsHit;
    }
  }
  const simpleName = qn.lastIndexOf('.') === -1 ? qn : qn.slice(qn.lastIndexOf('.') + 1);
  return nodeLookup.get(simpleKey(filePath, simpleName));
}

/** Derive the simple (unqualified) name of a def from its `qualifiedName`. */
export function simpleQualifiedName(def: SymbolDefinition): string | undefined {
  const q = def.qualifiedName;
  if (q === undefined || q.length === 0) return undefined;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
}

/**
 * Walk the scope chain from `startScope` upward looking for the first
 * scope whose `ownedDefs` contains a Function/Method/Class — that's
 * our caller anchor. Translate via `nodeLookup` to the graph-node ID.
 *
 * Module-level references (e.g. Python `u = models.User()` at top
 * level) have no enclosing function/method/class. Fall back to the
 * File node for the scope's filePath so those calls still get an
 * edge source. Matches legacy DAG behavior where module-level CALLS
 * edges originate from the file symbol.
 */
export function resolveCallerGraphId(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  atRange?: { startLine: number; startCol: number },
): string | undefined {
  let current: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  let lastFilePath: string | undefined;
  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) break;
    lastFilePath = scope.filePath;

    // Prefer Function/Method/Constructor anchors; fall back to
    // Class/Interface/Struct/Enum. Variable/Property are NOT valid
    // caller anchors — see `isCallerAnchorLabel` for why.
    const fnDef = pickCallerCallableDef(scope, scopes, atRange);
    if (fnDef !== undefined) {
      const id = resolveDefGraphId(fnDef.filePath, fnDef, nodeLookup);
      if (id !== undefined) return id;
    }
    const classDef = scope.ownedDefs.find((d) => isCallerAnchorLabel(d.type));
    if (classDef !== undefined) {
      const id = resolveDefGraphId(scope.filePath, classDef, nodeLookup);
      if (id !== undefined) return id;
    }
    current = scope.parent;
  }
  // Module-level calls — fall back to the File node for the scope's filePath.
  if (lastFilePath !== undefined) {
    return generateId('File', lastFilePath);
  }
  return undefined;
}
