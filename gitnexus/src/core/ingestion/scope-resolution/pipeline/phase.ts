/**
 * Phase: scopeResolution
 *
 * Generic registry-primary resolution phase (RFC #909 Ring 3).
 *
 * For every language whose provider is registered in `SCOPE_RESOLVERS`:
 *   1. Filter scanned files by language extension.
 *   2. Read file contents.
 *   3. Drive the scope-based pipeline end-to-end via the generic
 *      `runScopeResolution(input, provider)` orchestrator.
 *   4. Emit IMPORTS / CALLS / ACCESSES / INHERITS / USES edges.
 *
 * This is the sole resolution path — RING4-1 (#942) deleted the legacy
 * call-resolution DAG, so there is no longer a per-language flag gating
 * registry-vs-legacy.
 *
 * Adding a language is one change: implement `ScopeResolver` in
 * `languages/<lang>/scope-resolver.ts` and register it in
 * `scope-resolution/pipeline/registry.ts`.
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
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../../filesystem-walker.js';
import { runScopeResolution, type ScopeResolutionSubPhase } from './run.js';
import { isLanguageAvailable } from '../../../tree-sitter/parser-loader.js';
import { buildGraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { SCOPE_RESOLVERS } from './registry.js';
import { isDev, isSemanticModelValidatorEnabled } from '../../utils/env.js';
import { logHeapProbe } from '../../utils/heap-probe.js';
import {
  clearParsedFileStore,
  loadParsedFilesForPaths,
  forceGc,
} from '../../../../storage/parsedfile-store.js';
import type { ResolutionOutcome } from '../resolution-outcome.js';

import { logger } from '../../../logger.js';
export interface ScopeResolutionOutput {
  /** True when at least one language ran. */
  readonly ran: boolean;
  /** Files seen across all languages. `0` when `ran === false`. */
  readonly filesProcessed: number;
  /** IMPORTS edges emitted across all languages. */
  readonly importsEmitted: number;
  /** Reference (CALLS / ACCESSES / INHERITS / USES) edges emitted. */
  readonly referenceEdgesEmitted: number;
  /** Additive stream of resolver diagnostics; does not affect graph edges. */
  readonly resolutionOutcomes: readonly ResolutionOutcome[];
  /** Per-language breakdown for telemetry. */
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
  resolutionOutcomes: [],
  perLanguage: new Map(),
});

export const scopeResolutionPhase: PipelinePhase<ScopeResolutionOutput> = {
  name: 'scopeResolution',
  // Depends on `parse` because emit-references attaches edges to
  // already-existing Symbol nodes (Function/Method/Class) that the `parse`
  // phase creates.
  //
  // The `crossFile` dep is retained for stable ordering but is no longer
  // load-bearing: inheritance (EXTENDS/IMPLEMENTS) edges are now emitted by
  // this phase's own `preEmitInheritanceEdges` before `buildMro` runs, and
  // since RING4-1 (#942) `crossFile` only disposes the BindingAccumulator
  // (the legacy cross-file re-resolution it used to run was deleted with the
  // call-resolution DAG).
  deps: ['parse', 'crossFile', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ScopeResolutionOutput> {
    logHeapProbe('scopeResolution-enter');
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const { model, parsedFiles: workerParsedFiles } = parseOutput;
    // SemanticModel populated during `parse`: scope-resolution consumes
    // TypeRegistry / MethodRegistry / SymbolTable lookups instead of
    // rebuilding parallel indexes. See ARCHITECTURE.md § "Semantic-model
    // source of truth".

    // Build a per-file lookup of ParsedFile artifacts the workers (or
    // sequential extracts) already produced. Threading this into
    // `runScopeResolution` lets the per-language extract loop short-
    // circuit `extractParsedFile` — the dominant cost on the warm-cache
    // path, since workers can't return tree-sitter Trees across the
    // MessageChannel and scope-resolution would otherwise re-parse
    // every file from scratch on the main thread.
    const preExtractedByPath = new Map<string, import('gitnexus-shared').ParsedFile>();
    for (const pf of workerParsedFiles) {
      preExtractedByPath.set(pf.filePath, pf);
    }

    // Disk-backed ParsedFile store (#1983): on huge repos the parse phase
    // flushes worker-produced ParsedFiles to disk (instead of `workerParsedFiles`
    // heap) and we stream them back here per language. Reusing them means
    // scope-resolution does ZERO tree-sitter parsing on the main thread, which
    // is what eliminates the unbounded native re-parse leak that OOM'd large
    // analyses. `undefined` when no storage path (tests / direct calls) — those
    // runs use the in-heap `workerParsedFiles` above or fall back to a fresh
    // extract per file inside runScopeResolution.
    const parsedFileStorePath = ctx.options?.parseCache?.storagePath;

    // Drop pre-extracted entries for standalone providers — these
    // languages are skipped by the canonical guard below (line 164)
    // and never consume preExtractedByPath, so holding onto their
    // entries leaks memory until the cleanup loop at 262-264 which
    // also never runs for skipped providers.
    for (const [path] of preExtractedByPath) {
      const lang = getLanguageFromFilename(path);
      if (lang === null) continue;
      const provider = SCOPE_RESOLVERS.get(lang);
      if (provider?.languageProvider.parseStrategy === 'standalone') {
        preExtractedByPath.delete(path);
      }
    }

    let totalFiles = 0;
    let totalImports = 0;
    let totalRefs = 0;
    let anyRan = false;
    const resolutionOutcomes: ResolutionOutcome[] = [];
    const perLanguage = new Map<
      SupportedLanguages,
      {
        readonly filesProcessed: number;
        readonly importsEmitted: number;
        readonly referenceEdgesEmitted: number;
      }
    >();

    // Pre-count files and languages for progress reporting. This avoids
    // a frozen progress bar during long scope-resolution runs (#1741).
    // Uses primary-language file counts only; languages that expand their
    // context via collectScopeContextPaths may process more files than shown.
    let totalScopeFiles = 0;
    let totalScopeLangs = 0;
    const allScannedPaths = new Set(scannedFiles.map((f) => f.path));
    // Partition scanned files by language ONCE (O(F)). The previous code
    // re-filtered all scannedFiles per language for the precount AND again in the
    // per-language loop below — O(languages × files), ~2.3M getLanguageFromFilename
    // calls on the Linux kernel. Bucketing once collapses that to O(F).
    // Language-agnostic: keyed by the provider-supplied SupportedLanguages value.
    const filesByLang = new Map<
      NonNullable<ReturnType<typeof getLanguageFromFilename>>,
      (typeof scannedFiles)[number][]
    >();
    for (const f of scannedFiles) {
      const fileLang = getLanguageFromFilename(f.path);
      if (fileLang === null) continue;
      // Skip files whose grammar isn't available (optional grammars like
      // swift/dart/kotlin on an install where the binding is absent or the
      // user set GITNEXUS_SKIP_OPTIONAL_GRAMMARS). The parse phase already
      // excluded and warned about these (parse-impl.ts); without this guard the
      // file would fall through to the main-thread re-extract in run.ts and
      // throw "Unsupported language" (caught, but noisy, and it needlessly
      // loads the grammar on the main thread). `isLanguageAvailable` is
      // memoized, so this stays O(1) per language. (#2091, #2093)
      if (!isLanguageAvailable(fileLang)) continue;
      let bucket = filesByLang.get(fileLang);
      if (bucket === undefined) {
        bucket = [];
        filesByLang.set(fileLang, bucket);
      }
      bucket.push(f);
    }
    for (const [lang] of SCOPE_RESOLVERS) {
      const count = filesByLang.get(lang)?.length ?? 0;
      if (count > 0) {
        totalScopeLangs++;
        totalScopeFiles += count;
      }
    }
    const SCOPE_PCT_START = 90;
    const SCOPE_PCT_RANGE = 8; // 90-98 internal → 54-59% display
    let processedScopeFiles = 0;
    let currentLangIdx = 0;

    if (totalScopeFiles > 0) {
      ctx.onProgress({
        phase: 'scopeResolution',
        percent: SCOPE_PCT_START,
        message: 'Resolving types',
      });
    }

    // Build the graph-node lookup ONCE and share it across every language pass.
    // It scans the whole graph (~2 GB on the kernel) and is language-agnostic,
    // so the previous per-language rebuild burned that CPU+heap N times and, on
    // a huge repo, a tiny language's full-graph copy overlapped the next
    // language's — a real contributor to the scope-resolution memory peak.
    // Bracket the whole-graph node-lookup build with probes — scanning every
    // graph node is the silent multi-minute step before the first per-language
    // marker on huge repos, so make it observable.
    logHeapProbe(
      'scope-setup-nodeLookup-start',
      `langs=${totalScopeLangs} files=${totalScopeFiles}`,
    );
    const sharedNodeLookup = totalScopeFiles > 0 ? buildGraphNodeLookup(ctx.graph) : undefined;
    logHeapProbe('scope-setup-nodeLookup-end', `langs=${totalScopeLangs}`);

    for (const [lang, provider] of SCOPE_RESOLVERS) {
      // Standalone providers (COBOL, JCL) don't emit graph edges yet
      // through the scope-resolution path. This is the canonical guard:
      // runScopeResolution is never called for standalone providers, which
      // keeps cobolPhase as the sole IMPORTS edge producer. Keep this guard
      // in sync with any additional standalone providers added to
      // SCOPE_RESOLVERS.
      if (provider.languageProvider.parseStrategy === 'standalone') continue;

      const primaryLangFiles = filesByLang.get(lang) ?? [];
      if (primaryLangFiles.length === 0) continue;
      const primaryFilePaths = primaryLangFiles.map((f) => f.path);

      // Load per-language import-resolution config (tsconfig paths,
      // composer.json autoload, go.mod, ...). One I/O round trip per
      // workspace pass — cached implicitly by the result handed to
      // every `resolveImportTarget` call below.
      const resolutionConfig =
        provider.loadResolutionConfig !== undefined
          ? await provider.loadResolutionConfig(ctx.repoPath)
          : undefined;

      // Some languages (e.g. Vue) expand their file universe beyond the
      // primary-language files via the `collectScopeContextPaths` hook.
      // The hook receives raw source contents of the primary files so it
      // can trace import closures without a second tree-sitter parse.
      //
      // To avoid reading primary files twice (once for the hook, once for
      // the resolution pass), we read them upfront and merge with the
      // extra context paths the hook may add.
      // Stream this language's pre-built ParsedFiles in from the disk store
      // FIRST (huge-repo path). Doing it before reading source lets us skip
      // loading content for files the store already covers — for a provider
      // with no content-consuming hook that source is pure dead weight once
      // extraction is served from the store (~1.5 GB on the kernel's C pass).
      // Merged into `preExtractedByPath`; the per-language release block below
      // evicts these again before the next language, so only one language's
      // ParsedFiles are resident at a time.
      const loadStoreFor = async (paths: ReadonlySet<string>): Promise<void> => {
        if (!parsedFileStorePath) return;
        const fromDisk = await loadParsedFilesForPaths(parsedFileStorePath, paths);
        for (const [fp, pf] of fromDisk) preExtractedByPath.set(fp, pf);
      };

      // A provider that feeds source text into a post-extract hook
      // (populateWorkspaceOwners / populateNamespaceSiblings /
      // populateRangeBindings / emitPostResolutionEdges) needs content for ALL
      // its files; one without those hooks only needs content for files the
      // store does NOT cover (fresh-extract fallback). Keep this in sync with
      // the getFileContents() call-sites in run.ts.
      const providerNeedsAllContent =
        provider.populateWorkspaceOwners !== undefined ||
        provider.populateNamespaceSiblings !== undefined ||
        provider.populateRangeBindings !== undefined ||
        provider.emitPostResolutionEdges !== undefined;

      let scopeFilePaths: Set<string>;
      let contents: Map<string, string>;
      if (provider.collectScopeContextPaths !== undefined) {
        // Context-expanding providers (e.g. Vue) need every primary file's
        // source up front for the closure hook, so load it all.
        const entryFileContents = await readFileContents(ctx.repoPath, primaryFilePaths);
        scopeFilePaths = provider.collectScopeContextPaths({
          primaryFilePaths,
          preExtractedByPath,
          entryFileContents,
          allScannedPaths,
          resolutionConfig,
        });
        // Read only the extra context files (TS/JS etc.) not already loaded.
        const extraPaths = [...scopeFilePaths].filter((p) => !entryFileContents.has(p));
        const extraContents = await readFileContents(ctx.repoPath, extraPaths);
        contents = new Map([...entryFileContents, ...extraContents]);
        await loadStoreFor(scopeFilePaths);
      } else {
        scopeFilePaths = new Set(primaryFilePaths);
        await loadStoreFor(scopeFilePaths);
        const pathsToRead = providerNeedsAllContent
          ? primaryFilePaths
          : primaryFilePaths.filter((p) => !preExtractedByPath.has(p));
        contents = await readFileContents(ctx.repoPath, pathsToRead);
      }
      const filePaths = [...scopeFilePaths];
      const files: { path: string; content: string }[] = [];
      for (const fp of filePaths) {
        const content = contents.get(fp);
        if (content !== undefined) {
          files.push({ path: fp, content });
        } else if (preExtractedByPath.has(fp)) {
          // Store covers extraction for this file and we deliberately skipped
          // reading its source; the empty string is never consumed (the
          // extract loop uses the pre-extracted ParsedFile and this provider
          // has no content hook).
          files.push({ path: fp, content: '' });
        }
        // else: uncovered AND unreadable → skip (unchanged from prior behavior).
      }

      const langFileCount = files.length;
      logHeapProbe(
        'scope-lang-start',
        `lang=${lang} files=${langFileCount} contentsLoaded=${contents.size}`,
      );
      const langLabel = lang.charAt(0).toUpperCase() + lang.slice(1);
      currentLangIdx++;
      const langTag =
        totalScopeLangs > 1 ? `${langLabel} [${currentLangIdx}/${totalScopeLangs}]` : langLabel;

      if (totalScopeFiles > 0) {
        const pct =
          SCOPE_PCT_START + Math.round((processedScopeFiles / totalScopeFiles) * SCOPE_PCT_RANGE);
        ctx.onProgress({
          phase: 'scopeResolution',
          percent: pct,
          message: 'Resolving types',
          detail: `${langTag}, ${langFileCount.toLocaleString()} files`,
        });
      }

      const stats = runScopeResolution(
        {
          graph: ctx.graph,
          model,
          files,
          resolutionConfig,
          prebuiltNodeLookup: sharedNodeLookup,
          preExtractedParsedFiles: preExtractedByPath,
          scopeIndexStorePath: parsedFileStorePath,
          recordResolutionOutcome: (outcome) => {
            resolutionOutcomes.push(outcome);
          },
          onWarn: (msg) => {
            if (isSemanticModelValidatorEnabled()) {
              logger.warn(`[scope-resolution:${lang}] ${msg}`);
            }
          },
          onProgress:
            totalScopeFiles > 0
              ? (subPhase: ScopeResolutionSubPhase, current, total) => {
                  let langRatio: number;
                  switch (subPhase) {
                    case 'extracting':
                      langRatio = total > 0 ? (current / total) * 0.5 : 0;
                      break;
                    case 'analyzing types':
                      langRatio = 0.5;
                      break;
                    case 'resolving references':
                      langRatio = 0.7;
                      break;
                    case 'linking symbols':
                      langRatio = 0.85;
                      break;
                    default: {
                      const _exhaustive: never = subPhase;
                      langRatio = 0.85;
                    }
                  }
                  const overallRatio = Math.min(
                    1,
                    (processedScopeFiles + langRatio * langFileCount) / totalScopeFiles,
                  );
                  const pct = SCOPE_PCT_START + Math.round(overallRatio * SCOPE_PCT_RANGE);
                  ctx.onProgress({
                    phase: 'scopeResolution',
                    percent: pct,
                    message: 'Resolving types',
                    detail:
                      subPhase === 'extracting'
                        ? `${langTag} — extracting ${current.toLocaleString()}/${total.toLocaleString()} files`
                        : `${langTag} — ${subPhase}`,
                  });
                }
              : undefined,
        },
        provider,
      );

      // Release file contents and pre-extracted entries after each language
      // to reduce memory pressure. For large codebases (16K+ PHP files),
      // holding all source code simultaneously with scope trees causes OOM.
      // See: https://github.com/abhigyanpatwari/GitNexus/issues/1741
      //
      // Use `filePaths` (not `primaryFilePaths`) so that any context files
      // added by `collectScopeContextPaths` (e.g. TS/JS files pulled in for
      // Vue cross-file resolution) are also evicted and not held until GC.
      files.length = 0;
      contents.clear();
      for (const fp of filePaths) {
        preExtractedByPath.delete(fp);
      }
      // This language's ParsedFiles are now unreachable (runScopeResolution has
      // returned and the Map entries are deleted). Force a GC HERE so a heavy
      // language's ~17-20GB set (e.g. C/C++ on the Linux kernel) is reclaimed
      // BEFORE the next language's store-load — instead of leaving V8 to collect
      // it lazily under the next pass's allocation pressure (which, at a cap >=
      // RAM, degrades into swap-thrash). Collects only dead objects: the live
      // cross-file index of the next pass is untouched. The pre/post probe
      // confirms whether old-space fragmentation defeats the reclaim.
      logHeapProbe('lang-release-pre-gc', `lang=${lang}`);
      forceGc();
      logHeapProbe('lang-release-post-gc', `lang=${lang}`);
      logHeapProbe('scope-lang-end', `lang=${lang} filesProcessed=${stats.filesProcessed}`);

      processedScopeFiles += langFileCount;
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
        logger.info(
          `[scope-resolution:${lang}] ${stats.filesProcessed} files → ${stats.importsEmitted} IMPORTS + ${stats.referenceEdgesEmitted} reference edges (${stats.resolve.unresolved} unresolved sites, ${stats.referenceSkipped} skipped)`,
        );
      }
    }

    if (totalScopeFiles > 0 && anyRan) {
      ctx.onProgress({
        phase: 'scopeResolution',
        percent: SCOPE_PCT_START + SCOPE_PCT_RANGE,
        message: 'Resolving types',
        detail: 'complete',
      });
    }

    // Scope-resolution is the sole consumer of the disk-backed ParsedFile
    // store; remove its shards now (can be many GB on a huge repo) so they
    // don't linger in `.gitnexus`. Best-effort — never fail the phase on a
    // cleanup error.
    if (parsedFileStorePath) {
      try {
        await clearParsedFileStore(parsedFileStorePath);
      } catch {
        /* best-effort cleanup */
      }
    }

    if (!anyRan) return NOOP_OUTPUT;

    return {
      ran: true,
      filesProcessed: totalFiles,
      importsEmitted: totalImports,
      referenceEdgesEmitted: totalRefs,
      resolutionOutcomes,
      perLanguage,
    };
  },
};
