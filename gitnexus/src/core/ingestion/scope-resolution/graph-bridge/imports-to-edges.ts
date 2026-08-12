/**
 * File→File IMPORTS edge emission from a finalized `ImportEdge` map.
 *
 * Deduplicates by `(sourceFile, targetFile)` so multi-symbol imports
 * from the same module collapse to a single edge — matching the
 * legacy schema.
 *
 * Next-consumer contract: language-agnostic. Any provider with a
 * scope-resolution ImportEdge stream emits File→File edges via this
 * single function. The `reason` defaults to
 * `'scope-resolution: import'`; provider may override if downstream
 * filters on reason.
 *
 * ## Non-initializing imports carry a distinct `reason`
 *
 * A pair reached ONLY by imports that cannot run at module-initialization time
 * still gets an edge — it is a real dependency, and impact/trace must see it —
 * but it cannot participate in the kind of cycle `check --cycles` exists to
 * find. There are two such kinds, and they are NOT the same fact:
 *
 *  - **deferred** — the import exists at runtime, just later. `import('./m')`
 *    and a function-local `import` both really load the module; what they do
 *    not do is load it while the importing module is still initializing.
 *    Deferring is in fact the standard idiom for BREAKING an init cycle, and
 *    this repository uses it that way on purpose in both spellings:
 *    `core/group/service.ts` does `await import('./cross-impact.js')`, and
 *    `eval/workflow_bench/proposer_sandbox.py` puts a plain `import` inside a
 *    function under the comment "Kept lazy to avoid a module cycle".
 *  - **type-only** — the import does not exist at runtime AT ALL. `tsc` deletes
 *    `import type { X } from './m'`; the emitted JavaScript contains no
 *    reference to `./m`. Nothing was made later; the dependency is compile-time
 *    only. Eight of the ten false cycles this repository reports are this.
 *
 * Reporting either as an init cycle flags the fix as the bug. They get separate
 * suffixes rather than one shared "not really an import" tag because the two
 * answers to "does this edge exist when the program runs?" are opposite, and a
 * reader of the graph — or the next filter written against `reason` — needs to
 * be able to tell them apart.
 *
 * Three signals, because no one of them covers the others:
 *
 *  - `ImportEdge.kind === 'dynamic-resolved'` — TS/JS `import()`. Already on
 *    the edge; this function simply never read it.
 *  - the import is attached to a scope inside a `Function` — Python's
 *    `def f(): from x import Y`, Rust's fn-local `use`. Nothing marks those as
 *    dynamic, because syntactically they are ordinary imports; what defers them
 *    is WHERE they sit. See `isInsideFunction`.
 *  - `ImportEdge.typeOnly` — TypeScript `import type` / `import { type X }`.
 *    Neither of the other two sees it: the kind is the ordinary `named` /
 *    `alias`, and the statement sits at module top level like any other. Only
 *    the `type` keyword says it, so it is carried from the syntax down —
 *    `typescript/import-decomposer.ts` → `interpret.ts` → `finalize-algorithm.ts`.
 *
 * Tagging the reason is enough for the check query, which already filters
 * non-runtime edges that way (`markdown-link`, Swift implicit module
 * visibility) — no schema change, no new edge property.
 *
 * ponytail: reason-string tagging rather than a typed edge property, because
 * the one consumer already filters on `reason` and a property would touch the
 * relation schema. If a second consumer ever needs to branch on this, promote
 * it to a real field then.
 *
 * ## Precedence: the strongest runtime presence in a pair wins
 *
 * Emission dedupes by `(sourceFile, targetFile)`, so one edge has to speak for
 * every import that reaches the pair. Rank them by how much of the dependency
 * survives to run time — initializing > deferred > erased — and let the
 * strongest win: the ranks ascend as presence weakens, so the pair keeps the
 * LOWEST rank it sees ({@link PRESENCE_INITIALIZES} is 0). Inverting that
 * comparison is the one mutation here that hides a real cycle rather than
 * inventing a false one, which is why the suite pins it directly.
 *
 *  - Any initializing import wins outright. One top-level `import { f }` beside
 *    an `await import()` and a dozen `import type`s is a real init dependency;
 *    reporting the pair as deferred or erased would HIDE a true cycle.
 *  - Deferred beats type-only. A pair with a function-local import plus some
 *    `import type`s does load the target at run time, so `(deferred)` is the
 *    honest label; `(type-only)` would claim the module never loads.
 *
 * That also settles the mixed statement `import { type X, Y } from './m'`
 * without the decomposer aggregating anything: `X` is erased, `Y` is not, and
 * `Y` carries the pair. A statement is type-only exactly when every specifier
 * it decomposes to is.
 *
 * Pairs are collected before anything is emitted so the ranking sees every
 * contributing edge rather than whichever one arrived first. Insertion order
 * into the map is first-seen order, so emission order is byte-identical to the
 * single-pass form this replaced.
 */

import type { ImportEdge, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';

/**
 * Reason suffix for a pair reachable only through imports that run later —
 * `import()` and function-local imports.
 *
 * `check --cycles` matches this EXACTLY, so a provider that overrides the base
 * reason keeps its deferred edges filterable — the suffix travels with it.
 */
export const DEFERRED_IMPORT_REASON_SUFFIX = ' (deferred)';

/**
 * Reason suffix for a pair reachable only through imports the compiler erases —
 * TypeScript `import type` / `import { type X }`.
 *
 * A second suffix rather than a reuse of {@link DEFERRED_IMPORT_REASON_SUFFIX}:
 * both are excluded from the cycle query, but "runs later" and "never runs" are
 * opposite answers about the emitted program, and the reason string is the only
 * place the graph records which one this pair is.
 */
export const TYPE_ONLY_IMPORT_REASON_SUFFIX = ' (type-only)';

/** Parent-chain cap. Scope depth is small; this only bounds a corrupt tree. */
const MAX_SCOPE_DEPTH = 512;

/**
 * How much of an import survives to run time. Lower is stronger; a pair takes
 * the minimum over every edge that reaches it. See the precedence section in
 * the module header for why the order is this one.
 */
const PRESENCE_INITIALIZES = 0;
const PRESENCE_DEFERRED = 1;
const PRESENCE_ERASED = 2;

/** Suffix for a pair's winning presence; `''` for a real init dependency. */
function reasonSuffixFor(presence: number): string {
  if (presence === PRESENCE_ERASED) return TYPE_ONLY_IMPORT_REASON_SUFFIX;
  if (presence === PRESENCE_DEFERRED) return DEFERRED_IMPORT_REASON_SUFFIX;
  return '';
}

/**
 * Does this scope only execute when something calls it?
 *
 * Walks to the file root rather than reading the immediate kind, because the
 * immediate kind is not enough in either direction. A `Block` at the top of a
 * module (`if (FLAG) { require('./x'); }`) runs during initialization; the same
 * `Block` inside a function does not. `Class` and `Namespace` bodies execute
 * where they are defined, so they are init-time too. Only an enclosing
 * `Function` — anywhere up the chain — defers execution.
 *
 * This is the language-agnostic half of the deferred rule, and it is what
 * catches Python's `def f(): from x import Y` (a plain import statement that no
 * `kind` marks as dynamic) and Rust's fn-local `use`. `Scope.imports` already
 * documents those two as the reason local imports exist.
 */
function isInsideFunction(
  scopeTree: ScopeResolutionIndexes['scopeTree'],
  scopeId: ScopeId,
): boolean {
  let current: ScopeId | null = scopeId;
  for (let depth = 0; current !== null && depth < MAX_SCOPE_DEPTH; depth++) {
    const scope = scopeTree.getScope(current);
    if (scope === undefined) return false;
    if (scope.kind === 'Function') return true;
    current = scope.parent;
  }
  return false;
}

export function emitImportEdges(
  graph: KnowledgeGraph,
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
  scopeTree: ScopeResolutionIndexes['scopeTree'],
  reason = 'scope-resolution: import',
): number {
  /** dedupKey -> the pair, plus the strongest runtime presence reaching it. */
  const pairs = new Map<
    string,
    { readonly sourceFile: string; readonly targetFile: string; presence: number }
  >();

  for (const [scopeId, edges] of imports) {
    const scope = scopeTree.getScope(scopeId);
    if (scope === undefined) continue;
    const sourceFile = scope.filePath;
    // Once per scope, not once per edge — every edge in this bucket shares it.
    const scopeDefers = isInsideFunction(scopeTree, scopeId);

    for (const edge of edges) {
      if (edge.targetFile === null) continue;
      if (edge.targetFile === sourceFile) continue;

      // Erasure is checked first: an `import type` inside a function is still
      // erased, not merely deferred, and the two are not mutually exclusive.
      const presence =
        edge.typeOnly === true
          ? PRESENCE_ERASED
          : scopeDefers || edge.kind === 'dynamic-resolved'
            ? PRESENCE_DEFERRED
            : PRESENCE_INITIALIZES;
      const dedupKey = `${sourceFile}->${edge.targetFile}`;
      const existing = pairs.get(dedupKey);
      if (existing === undefined) {
        pairs.set(dedupKey, { sourceFile, targetFile: edge.targetFile, presence });
      } else if (presence < existing.presence) {
        existing.presence = presence;
      }
    }
  }

  for (const [dedupKey, pair] of pairs) {
    graph.addRelationship({
      id: generateId('IMPORTS', dedupKey),
      sourceId: generateId('File', pair.sourceFile),
      targetId: generateId('File', pair.targetFile),
      type: 'IMPORTS',
      confidence: 1.0,
      reason: reason + reasonSuffixFor(pair.presence),
    });
  }

  return pairs.size;
}
