import type { KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import type { ResolutionOutcome } from '../core/ingestion/scope-resolution/resolution-outcome.js';
import type { UndecidedSatisfaction } from '../core/ingestion/scope-resolution/contract/scope-resolver.js';
import type { PdgEmitManifest } from '../core/lbug/pdg-emit-sink.js';
import type { GraphEmitManifest } from '../core/lbug/graph-emit-sink.js';

// CLI-specific: in-memory result with graph + detection results
export interface PipelineResult {
  graph: KnowledgeGraph;
  /** Absolute path to the repo root — used for lazy file reads during LadybugDB loading */
  repoPath: string;
  /** Total files scanned (for stats) */
  totalFileCount: number;
  communityResult?: CommunityDetectionResult;
  processResult?: ProcessDetectionResult;
  /**
   * Additive diagnostics for registry-primary resolution decisions that
   * deliberately suppress edge emission. Empty means no diagnostic was
   * produced; graph edge semantics are unchanged.
   */
  resolutionOutcomes: readonly ResolutionOutcome[];
  /**
   * Interfaces whose structural-satisfaction check could not be completed
   * (#2873). Empty for languages with no structural detection.
   *
   * ABSENT means scope resolution never ran, which is not the same claim as an
   * empty array — that one says the analyzer looked and decided everything.
   * The writer needs the difference: it carries a prior record forward across a
   * run that could not measure, and CLEARS it on a run that measured clean.
   */
  undecidedSatisfaction?: readonly UndecidedSatisfaction[];
  /**
   * True if a worker pool was actually constructed for this run. The worker
   * pool is the sole parse path (sequential parsing was removed). False means
   * no pool was needed: either there were no parseable files, or every chunk
   * was a parse-cache hit and the cached worker output was replayed without
   * spawning workers (a warm all-cache-hit run, #2038). Primarily a test
   * affordance so regression suites can prove the pool engaged.
   */
  usedWorkerPool: boolean;
  /** Files actually dispatched to parser workers after parse-cache lookup. */
  reparsedFileCount: number;
  /** Files omitted from scope-resolution while the rest of analysis continued. */
  scopeExtractionFailures: readonly string[];
  /** Files scope resolution could not inspect because their parser was unavailable. */
  unavailableScopeLanguageFiles: number;
  /**
   * Streamed PDG-emit COPY manifest (#2202). Present only when streaming/chunked
   * PDG emit was active (full rebuild + `--pdg` + enabled): the BasicBlock node
   * CSV + per-pair PDG-edge CSVs flushed to disk during the emit loop, for
   * `loadGraphToLbug` to COPY alongside the structural CSVs. Absent ⇒ the PDG
   * layer (if any) is resident in `graph` and persists via the whole-graph emit.
   */
  pdgEmitManifest?: PdgEmitManifest;
  /**
   * Streamed structural-emit COPY manifest (#2680). Present only when
   * `streamGraphEmit` was active (full rebuild + enabled): the per-pair CSVs of
   * relationships that never entered the in-memory graph, for `loadGraphToLbug`
   * to COPY ALONGSIDE the whole-graph CSVs (their pair keys overlap, so they are
   * additional COPY jobs, not map entries).
   */
  graphEmitManifest?: GraphEmitManifest;
  /**
   * Property-inference facts from scope resolution (R3-1). Present so a caller
   * — a test, the CLI, or a future MCP surface — can tell WHY a field has no
   * ACCESSES rows: genuinely unread, ambiguous between candidates, or anchored
   * only in a language the per-language inference may not cross. Those are
   * three different situations with three different remedies, and without this
   * they produce byte-identical empty results.
   */
  propertyInference?: {
    readonly ambiguous: number;
    readonly ambiguousNames: readonly string[];
    readonly crossLanguage: number;
    readonly crossLanguageNames: readonly { readonly name: string; readonly languages: string[] }[];
  };
}
