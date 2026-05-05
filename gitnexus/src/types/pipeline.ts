import type { KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import type { CoverageGap } from '../core/coverage-gaps.js';

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
   * True if the parse phase spawned a worker pool for this run. False means
   * the sequential fallback handled every chunk. Primarily a test affordance
   * so regression suites can prove which path executed.
   */
  usedWorkerPool: boolean;
  /**
   * Languages with a meaningful presence in the repo (≥ 10 files by default)
   * that GitNexus cannot index because no LanguageProvider exists. Surfaced
   * by the CLI so callers see when "analyze succeeded" actually means
   * "analyzed only a minority of the source tree."
   */
  coverageGaps: CoverageGap[];
}
