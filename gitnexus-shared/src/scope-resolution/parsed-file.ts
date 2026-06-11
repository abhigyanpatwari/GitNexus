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
 *
 * ## Source-of-truth invariant
 *
 * `ParsedFile` is the single semantic model consumed by both the legacy
 * DAG (`gitnexus/src/core/ingestion/` outside `scope-resolution/`) and
 * the scope-resolution pipeline (`gitnexus/src/core/ingestion/scope-resolution/`).
 * Downstream passes MUST NOT build a parallel parse representation; if
 * a pass needs AST-level facts that `ParsedFile` doesn't expose, it
 * should reuse the orchestrator's `treeCache` rather than re-invoke
 * `parser.parse(...)` on its own. See the
 * `ScopeResolver` contract (`gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts`)
 * for the full list of invariants downstream consumers rely on.
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
  /**
   * Opaque, language-private serialization of capture-time side-channel
   * state that a provider's `emitScopeCaptures` populates into module-level
   * maps as a SIDE EFFECT (not onto the scopes/defs of this `ParsedFile`).
   *
   * Such state is computed inside the parse worker (where `emitScopeCaptures`
   * runs) and would otherwise be lost across the worker→main MessageChannel
   * and the disk store, because scope-resolution reuses the serialized
   * `ParsedFile` and SKIPS re-extraction on the main thread (#1983 — the
   * whole point is to avoid a main-thread tree-sitter re-parse). Carrying the
   * data here lets the main thread repopulate those maps WITHOUT re-parsing.
   *
   * Shared / ingestion code treats this as opaque (`unknown`) per AGENTS.md
   * (no language names in shared code). The producing language fills it via
   * the `LanguageProvider.collectCaptureSideChannel` hook (worker side) and
   * consumes it via the `ScopeResolver.applyCaptureSideChannel` hook
   * (main-thread resolution side). It MUST be plain JSON-serializable data
   * (objects / arrays / primitives) so it round-trips through the disk-backed
   * `parsedfile-store` (JSON.stringify + interning reviver).
   *
   * Optional: providers whose `emitScopeCaptures` is pure (no module-level
   * side effects — the contract default) leave this undefined.
   */
  readonly captureSideChannel?: unknown;

  /**
   * Per-function control-flow graphs for this file (#2081 M1, PDG/taint
   * substrate). A DISTINCT field from {@link captureSideChannel} — different
   * producer, consumer, and lifecycle: the worker builds it from the
   * tree-sitter AST via `LanguageProvider.cfgVisitor` (only on a `--pdg` run),
   * and scope-resolution emits BasicBlock nodes + CFG edges from it while the
   * disk-backed ParsedFile store is still live (it is NOT a capture-time
   * marker the resolver restores into module maps). Kept separate so a future
   * change to either channel's shape invalidates independently.
   *
   * Shared / ingestion code treats this as opaque (`unknown`) per AGENTS.md.
   * Concretely it is a `readonly FunctionCfg[]` (see
   * `core/ingestion/cfg/types.ts`) — plain JSON-serializable data (no AST
   * refs, no class instances) so it round-trips through the parse cache and
   * the `parsedfile-store` (whose interning reviver keys on `nodeId`, which
   * these blocks/edges deliberately lack).
   *
   * Optional: `undefined` on non-`--pdg` runs and for languages with no
   * `cfgVisitor` — the default for every run today.
   */
  readonly cfgSideChannel?: unknown;
}
