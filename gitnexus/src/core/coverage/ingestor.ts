// gitnexus/src/core/coverage/ingestor.ts
import type { KnowledgeGraph } from '../graph/types.js';
import type { CanonicalCoverage, CoverageRunRecord, SymbolCoverageRecord } from './types.js';
import { CoverageStore } from './store.js';
import { mapLinesToNodes, aggregateSymbolCoverage } from './line-mapper.js';
import { mapBranches } from './branch-mapper.js';
import { mapCoveredEdges, updateEdgeTraversalCounts } from './edge-mapper.js';
import { writeCoverageToGraph } from './graph-bridge.js';

export interface IngestOptions {
  store: CoverageStore;
  graph: KnowledgeGraph;
}

export function ingestCoverage(
  coverage: CanonicalCoverage,
  opts: IngestOptions,
): string {
  const runId = coverage.run.id;

  // 1. Convert file:line coverage to per-file line maps
  const lineHitMaps = new Map<string, Map<number, number>>();
  const branchHitRecords: { runId: string; filePath: string; lineNumber: number; branchId: string; hitCount: number }[] = [];

  for (const [filePath, fileCov] of Object.entries(coverage.files)) {
    const lineMap = new Map<number, number>();
    for (const [lineStr, count] of Object.entries(fileCov.lines)) {
      lineMap.set(parseInt(lineStr, 10), count);
    }
    lineHitMaps.set(filePath, lineMap);

    if (fileCov.branches) {
      for (const [branchId, count] of Object.entries(fileCov.branches)) {
        const [lineStr] = branchId.split(':');
        branchHitRecords.push({
          runId,
          filePath,
          lineNumber: parseInt(lineStr, 10),
          branchId,
          hitCount: count,
        });
      }
    }
  }

  // 2. Map lines to nodes
  const lineMappings = mapLinesToNodes(lineHitMaps, opts.graph);

  // 3. Aggregate per-symbol coverage
  const symbolCoverage = aggregateSymbolCoverage(lineMappings);

  // 4. Map edges
  const coveredNodeIds = new Set(symbolCoverage.keys());
  const edgeTraversals = mapCoveredEdges(coveredNodeIds, opts.graph, runId);
  updateEdgeTraversalCounts(edgeTraversals, opts.graph, runId);

  // 5. Write to graph
  writeCoverageToGraph(
    { runMeta: coverage.run, symbolUpdates: symbolCoverage },
    opts.graph,
  );

  // 6. Write to CoverageStore

  // 6a. Upsert run
  const totalLines = coverage.run.totalLines ?? 0;
  const coveredLines = coverage.run.coveredLines ?? 0;
  const runRecord: CoverageRunRecord = {
    id: runId,
    timestamp: coverage.run.timestamp,
    label: coverage.run.label,
    command: coverage.run.command,
    durationMs: coverage.run.durationMs,
    totalExecs: coverage.run.totalExecs,
    totalLines,
    coveredLines,
    coverageRatio: totalLines > 0 ? coveredLines / totalLines : 0,
  };
  opts.store.upsertRun(runRecord);

  // 6b. Insert line hits
  const lineHitRecords: { runId: string; filePath: string; lineNumber: number; hitCount: number }[] = [];
  for (const [filePath, fileCov] of Object.entries(coverage.files)) {
    for (const [lineStr, hitCount] of Object.entries(fileCov.lines)) {
      lineHitRecords.push({ runId, filePath, lineNumber: parseInt(lineStr, 10), hitCount });
    }
  }
  opts.store.insertLineHits(lineHitRecords);

  // 6c. Insert branch hits
  opts.store.insertBranchHits(branchHitRecords);

  // 6d. Insert symbol coverage
  const symbolRecords: SymbolCoverageRecord[] = [];
  for (const [nodeId, cov] of symbolCoverage) {
    const node = opts.graph.getNode(nodeId);
    symbolRecords.push({
      runId,
      nodeId,
      symbolName: node?.properties.name as string | undefined,
      filePath: node?.properties.filePath as string | undefined,
      startLine: node?.properties.startLine as number | undefined,
      endLine: node?.properties.endLine as number | undefined,
      totalLines: cov.totalLines,
      coveredLines: cov.coveredLines,
      coverageRatio: cov.ratio,
    });
  }
  opts.store.insertSymbolCoverage(symbolRecords);

  // 6e. Insert edge traversals
  opts.store.insertEdgeTraversals(edgeTraversals);

  return runId;
}
