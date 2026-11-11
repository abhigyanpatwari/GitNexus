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
 * Three signals, because no one of them covers the others. All three ride the
 * EDGE — this function reads properties and never walks the scope tree for
 * them, for the reason spelled out under "Why nothing here is derived from the
 * scope tree" below:
 *
 *  - `ImportEdge.kind === 'dynamic-resolved'` — TS/JS `import()`.
 *  - `ImportEdge.runsOnlyWhenCalled` — the import sits inside a function body
 *    AND this language's imports execute where they are written: Python's
 *    `def f(): from x import Y`, Ruby's `def f; require 'x'; end`, a CommonJS
 *    `require()` in a body. Nothing marks those as dynamic, because
 *    syntactically they are ordinary imports; what defers them is WHERE they
 *    sit, so `scope-extractor.ts` decides it in Pass 3 and it is carried down
 *    — `ParsedImport` → `finalize-algorithm.ts` → the edge. A language whose
 *    imports do not execute never gets the tag no matter where one sits (Rust
 *    `use`, C/C++ `#include`; see
 *    `LanguageProvider.importsExecuteWhereWritten`).
 *  - `ImportEdge.typeOnly` — TypeScript `import type` / `import { type X }`.
 *    Neither of the other two sees it: the kind is the ordinary `named` /
 *    `alias`, and the statement sits at module top level like any other. Only
 *    the `type` keyword says it, so it is carried from the syntax down —
 *    `typescript/import-decomposer.ts` → `interpret.ts` → `finalize-algorithm.ts`.
 *
 * ## Why nothing here is derived from the scope tree
 *
 * `scopeTree` is used for exactly one thing: turning the map's key into the
 * source `filePath`. It is NOT a place to ask where an import was written.
 * The finalizer publishes binding-scope buckets consecutively per file. Some
 * providers bind imports in the module scope, others in lexical scopes; neither
 * choice alone establishes whether an import executes during initialization.
 * That fact arrives as `runsOnlyWhenCalled`, decided during extraction.
 *
 * Tagging the reason is enough for the check query, which already filters
 * non-runtime edges that way (`markdown-link`, Swift implicit module
 * visibility) — no change to the persisted RELATION schema, no new property on
 * the emitted `CodeRelation`. (`typeOnly` and `runsOnlyWhenCalled` are fields
 * on the in-memory `ImportEdge`, which is never persisted; they end here.)
 *
 * ponytail: reason-string tagging rather than a typed relation property,
 * because the one consumer already filters on `reason` and a property would
 * touch the relation schema. If a second consumer ever needs to branch on this,
 * promote it to a real field then.
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
 *  - The two deferred signals rank the same. `import()` and a function-local
 *    import are the same claim about the emitted program — it loads, later —
 *    so a pair reached only by them is `(deferred)` either way.
 *
 * That also settles the mixed statement `import { type X, Y } from './m'`
 * without the decomposer aggregating anything: `X` is erased, `Y` is not, and
 * `Y` carries the pair. A statement is type-only exactly when every specifier
 * it decomposes to is.
 *
 * All scopes of a source file are collected before that file's pairs are
 * emitted. The finalizer groups scopes by file, so this preserves first-seen
 * pair order while retaining only one file's pairs. Interleaved source files
 * retain the global collector, as do source paths containing the legacy `->`
 * pair-key delimiter: partitioning those keys could change collision behavior.
 */

import type { ImportEdge, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';
import { isDebugHeapEnabled, logHeapProbe } from '../../utils/heap-probe.js';

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

/**
 * Dart pubspec identity edges are incremental metadata, not initialization
 * edges. Kept here so the cycle query can name the reason without importing
 * a language provider into MCP startup.
 */
export const DART_PACKAGE_IDENTITY_REASON = 'dart-scope: package identity dependency';

/**
 * How much of an import survives to run time. Lower is stronger; a pair takes
 * the minimum over every edge that reaches it. See the precedence section in
 * the module header for why the order is this one.
 */
const PRESENCE_INITIALIZES = 0;
const PRESENCE_DEFERRED = 1;
const PRESENCE_ERASED = 2;

/**
 * How much of an import survives to run time, as a rank. Narrower than
 * `number` on purpose: the ordering IS the semantics, so a value outside the
 * three would silently take the `''` arm below — which labels the pair a real
 * initialization dependency and is the direction that hides a cycle.
 */
type ImportPresence =
  | typeof PRESENCE_INITIALIZES
  | typeof PRESENCE_DEFERRED
  | typeof PRESENCE_ERASED;

/**
 * Suffix per presence rank; the empty string is a real init dependency.
 *
 * Indexed rather than branched so the rank order lives in exactly one place —
 * the constants above — instead of being restated by the order of an if-chain.
 */
const REASON_SUFFIX_BY_PRESENCE: Readonly<Record<ImportPresence, string>> = {
  [PRESENCE_INITIALIZES]: '',
  [PRESENCE_DEFERRED]: DEFERRED_IMPORT_REASON_SUFFIX,
  [PRESENCE_ERASED]: TYPE_ONLY_IMPORT_REASON_SUFFIX,
};

export function emitImportEdges(
  graph: KnowledgeGraph,
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
  scopeTree: ScopeResolutionIndexes['scopeTree'],
  reason = 'scope-resolution: import',
): number {
  const debug = isDebugHeapEnabled();
  const started = debug ? Date.now() : 0;
  let scanned = 0;
  let emitted = 0;
  const probe = (stage: string, detail = ''): void => {
    if (debug)
      logHeapProbe(
        `sr-emit-imports-${stage}`,
        `elapsed_ms=${Date.now() - started} scanned=${scanned} emitted=${emitted} ${detail}`,
      );
  };
  probe('start', `scopes=${imports.size}`);

  // Read each scope once, retaining only its path. This also avoids decoding
  // disk-backed scope shards again during emission. Check grouping BEFORE any
  // edge is written: a later scope can strengthen an earlier pair's reason.
  const sourceByScope = new Map<ScopeId, string>();
  const seenFiles = new Set<string>();
  let previousFile: string | undefined;
  let grouped = true;
  let scopesScanned = 0;
  for (const scopeId of imports.keys()) {
    const scope = scopeTree.getScope(scopeId);
    if (scope !== undefined) {
      const sourceFile = scope.filePath;
      sourceByScope.set(scopeId, sourceFile);
      if (sourceFile.includes('->')) grouped = false;
      if (sourceFile !== previousFile) {
        if (seenFiles.has(sourceFile)) grouped = false;
        seenFiles.add(sourceFile);
        previousFile = sourceFile;
      }
    }
    if (debug && ++scopesScanned % 1024 === 0) probe('plan-progress', `scopes=${scopesScanned}`);
  }
  seenFiles.clear();
  probe('plan-end', `mode=${grouped ? 'per-file' : 'global'} scopes=${sourceByScope.size}`);

  const emitPair = (sourceFile: string, targetFile: string, presence: ImportPresence): void => {
    graph.addRelationship({
      id: generateId('IMPORTS', `${sourceFile}->${targetFile}`),
      sourceId: generateId('File', sourceFile),
      targetId: generateId('File', targetFile),
      type: 'IMPORTS',
      confidence: 1.0,
      reason: reason + REASON_SUFFIX_BY_PRESENCE[presence],
    });
    emitted++;
    if (debug && emitted % 65536 === 0) probe('emit-progress');
  };

  if (grouped) {
    const pairs = new Map<string, ImportPresence>();
    let sourceFile: string | undefined;
    const flush = (): void => {
      if (sourceFile === undefined) return;
      for (const [targetFile, presence] of pairs) emitPair(sourceFile, targetFile, presence);
      pairs.clear();
    };
    for (const [scopeId, edges] of imports) {
      const nextFile = sourceByScope.get(scopeId);
      if (nextFile === undefined) continue;
      if (nextFile !== sourceFile) {
        flush();
        sourceFile = nextFile;
      }
      for (const edge of edges) {
        if (debug && ++scanned % 65536 === 0) probe('collect-progress', `pairs=${pairs.size}`);
        if (edge.targetFile === null || edge.targetFile === sourceFile) continue;
        const presence = importPresence(edge);
        const existing = pairs.get(edge.targetFile);
        if (existing === undefined || presence < existing) pairs.set(edge.targetFile, presence);
      }
    }
    flush();
    probe('complete');
    return emitted;
  }

  // Compatibility path for callers whose buckets interleave source files or
  // whose source paths can collide under the existing compound pair key.
  const pairs = new Map<
    string,
    { readonly sourceFile: string; readonly targetFile: string; presence: ImportPresence }
  >();

  for (const [scopeId, edges] of imports) {
    const sourceFile = sourceByScope.get(scopeId);
    if (sourceFile === undefined) continue;

    for (const edge of edges) {
      if (debug && ++scanned % 65536 === 0) probe('collect-progress', `pairs=${pairs.size}`);
      if (edge.targetFile === null) continue;
      if (edge.targetFile === sourceFile) continue;

      const presence = importPresence(edge);
      const dedupKey = `${sourceFile}->${edge.targetFile}`;
      const existing = pairs.get(dedupKey);
      if (existing === undefined) {
        pairs.set(dedupKey, { sourceFile, targetFile: edge.targetFile, presence });
      } else if (presence < existing.presence) {
        existing.presence = presence;
      }
    }
  }

  probe('collected', `pairs=${pairs.size}`);
  for (const pair of pairs.values()) emitPair(pair.sourceFile, pair.targetFile, pair.presence);
  probe('complete');
  return emitted;
}

function importPresence(edge: ImportEdge): ImportPresence {
  // Erasure wins even when the same import is also marked deferred.
  return edge.typeOnly === true
    ? PRESENCE_ERASED
    : edge.runsOnlyWhenCalled === true || edge.kind === 'dynamic-resolved'
      ? PRESENCE_DEFERRED
      : PRESENCE_INITIALIZES;
}
