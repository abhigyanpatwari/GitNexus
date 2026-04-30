/**
 * `ScopeTree` — the lexical-scope spine of the `SemanticModel`
 * (RFC §2.2 + §3.1; Ring 2 SHARED #912).
 *
 * Generalizes the `enclosingFunctions` pattern from closed PR #902 to
 * arbitrary `ScopeKind`s. Owns the (parent ↔ children) relationship
 * derived from each `Scope.parent` pointer, and validates the structural
 * invariants a well-formed scope tree must satisfy.
 *
 * Invariants enforced at build time (throw on violation):
 *
 *   - Every non-`Module` scope has a non-null parent.
 *   - Every parent pointer references a scope that was also supplied to
 *     `buildScopeTree`.
 *   - Parent range **strictly contains** child range.
 *   - Sibling ranges under the same parent do not overlap.
 *   - Parent and child live in the same `filePath`. (Cross-file parent
 *     pointers would be a category error — a `File` scope is not the
 *     parent of another file's scopes; imports do that job.)
 *
 * Satisfies the `ScopeLookup` contract (defined in `./types.js`), so
 * `resolveTypeRef` (#916) and the scope-aware registries (#917) can take a
 * `ScopeTree` directly without adapters.
 *
 * Immutable surface: `byId` is a `ReadonlyMap`; children arrays are
 * `Object.freeze`d; miss lookups return a shared frozen empty array.
 */

import type { Scope, ScopeId, ScopeLookup, Range } from './types.js';

// ─── Public contract ────────────────────────────────────────────────────────

export interface ScopeTree extends ScopeLookup {
  readonly size: number;
  readonly byId: ReadonlyMap<ScopeId, Scope>;

  getScope(id: ScopeId): Scope | undefined;
  getParent(id: ScopeId): Scope | undefined;
  /** Child `ScopeId`s of `id`, in input order. Frozen empty array on miss. */
  getChildren(id: ScopeId): readonly ScopeId[];
  /**
   * Ancestor chain from the immediate parent up to (and including) the
   * root module scope. Excludes the starting scope itself. Frozen empty
   * array on miss / for a root scope.
   */
  getAncestors(id: ScopeId): readonly ScopeId[];
  has(id: ScopeId): boolean;
}

// ─── Build errors ───────────────────────────────────────────────────────────

/**
 * Thrown by `buildScopeTree` when the input violates a structural
 * invariant. Carries the offending ids + the invariant name so failed
 * extraction pipelines can report actionable diagnostics.
 */
export class ScopeTreeInvariantError extends Error {
  constructor(
    readonly invariant:
      | 'non-module-requires-parent'
      | 'parent-not-found'
      | 'parent-must-contain-child'
      | 'sibling-ranges-overlap'
      | 'parent-must-share-filepath'
      | 'duplicate-scope-id',
    message: string,
  ) {
    super(message);
    this.name = 'ScopeTreeInvariantError';
  }
}

// ─── Builder ───────────────────────────────────────────────────────────────

/**
 * Build an immutable `ScopeTree` from a flat list of `Scope` records.
 *
 * Throws `ScopeTreeInvariantError` on the first invariant violation; a
 * malformed tree is a bug in the extraction pipeline, not a data case for
 * consumers to handle, so fail-fast is the correct posture.
 */
export function buildScopeTree(scopes: readonly Scope[]): ScopeTree {
  const byId = new Map<ScopeId, Scope>();
  const childrenById = new Map<ScopeId, ScopeId[]>();

  // ── Pass 1: collect by id + duplicate check ───────────────────────────
  for (const scope of scopes) {
    if (byId.has(scope.id)) {
      throw new ScopeTreeInvariantError(
        'duplicate-scope-id',
        `Two scopes share id '${scope.id}'. Scope ids must be unique per tree.`,
      );
    }
    byId.set(scope.id, scope);
  }

  // ── Pass 2: validate parent pointers + build children buckets ─────────
  for (const scope of scopes) {
    if (scope.parent === null) {
      if (scope.kind !== 'Module') {
        throw new ScopeTreeInvariantError(
          'non-module-requires-parent',
          `Scope '${scope.id}' has kind '${scope.kind}' but no parent. Only 'Module' scopes may be root-level.`,
        );
      }
      continue;
    }

    const parent = byId.get(scope.parent);
    if (parent === undefined) {
      throw new ScopeTreeInvariantError(
        'parent-not-found',
        `Scope '${scope.id}' references parent '${scope.parent}' which is not part of this tree.`,
      );
    }
    if (parent.filePath !== scope.filePath) {
      throw new ScopeTreeInvariantError(
        'parent-must-share-filepath',
        `Scope '${scope.id}' (${scope.filePath}) has parent '${parent.id}' in a different file (${parent.filePath}). Parent/child scopes must share filePath.`,
      );
    }
    if (!canParentScope(parent.range, scope.range, parent.kind, scope.kind)) {
      throw new ScopeTreeInvariantError(
        'parent-must-contain-child',
        `Parent scope '${parent.id}' at ${formatRange(parent.range)} does not contain child '${scope.id}' at ${formatRange(scope.range)} (allowed: strict containment, or equal-range Module-as-parent).`,
      );
    }

    let bucket = childrenById.get(parent.id);
    if (bucket === undefined) {
      bucket = [];
      childrenById.set(parent.id, bucket);
    }
    bucket.push(scope.id);
  }

  // ── Pass 3: sibling-overlap check ─────────────────────────────────────
  for (const [parentId, childIds] of childrenById) {
    if (childIds.length < 2) continue;
    // Sort siblings by (startLine, startCol) for an O(n log n) pairwise
    // scan instead of O(n²) all-pairs.
    const children = childIds.map((id) => byId.get(id)!).slice();
    children.sort((a, b) => comparePosition(a.range, b.range));
    for (let i = 1; i < children.length; i++) {
      const prev = children[i - 1]!;
      const curr = children[i]!;
      if (rangesOverlap(prev.range, curr.range)) {
        throw new ScopeTreeInvariantError(
          'sibling-ranges-overlap',
          `Sibling scopes under parent '${parentId}' overlap: '${prev.id}' ${formatRange(prev.range)} and '${curr.id}' ${formatRange(curr.range)}.`,
        );
      }
    }
  }

  // Freeze children arrays so the surface is truly read-only.
  const frozenChildren = new Map<ScopeId, readonly ScopeId[]>();
  for (const [parentId, childIds] of childrenById) {
    frozenChildren.set(parentId, Object.freeze(childIds.slice()));
  }

  return freezeTree(byId, frozenChildren);
}

// ─── Internals ──────────────────────────────────────────────────────────────

const EMPTY_CHILDREN: readonly ScopeId[] = Object.freeze([]);

function freezeTree(
  byId: Map<ScopeId, Scope>,
  childrenById: Map<ScopeId, readonly ScopeId[]>,
): ScopeTree {
  return {
    byId,
    get size() {
      return byId.size;
    },
    getScope(id: ScopeId): Scope | undefined {
      return byId.get(id);
    },
    getParent(id: ScopeId): Scope | undefined {
      const scope = byId.get(id);
      if (scope === undefined || scope.parent === null) return undefined;
      return byId.get(scope.parent);
    },
    getChildren(id: ScopeId): readonly ScopeId[] {
      return childrenById.get(id) ?? EMPTY_CHILDREN;
    },
    getAncestors(id: ScopeId): readonly ScopeId[] {
      const start = byId.get(id);
      if (start === undefined || start.parent === null) return EMPTY_CHILDREN;
      const out: ScopeId[] = [];
      const visited = new Set<ScopeId>([id]);
      let cursor: ScopeId | null = start.parent;
      while (cursor !== null && !visited.has(cursor)) {
        visited.add(cursor);
        out.push(cursor);
        const next = byId.get(cursor);
        cursor = next === undefined ? null : next.parent;
      }
      return Object.freeze(out);
    },
    has(id: ScopeId): boolean {
      return byId.has(id);
    },
  };
}

/**
 * `outer` strictly contains `inner` when `outer`'s start is at or before
 * `inner`'s start, `outer`'s end is at or after `inner`'s end, and they are
 * not the exact same range. Equal ranges are rejected — a child cannot
 * occupy the exact same span as its parent.
 */
function rangeStrictlyContains(outer: Range, inner: Range): boolean {
  if (
    outer.startLine === inner.startLine &&
    outer.startCol === inner.startCol &&
    outer.endLine === inner.endLine &&
    outer.endCol === inner.endCol
  ) {
    return false;
  }
  const outerStartsAtOrBefore =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const outerEndsAtOrAfter =
    outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return outerStartsAtOrBefore && outerEndsAtOrAfter;
}

function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCol === b.startCol &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

/**
 * Whether `outer` (kind `outerKind`) is a valid parent for `inner` (kind
 * `innerKind`).
 *
 * Strict containment is the general rule. The single carve-out is the
 * `Module`/non-`Module` pair whose ranges are exactly equal — this happens
 * naturally when tree-sitter reports identical byte spans for the
 * `compilation_unit` (or equivalent file-root construct) and the file's
 * single top-level scope. Common shape: a C# file consisting of nothing
 * but `namespace X { ... }` with no leading or trailing trivia outside the
 * namespace's `{}` body — `compilation_unit` and `namespace_declaration`
 * both span exactly the same byte range. The `Module` is the universal
 * outer of any file-level scope by language semantics, so coincident
 * ranges should not break the parent chain.
 *
 * The carve-out is direction-asymmetric: only `Module`-as-outer parents a
 * same-range non-`Module`, never the reverse. This preserves the
 * acyclicity buildScopeTree relies on, and matches the corresponding
 * helper in `scope-extractor.ts` so `pass1BuildScopes` and the validator
 * agree on what a well-formed parent edge looks like.
 */
export function canParentScope(
  outer: Range,
  inner: Range,
  outerKind: Scope['kind'],
  innerKind: Scope['kind'],
): boolean {
  if (rangeStrictlyContains(outer, inner)) return true;
  if (outerKind === 'Module' && innerKind !== 'Module' && rangesEqual(outer, inner)) return true;
  return false;
}

/**
 * Two ranges overlap when neither finishes before the other begins. Ranges
 * that merely touch at a single boundary point (`a.end === b.start`) do
 * NOT overlap — this matches tree-sitter's half-open-like range semantics
 * and the typical "sibling blocks meet but don't overlap" pattern.
 */
function rangesOverlap(a: Range, b: Range): boolean {
  const aEndsBeforeB =
    a.endLine < b.startLine || (a.endLine === b.startLine && a.endCol <= b.startCol);
  const bEndsBeforeA =
    b.endLine < a.startLine || (b.endLine === a.startLine && b.endCol <= a.startCol);
  return !(aEndsBeforeB || bEndsBeforeA);
}

function comparePosition(a: Range, b: Range): number {
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.startCol - b.startCol;
}

function formatRange(r: Range): string {
  return `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;
}
