// gitnexus/src/core/coverage/types.ts

/** Canonical fuzzer-agnostic coverage input format. */
export interface CanonicalCoverage {
  format: 'gitnexus-coverage-v1';
  run: CoverageRunMeta;
  files: Record<string, FileCoverage>;
}

export interface CoverageRunMeta {
  id: string;
  timestamp: string;
  label?: string;
  command?: string;
  durationMs?: number;
  totalExecs?: number;
  totalLines?: number;
  coveredLines?: number;
}

export interface FileCoverage {
  lines: Record<string, number>;    // "lineNumber" -> hitCount
  branches?: Record<string, number>; // "lineNumber:branchId" -> hitCount
}

/** A stored coverage run (metadata persisted to SQLite). */
export interface CoverageRunRecord {
  id: string;
  timestamp: string;
  label?: string;
  command?: string;
  durationMs?: number;
  totalExecs?: number;
  totalLines: number;
  coveredLines: number;
  coverageRatio: number;
}

/** Line-level hit record. */
export interface LineHitRecord {
  runId: string;
  filePath: string;
  lineNumber: number;
  hitCount: number;
}

/** Branch-level hit record. */
export interface BranchHitRecord {
  runId: string;
  filePath: string;
  lineNumber: number;
  branchId: string;
  hitCount: number;
}

/** Precomputed symbol coverage per run. */
export interface SymbolCoverageRecord {
  runId: string;
  nodeId: string;
  symbolName?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  totalLines: number;
  coveredLines: number;
  coverageRatio: number;
}

/** Edge traversal record per run. */
export interface EdgeTraversalRecord {
  runId: string;
  edgeId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  hitCount: number;
}

/** Coverage diff between two runs. */
export interface CoverageDiff {
  runId1: string;
  runId2: string;
  addedSymbols: string[];
  removedSymbols: string[];
  unchangedSymbols: string[];
  stats: {
    beforeRatio: number;
    afterRatio: number;
    deltaRatio: number;
    newSymbolsCovered: number;
    regressions: number;
  };
}

/** Result of mapping a line to graph nodes. */
export interface LineNodeMapping {
  lineNumber: number;
  filePath: string;
  hitCount: number;
  matchedNodes: string[];  // node IDs (most-specific first)
}
