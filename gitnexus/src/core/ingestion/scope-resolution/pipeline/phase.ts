/**
 * Phase: scopeResolution
 *
 * Generic registry-primary resolution phase (RFC #909 Ring 3).
 *
 * For every language in `MIGRATED_LANGUAGES` (per-language flag set)
 * whose provider is registered in `SCOPE_RESOLVERS`:
 *   1. Filter scanned files by language extension.
 *   2. Read file contents.
 *   3. Drive the scope-based pipeline end-to-end via the generic
 *      `runScopeResolution(input, provider)` orchestrator.
 *   4. Emit IMPORTS / CALLS / ACCESSES / INHERITS / USES edges.
 *
 * Pairs with the per-language gates in `import-processor.ts` and
 * `call-processor.ts` that skip files when their language is registry-
 * primary, so we don't double-emit edges from both code paths.
 *
 * Adding a language is two changes:
 *   - Implement `ScopeResolver` in `languages/<lang>/scope-resolver.ts`
 *     and register it in `scope-resolution/pipeline/registry.ts`.
 *   - Add the language to `MIGRATED_LANGUAGES` in
 *     `registry-primary-flag.ts`.
 *
 * @deps    parse  (needs Symbol nodes already in the graph so emit-references
 *                  can attach edges to existing Function/Method/Class nodes)
 * @reads   scannedFiles
 * @writes  graph (IMPORTS, CALLS, ACCESSES, INHERITS, USES)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from '../../pipeline-phases/types.js';
import { getPhaseOutput } from '../../pipeline-phases/types.js';
import type { StructureOutput } from '../../pipeline-phases/structure.js';
import type { ParseOutput } from '../../pipeline-phases/parse.js';
import { isRegistryPrimary } from '../../registry-primary-flag.js';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../../filesystem-walker.js';
import { runScopeResolution } from './run.js';
import { SCOPE_RESOLVERS } from './registry.js';
import { isDev } from '../../utils/env.js';

export interface ScopeResolutionOutput {
  /** True when at least one language ran. */
  readonly ran: boolean;
  /** Files seen across all languages. `0` when `ran === false`. */
  readonly filesProcessed: number;
  /** IMPORTS edges emitted across all languages. */
  readonly importsEmitted: number;
  /** Reference (CALLS / ACCESSES / INHERITS / USES) edges emitted. */
  readonly referenceEdgesEmitted: number;
  /** Per-language breakdown for telemetry / shadow-parity. */
  readonly perLanguage: ReadonlyMap<
    SupportedLanguages,
    {
      readonly filesProcessed: number;
      readonly importsEmitted: number;
      readonly referenceEdgesEmitted: number;
    }
  >;
}

const NOOP_OUTPUT: ScopeResolutionOutput = Object.freeze({
  ran: false,
  filesProcessed: 0,
  importsEmitted: 0,
  referenceEdgesEmitted: 0,
  perLanguage: new Map(),
});

export const scopeResolutionPhase: PipelinePhase<ScopeResolutionOutput> = {
  name: 'scopeResolution',
  // Depends on `parse` because emit-references attaches edges to
  // already-existing Symbol nodes (Function/Method/Class). The legacy
  // `parse` phase still creates those nodes; we only replace the
  // import + call resolution layer.
  //
  // Also depends on `crossFile` — we don't read crossFile's output
  // directly (we have our own cross-file resolution), but crossFile
  // writes EXTENDS edges that `buildMro` consumes via
  // `iterRelationshipsByType('EXTENDS')`. Declaring the dep pins the
  // ordering explicitly: without it, Kahn's runner could schedule
  // scopeResolution before crossFile (both unblock after parse), and
  // the MRO walk would miss heritage edges crossFile later adds.
  deps: ['parse', 'crossFile', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ScopeResolutionOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    // Reach into the parse phase's AST cache so per-file extract can
    // skip a second tree-sitter parse. Cache miss is safe (re-parses).
    // Worker-mode parses leave the cache empty for those files; they
    // also fall back to a fresh parse — no correctness impact.
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const { scopeTreeCache, resolutionContext } = parseOutput;
    // SemanticModel populated during `parse`: scope-resolution consumes
    // TypeRegistry / MethodRegistry / SymbolTable lookups instead of
    // rebuilding parallel indexes. See ARCHITECTURE.md § "Semantic-model
    // source of truth".
    const model = resolutionContext.model;

    let totalFiles = 0;
    let totalImports = 0;
    let totalRefs = 0;
    let anyRan = false;
    const perLanguage = new Map<
      SupportedLanguages,
      {
        readonly filesProcessed: number;
        readonly importsEmitted: number;
        readonly referenceEdgesEmitted: number;
      }
    >();

    for (const [lang, provider] of SCOPE_RESOLVERS) {
      if (!isRegistryPrimary(lang)) continue;

      const langFiles = scannedFiles.filter((f) => getLanguageFromFilename(f.path) === lang);
      if (langFiles.length === 0) continue;

      const filePaths = langFiles.map((f) => f.path);
      const contents = await readFileContents(ctx.repoPath, filePaths);
      const files: { path: string; content: string }[] = [];
      for (const fp of filePaths) {
        const content = contents.get(fp);
        if (content !== undefined) files.push({ path: fp, content });
      }

      const stats = runScopeResolution(
        {
          graph: ctx.graph,
          model,
          files,
          treeCache: scopeTreeCache,
          onWarn: (msg) => {
            if (isDev) console.warn(`[scope-resolution:${lang}] ${msg}`);
          },
        },
        provider,
      );

      anyRan = true;
      totalFiles += stats.filesProcessed;
      totalImports += stats.importsEmitted;
      totalRefs += stats.referenceEdgesEmitted;
      perLanguage.set(lang, {
        filesProcessed: stats.filesProcessed,
        importsEmitted: stats.importsEmitted,
        referenceEdgesEmitted: stats.referenceEdgesEmitted,
      });

      if (isDev) {
        console.log(
          `[scope-resolution:${lang}] ${stats.filesProcessed} files → ${stats.importsEmitted} IMPORTS + ${stats.referenceEdgesEmitted} reference edges (${stats.resolve.unresolved} unresolved sites, ${stats.referenceSkipped} skipped)`,
        );
      }
    }

    // Dispose the cross-phase Tree cache — scope-resolution is the
    // only consumer. Holding Trees past this point is pure memory
    // pressure: downstream phases (mro, community, csv-generator)
    // never read them, and tree-sitter Trees hold native-heap memory
    // under WASM runtimes. ASTCache.clear() fires the LRU dispose
    // handler which calls tree.delete?.() on each retained Tree.
    scopeTreeCache.clear();

    if (!anyRan) return NOOP_OUTPUT;

    return {
      ran: true,
      filesProcessed: totalFiles,
      importsEmitted: totalImports,
      referenceEdgesEmitted: totalRefs,
      perLanguage,
    };
  },
};
