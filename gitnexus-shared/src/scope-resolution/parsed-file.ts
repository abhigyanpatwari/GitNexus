/**
 * `ParsedFile` — the per-file artifact produced by `ScopeExtractor`
 * (RFC §3.2 Phase 1; Ring 2 PKG #919).
 *
 * The boundary between Phase 1 (extraction, per-file, parallelizable) and
 * Phase 2 (finalize, cross-file). One `ParsedFile` is emitted per source
 * file; the finalize orchestrator (#921) collects them into a workspace-
 * wide set and feeds them to the shared `finalize` algorithm (#915).
 *
 * ## Shape
 *
 *   - `scopes`           — every `Scope` created for this file, in tree-
 *                          topological order (module first, then children).
 *                          `Scope.bindings` carry **local-only** bindings at
 *                          this stage; finalize merges imports/wildcards on top.
 *   - `parsedImports`    — raw `ParsedImport[]` for this file; finalize
 *                          resolves each to a concrete `ImportEdge`.
 *   - `localDefs`        — defs structurally declared in this file. A
 *                          superset of every `Scope.ownedDefs` union.
 *                          Listed separately so `finalize` can dedup-index
 *                          without re-walking scopes.
 *   - `referenceSites`   — pre-resolution usage facts; populated by the
 *                          resolution phase into `ReferenceIndex`.
 *
 * ## What `ParsedFile` deliberately does NOT carry
 *
 *   - Linked `ImportEdge`s. Those are finalize output.
 *   - A `ScopeTree` instance. Callers build one from `scopes` (cheap —
 *     `buildScopeTree(parsedFile.scopes)`). Keeping the ParsedFile flat
 *     makes IPC serialization from worker threads straightforward.
 *   - Merged module-scope bindings. Finalize owns that materialization.
 *
 * ## Compatibility with `FinalizeFile`
 *
 * `FinalizeFile` (defined in `./finalize-algorithm.ts`) is a structural
 * subset of `ParsedFile` — `filePath`, `moduleScope`, `parsedImports`,
 * `localDefs`. A `ParsedFile` is trivially convertible to a `FinalizeFile`
 * by picking those four fields, so the finalize orchestrator threads
 * ParsedFile through to the shared algorithm without shape-shifting.
 */

import type { Scope, ScopeId } from './types.js';
import type { ParsedImport } from './types.js';
import type { SymbolDefinition } from './symbol-definition.js';
import type { ReferenceSite } from './reference-site.js';

export interface ParsedFile {
  readonly filePath: string;
  /** `Scope.id` of the file's root `Module` scope. */
  readonly moduleScope: ScopeId;
  /**
   * All scopes in this file, typically emitted in tree-topological order.
   * Caller reconstructs a `ScopeTree` via `buildScopeTree(scopes)` when
   * navigation or invariant re-validation is needed.
   */
  readonly scopes: readonly Scope[];
  readonly parsedImports: readonly ParsedImport[];
  /**
   * All defs structurally declared in this file (classes, methods, fields,
   * variables). Mirrors the union of `Scope.ownedDefs` across `scopes`,
   * pre-flattened for O(N) consumption by finalize.
   */
  readonly localDefs: readonly SymbolDefinition[];
  readonly referenceSites: readonly ReferenceSite[];
}
