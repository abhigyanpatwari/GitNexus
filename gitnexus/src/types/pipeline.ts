import type { KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import type { ResolutionOutcome } from '../core/ingestion/scope-resolution/resolution-outcome.js';
import type { PdgEmitManifest } from '../core/lbug/pdg-emit-sink.js';

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
   * True if a worker pool was actually constructed for this run. The worker
   * pool is the sole parse path (sequential parsing was removed). False means
   * no pool was needed: either there were no parseable files, or every chunk
   * was a parse-cache hit and the cached worker output was replayed without
   * spawning workers (a warm all-cache-hit run, #2038). Primarily a test
   * affordance so regression suites can prove the pool engaged.
   */
  usedWorkerPool: boolean;
  /**
   * Streamed PDG-emit COPY manifest (#2202). Present only when streaming/chunked
   * PDG emit was active (full rebuild + `--pdg` + enabled): the BasicBlock node
   * CSV + per-pair PDG-edge CSVs flushed to disk during the emit loop, for
   * `loadGraphToLbug` to COPY alongside the structural CSVs. Absent ⇒ the PDG
   * layer (if any) is resident in `graph` and persists via the whole-graph emit.
   */
  pdgEmitManifest?: PdgEmitManifest;
}
