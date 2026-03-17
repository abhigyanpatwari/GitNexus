import { createKnowledgeGraph } from '../graph/graph';
import { extractZip, FileEntry } from '../../services/zip';
import { processStructure } from './structure-processor';
import { processParsing } from './parsing-processor';
import { processImports, createImportMap } from './import-processor';
import { processCalls } from './call-processor';
import { processHeritage } from './heritage-processor';
import { processCommunities, CommunityDetectionResult } from './community-processor';
import { processProcesses, ProcessDetectionResult } from './process-processor';
import { processMetrics, MetricsResult } from './metrics-processor';
import { createSymbolTable } from './symbol-table';
import { createASTCache } from './ast-cache';
import { PipelineProgress, PipelineResult } from '../../types/pipeline';

/**
 * Run the ingestion pipeline from a ZIP file
 */
export const runIngestionPipeline = async ( file: File, onProgress: (progress: PipelineProgress) => void): Promise<PipelineResult> => {
  // Phase 1: Extracting (0-15%)
  onProgress({
    phase: 'extracting',
    percent: 0,
    message: 'Extracting ZIP file...',
  });
  
  // Fake progress for extraction (JSZip doesn't expose progress)
  const fakeExtractionProgress = setInterval(() => {
    onProgress({
      phase: 'extracting',
      percent: Math.min(14, Math.random() * 10 + 5),
      message: 'Extracting ZIP file...',
    });
  }, 200);
  
  const files = await extractZip(file);
  clearInterval(fakeExtractionProgress);
  
  // Continue with common pipeline
  return runPipelineFromFiles(files, onProgress);
};

/**
 * Run the ingestion pipeline from pre-extracted files (e.g., from git clone)
 */
export const runPipelineFromFiles = async (
  files: FileEntry[],
  onProgress: (progress: PipelineProgress) => void
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const fileContents = new Map<string, string>();
  const symbolTable = createSymbolTable();
  const astCache = createASTCache(50); // Keep last 50 files hot
  const importMap = createImportMap();

  // Cleanup function for error handling
  const cleanup = () => {
    astCache.clear();
    symbolTable.clear();
  };
  
  try {
  // Store file contents for code panel
  files.forEach(f => fileContents.set(f.path, f.content));
  
  onProgress({
    phase: 'extracting',
    percent: 15,
    message: 'ZIP extracted successfully',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: 0 },
  });
  
  // Phase 2: Structure (15-30%)
  onProgress({
    phase: 'structure',
    percent: 15,
    message: 'Analyzing project structure...',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: 0 },
  });
  
  const filePaths = files.map(f => f.path);
  processStructure(graph, filePaths);
  
  onProgress({
    phase: 'structure',
    percent: 30,
    message: 'Project structure analyzed',
    stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });
  
  // Phase 3: Parsing (30-70%)
  onProgress({
    phase: 'parsing',
    percent: 30,
    message: 'Parsing code definitions...',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });
  
  await processParsing(graph, files, symbolTable, astCache, (current, total, filePath) => {
    const parsingProgress = 30 + ((current / total) * 40);
    onProgress({
      phase: 'parsing',
      percent: Math.round(parsingProgress),
      message: 'Parsing code definitions...',
      detail: filePath,
      stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
    });
  });


  // Phase 4: Imports (70-82%)
  onProgress({
    phase: 'imports',
    percent: 70,
    message: 'Resolving imports...',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  await processImports(graph, files, astCache, importMap, (current, total) => {
    const importProgress = 70 + ((current / total) * 12);
    onProgress({
      phase: 'imports',
      percent: Math.round(importProgress),
      message: 'Resolving imports...',
      stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
    });
  });
  
  // Debug: Count IMPORTS relationships
  if (import.meta.env.DEV) {
    const importsCount = graph.relationships.filter(r => r.type === 'IMPORTS').length;
    console.log(`📊 Pipeline: After import phase, graph has ${importsCount} IMPORTS relationships (total: ${graph.relationshipCount})`);
    if (importsCount > 0) {
      const sample = graph.relationships.filter(r => r.type === 'IMPORTS').slice(0, 3);
      sample.forEach(r => console.log(`   Sample IMPORTS: ${r.sourceId} → ${r.targetId}`));
    }
  }


  // Phase 5: Calls (82-98%)
  onProgress({
    phase: 'calls',
    percent: 82,
    message: 'Tracing function calls...',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  await processCalls(graph, files, astCache, symbolTable, importMap, (current, total) => {
    const callProgress = 82 + ((current / total) * 10);
    onProgress({
      phase: 'calls',
      percent: Math.round(callProgress),
      message: 'Tracing function calls...',
      stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
    });
  });

  // Phase 6: Heritage - Class inheritance (92-98%)
  onProgress({
    phase: 'heritage',
    percent: 92,
    message: 'Extracting class inheritance...',
    stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  await processHeritage(graph, files, astCache, symbolTable, (current, total) => {
    const heritageProgress = 88 + ((current / total) * 4);
    onProgress({
      phase: 'heritage',
      percent: Math.round(heritageProgress),
      message: 'Extracting class inheritance...',
      stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
    });
  });

  // Phase 7: Community Detection (92-98%)
  onProgress({
    phase: 'communities',
    percent: 92,
    message: 'Detecting code communities...',
    stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  const communityResult = await processCommunities(graph, (message, progress) => {
    const communityProgress = 92 + (progress * 0.06);
    onProgress({
      phase: 'communities',
      percent: Math.round(communityProgress),
      message,
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });
  });

  // Log community detection results
  if (import.meta.env.DEV) {
    console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
  }

  // Add community nodes to the graph
  communityResult.communities.forEach(comm => {
    graph.addNode({
      id: comm.id,
      label: 'Community' as const,
      properties: {
        name: comm.label,
        filePath: '',
        heuristicLabel: comm.heuristicLabel,
        cohesion: comm.cohesion,
        symbolCount: comm.symbolCount,
      }
    });
  });

  // Add MEMBER_OF relationships
  communityResult.memberships.forEach(membership => {
    graph.addRelationship({
      id: `${membership.nodeId}_member_of_${membership.communityId}`,
      type: 'MEMBER_OF',
      sourceId: membership.nodeId,
      targetId: membership.communityId,
      confidence: 1.0,
      reason: 'leiden-algorithm',
    });
  });

  // Phase 8: Process Detection (98-99%)
  onProgress({
    phase: 'processes',
    percent: 98,
    message: 'Detecting execution flows...',
    stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  const processResult = await processProcesses(
    graph,
    communityResult.memberships,
    (message, progress) => {
      const processProgress = 98 + (progress * 0.01);
      onProgress({
        phase: 'processes',
        percent: Math.round(processProgress),
        message,
        stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
      });
    }
  );

  // Log process detection results
  if (import.meta.env.DEV) {
    console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
  }

  // Add Process nodes to the graph
  processResult.processes.forEach(proc => {
    graph.addNode({
      id: proc.id,
      label: 'Process' as const,
      properties: {
        name: proc.label,
        filePath: '',
        heuristicLabel: proc.heuristicLabel,
        processType: proc.processType,
        stepCount: proc.stepCount,
        communities: proc.communities,
        entryPointId: proc.entryPointId,
        terminalId: proc.terminalId,
      }
    });
  });

  // Add STEP_IN_PROCESS relationships
  processResult.steps.forEach(step => {
    graph.addRelationship({
      id: `${step.nodeId}_step_${step.step}_${step.processId}`,
      type: 'STEP_IN_PROCESS',
      sourceId: step.nodeId,
      targetId: step.processId,
      confidence: 1.0,
      reason: 'trace-detection',
      step: step.step,
    });
  });

  // Phase 9: Metrics Calculation (99-100%)
  onProgress({
    phase: 'metrics',
    percent: 99,
    message: 'Calculating code complexity metrics...',
    stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
  });

  const metricsResult = processMetrics(graph, (message, progress) => {
    const metricsProgress = 99 + (progress * 0.01);
    onProgress({
      phase: 'metrics',
      percent: Math.round(metricsProgress),
      message,
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });
  });

  // Log metrics results
  if (import.meta.env.DEV) {
    console.log(`📊 Metrics: ${metricsResult.stats.totalNodesProcessed} nodes analyzed (avg complexity: ${metricsResult.stats.avgComplexity}, critical: ${metricsResult.stats.criticalCount})`);
  }

  // Phase 10: Complete (100%)
  onProgress({
    phase: 'complete',
    percent: 100,
    message: `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes, ${metricsResult.stats.criticalCount} critical hotspots.`,
    stats: { 
      filesProcessed: files.length, 
      totalFiles: files.length, 
      nodesCreated: graph.nodeCount 
    },
  });

  // Cleanup WASM memory before returning
  astCache.clear();
  
  return { graph, fileContents, communityResult, processResult, metricsResult };

  } catch (error) {
    cleanup();
    throw error;
  }
};
