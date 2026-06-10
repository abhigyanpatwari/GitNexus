/**
 * Pipeline orchestrator — dependency-ordered ingestion pipeline.
 *
 * The pipeline is composed of named phases with explicit dependencies.
 * Each phase is defined in its own file under `pipeline-phases/`.
 * The runner in `pipeline-phases/runner.ts` executes phases in
 * topological order, passing typed outputs from upstream phases as
 * inputs to downstream phases.
 *
 * To add a new phase:
 * 1. Create a new file in `pipeline-phases/` following the pattern
 * 2. Export it from `pipeline-phases/index.ts`
 * 3. Add it to the `ALL_PHASES` array below
 *
 * See ARCHITECTURE.md for the full phase dependency diagram.
 */

import { createKnowledgeGraph } from '../graph/graph.js';
import { type PipelineProgress } from 'gitnexus-shared';
import { PipelineResult } from '../../types/pipeline.js';
import {
  runPipeline,
  getPhaseOutput,
  scanPhase,
  structurePhase,
  markdownPhase,
  cobolPhase,
  parsePhase,
  routesPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  scopeResolutionPhase,
  pruneLocalSymbolsPhase,
  mroPhase,
  communitiesPhase,
  processesPhase,
  PhaseRegistry,
  type ScopeResolutionOutput,
  type PipelinePhase,
  type CommunitiesOutput,
  type ProcessesOutput,
} from './pipeline-phases/index.js';

export interface PipelineOptions {
  /**
   * Skip MRO, community detection, and process extraction for faster test runs.
   * The `pruneLocalSymbols` phase still runs — it is graph construction (it cleans
   * up inert local symbols), not graph analysis — so set `keepLocalValueSymbols`
   * to retain those nodes under `skipGraphPhases`.
   */
  skipGraphPhases?: boolean;
  /**
   * Request parsing with the worker pool disabled. The sequential parser was
   * removed — the worker pool is the sole parse path — so setting this now
   * makes the parse phase throw a `WorkerPoolDisabledError` (equivalent to
   * `--workers 0`). Retained so callers get an actionable error rather than a
   * silently-different result.
   */
  skipWorkers?: boolean;
  /**
   * @internal Test-only override for the worker script URL the pool
   * spawns. When unset, parse-impl resolves `parse-worker.js` from the
   * adjacent `workers/` directory (or the compiled `dist/` fallback
   * under vitest). Integration tests use this to inject a custom
   * worker script that deterministically triggers worker-pool
   * resilience paths (e.g., crash-on-poison-file). Do not use from production
   * call sites.
   */
  workerUrlForTest?: URL;
  /**
   * Incremental-indexing parse cache. When provided:
   *   - The parse phase looks up each chunk's content hash in
   *     `parseCache.entries`. On hit, it replays the cached
   *     `ParseWorkerResult[]` instead of dispatching to workers.
   *   - On miss, it runs the workers as today and stores the new
   *     results in `parseCache.entries` keyed by chunk hash.
   * The caller (`run-analyze.ts`) is responsible for loading the cache
   * before the pipeline runs and persisting it after. Cache survives
   * `--force` because keys are content-addressed.
   * See `gitnexus/src/storage/parse-cache.ts`.
   */
  parseCache?: import('../../storage/parse-cache.js').ParseCache;
  /**
   * Worker pool size override, threaded from the CLI `--workers` flag
   * via `AnalyzeOptions`. When set, parse-impl passes this directly to
   * `createWorkerPool` so the pool sizing bypasses the env-var fallback
   * in `resolveAutoPoolSize`. The env-var channel
   * (`GITNEXUS_WORKER_POOL_SIZE`) remains as a back-compat fallback when
   * this field is undefined. Must be a positive integer — `0` hard-errors
   * (sequential parsing was removed; equivalent to `skipWorkers`), expressed
   * in the same units as `--workers <N>` so long-running hosts (eval-server,
   * MCP daemon) can size per-call without leaking `process.env` state across
   * analyze invocations.
   */
  workerPoolSize?: number;
  /**
   * Number of chunks whose file contents may be read into memory in
   * parallel while the worker pool is busy dispatching the current
   * chunk. Pre-fetching overlaps disk I/O for chunk N+1..N+K with the
   * worker compute on chunk N — modest but real wall-clock win on
   * repos large enough to chunk. Worker dispatch itself remains serial
   * because `WorkerPool.dispatch` is not reentrant (concurrent calls
   * would race on the shared per-slot busy/in-flight state).
   *
   * `1` matches today's pure-serial behavior; `2` is the documented
   * default (`GITNEXUS_PARSE_CHUNK_CONCURRENCY`). Falls back to the
   * env var when undefined; defaults to 2 when neither is set.
   */
  parseChunkConcurrency?: number;
  /**
   * Byte budget per parse chunk (in bytes). When set, parse-impl uses
   * this instead of the `GITNEXUS_CHUNK_BYTE_BUDGET` env var or the
   * built-in 2 MB default. Smaller values produce more chunks (finer
   * cache-hit granularity, more worker dispatches); larger values
   * batch more files per dispatch.
   *
   * Threading the value through options instead of the env var lets
   * tests vary the chunk layout per-call without `vi.resetModules` and
   * lets long-running hosts (eval-server, MCP daemon) size per-call
   * without leaking `process.env` state across invocations.
   */
  chunkByteBudget?: number;
  /**
   * Keep inert block-local value symbols (Const/Variable/Static) that the
   * `pruneLocalSymbols` phase would otherwise drop. Mirrors the
   * `GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS` env var, but threaded per-call so
   * long-running hosts (eval-server, MCP daemon) can opt out without leaking
   * `process.env` state across invocations. When undefined, the env var decides.
   */
  keepLocalValueSymbols?: boolean;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers, threaded
   * from `.gitnexusrc` `fetchWrappers` via `AnalyzeOptions` (#1589/#1852
   * residual). The routes phase unions these with the auto-detected `fetch()`
   * wrappers when scanning for `route_map` consumers, so a wrapper named outside
   * the built-in convention (or built on axios / a custom client) is still
   * traced. Empty/undefined leaves behavior unchanged.
   */
  fetchWrappers?: readonly string[];
}

// ── Phase registry ─────────────────────────────────────────────────────────

/**
 * All pipeline phases with their dependency relationships.
 *
 * Phase dependency graph:
 *
 *   scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
 *     → crossFile → scopeResolution → pruneLocalSymbols
 *     → mro → communities → processes
 *
 * To add a new phase: create a file in pipeline-phases/, export the phase
 * object, and `.register()` it at the appropriate position below. Opt-in
 * phases pass an `enabledWhen` predicate (issue #2080 phase-registry seam) —
 * the legacy `if (!skipGraphPhases)` guard is now expressed that way on the
 * three graph phases, with no change in behaviour.
 *
 * Exported for the parity test (`pipeline-phase-registry.test.ts`), which
 * asserts the produced list is byte-identical to the legacy array for every
 * options combination.
 */
export function buildPhaseList(options?: PipelineOptions): PipelinePhase[] {
  return (
    new PhaseRegistry<PipelineOptions>()
      .register(scanPhase)
      .register(structurePhase)
      .register(markdownPhase)
      .register(cobolPhase)
      .register(parsePhase)
      .register(routesPhase)
      .register(toolsPhase)
      .register(ormPhase)
      .register(crossFilePhase)
      .register(scopeResolutionPhase)
      .register(pruneLocalSymbolsPhase)
      .register(mroPhase, { enabledWhen: (o) => !o.skipGraphPhases })
      .register(communitiesPhase, { enabledWhen: (o) => !o.skipGraphPhases })
      .register(processesPhase, { enabledWhen: (o) => !o.skipGraphPhases })
      // Normalize a missing options object once here so phase predicates above
      // take a required PipelineOptions and need no `?.` guard (#2080 review S1).
      .build(options ?? {})
  );
}

// ── Pipeline orchestrator ─────────────────────────────────────────────────

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const pipelineStart = Date.now();

  const phases = buildPhaseList(options);

  const results = await runPipeline(phases, {
    repoPath,
    graph,
    onProgress,
    options,
    pipelineStart,
  });

  // Extract final results for the PipelineResult contract
  const { totalFiles, usedWorkerPool } = getPhaseOutput<{
    totalFiles: number;
    usedWorkerPool: boolean;
  }>(results, 'parse');

  let communityResult: CommunitiesOutput['communityResult'] | undefined;
  let processResult: ProcessesOutput['processResult'] | undefined;
  const resolutionOutcomes = getPhaseOutput<ScopeResolutionOutput>(
    results,
    'scopeResolution',
  ).resolutionOutcomes;

  if (!options?.skipGraphPhases) {
    communityResult = getPhaseOutput<CommunitiesOutput>(results, 'communities').communityResult;
    processResult = getPhaseOutput<ProcessesOutput>(results, 'processes').processResult;
  }

  onProgress({
    phase: 'complete',
    percent: 100,
    message:
      communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
    stats: {
      filesProcessed: totalFiles,
      totalFiles,
      nodesCreated: graph.nodeCount,
    },
  });

  return {
    graph,
    repoPath,
    totalFileCount: totalFiles,
    communityResult,
    processResult,
    resolutionOutcomes,
    usedWorkerPool,
  };
};
