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
 * ## Deferred imports carry a distinct `reason`
 *
 * A pair reached ONLY by a deferred import still gets an edge — it is a real
 * dependency, and impact/trace must see it — but it is not a module-INIT
 * dependency, so it cannot participate in the kind of cycle `check --cycles`
 * exists to find. Deferring is in fact the standard idiom for BREAKING such a
 * cycle, and this repository uses it that way on purpose in both spellings:
 * `core/group/service.ts` does `await import('./cross-impact.js')`, and
 * `eval/workflow_bench/proposer_sandbox.py` puts a plain `import` inside a
 * function under the comment "Kept lazy to avoid a module cycle". Reporting
 * those as cycles flags the fix as the bug.
 *
 * Two signals, because one does not cover both spellings:
 *
 *  - `ImportEdge.kind === 'dynamic-resolved'` — TS/JS `import()`. Already on
 *    the edge; this function simply never read it.
 *  - the import is attached to a scope inside a `Function` — Python's
 *    `def f(): from x import Y`, Rust's fn-local `use`. Nothing marks those as
 *    dynamic, because syntactically they are ordinary imports; what defers them
 *    is WHERE they sit. See `isInsideFunction`.
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
 * Static wins a mixed pair. Emission dedupes by `(sourceFile, targetFile)`,
 * so a pair carrying BOTH a static and a deferred import must be reported as
 * static — one `await import()` beside a top-level import does not make the
 * dependency deferred. That is why the pairs are collected before anything is
 * emitted rather than tagged from whichever edge happened to arrive first.
 * Insertion order into the map is first-seen order, so emission order is
 * byte-identical to the single-pass form it replaces.
 */

import type { ImportEdge, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';

/**
 * Reason suffix for a pair reachable only through `import()`.
 *
 * `check --cycles` matches this EXACTLY, so a provider that overrides the base
 * reason keeps its deferred edges filterable — the suffix travels with it.
 */
export const DEFERRED_IMPORT_REASON_SUFFIX = ' (deferred)';

/** Parent-chain cap. Scope depth is small; this only bounds a corrupt tree. */
const MAX_SCOPE_DEPTH = 512;

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
  /** dedupKey -> the pair, plus whether EVERY edge reaching it is deferred. */
  const pairs = new Map<
    string,
    { readonly sourceFile: string; readonly targetFile: string; deferredOnly: boolean }
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

      const deferred = scopeDefers || edge.kind === 'dynamic-resolved';
      const dedupKey = `${sourceFile}->${edge.targetFile}`;
      const existing = pairs.get(dedupKey);
      if (existing === undefined) {
        pairs.set(dedupKey, { sourceFile, targetFile: edge.targetFile, deferredOnly: deferred });
      } else if (!deferred) {
        existing.deferredOnly = false;
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
      reason: pair.deferredOnly ? reason + DEFERRED_IMPORT_REASON_SUFFIX : reason,
    });
  }

  return pairs.size;
}
