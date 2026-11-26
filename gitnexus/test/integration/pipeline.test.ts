/**
 * P1 Integration Tests: Pipeline End-to-End
 *
 * Runs the full ingestion pipeline once on a mini-repo fixture and
 * validates the resulting knowledge graph: file/symbol nodes, CALLS
 * edges, IMPORTS edges, community detection, and process detection.
 *
 * Pipeline runs once in beforeAll; each it() asserts against the cached result.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineResult } from '../../src/types/pipeline.js';

const MINI_REPO = path.resolve(__dirname, '..', 'fixtures', 'mini-repo');

describe('pipeline end-to-end', () => {
  let result: PipelineResult;
  const phases = new Set<string>();

  // Run pipeline ONCE in beforeAll — each it() asserts against the cached result
  beforeAll(async () => {
    result = await runPipelineFromRepo(MINI_REPO, (p: PipelineProgress) => phases.add(p.phase));
  }, 60000);

  it('indexes a mini repo and produces a valid graph', () => {
    // --- Graph should have nodes ---
    expect(result.graph.nodeCount).toBeGreaterThan(0);
    expect(result.graph.relationshipCount).toBeGreaterThan(0);

    // --- Should find at least 7 TypeScript files (may include AGENTS.md, CLAUDE.md, etc.) ---
    expect(result.totalFileCount).toBeGreaterThanOrEqual(7);

    // --- Verify File nodes exist for each source file ---
    const fileNodes: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'File') fileNodes.push(n.properties.filePath || n.properties.name);
    });
    expect(fileNodes).toContain('src/handler.ts');
    expect(fileNodes).toContain('src/validator.ts');
    expect(fileNodes).toContain('src/db.ts');
    expect(fileNodes).toContain('src/formatter.ts');
    expect(fileNodes).toContain('src/index.ts');
    expect(fileNodes).toContain('src/logger.ts');
    expect(fileNodes).toContain('src/middleware.ts');

    // --- Verify symbol nodes were created (functions, classes) ---
    const symbolNames: string[] = [];
    result.graph.forEachNode((n) => {
      if (['Function', 'Method', 'Class', 'Interface'].includes(n.label)) {
        symbolNames.push(n.properties.name);
      }
    });
    expect(symbolNames).toContain('handleRequest');
    expect(symbolNames).toContain('validateInput');
    expect(symbolNames).toContain('saveToDb');
    expect(symbolNames).toContain('formatResponse');
    expect(symbolNames).toContain('RequestHandler');
    expect(symbolNames).toContain('processRequest');
    expect(symbolNames).toContain('createLogEntry');

    // --- Verify relationships exist ---
    const relTypes = new Set<string>();
    for (const rel of result.graph.iterRelationships()) {
      relTypes.add(rel.type);
    }
    // Should have at least CONTAINS (structure) and CALLS (call graph)
    expect(relTypes).toContain('CONTAINS');

    // --- Verify CALLS edges were detected ---
    const callEdges: { source: string; target: string }[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'CALLS') {
        const sourceNode = result.graph.getNode(rel.sourceId);
        const targetNode = result.graph.getNode(rel.targetId);
        if (sourceNode && targetNode) {
          callEdges.push({
            source: sourceNode.properties.name,
            target: targetNode.properties.name,
          });
        }
      }
    }
    expect(callEdges.length).toBeGreaterThan(0);

    // handleRequest should call validateInput, saveToDb, formatResponse
    const handleRequestCalls = callEdges.filter((e) => e.source === 'handleRequest');
    const calledByHandler = handleRequestCalls.map((e) => e.target);
    expect(calledByHandler).toContain('validateInput');
    expect(calledByHandler).toContain('saveToDb');
    expect(calledByHandler).toContain('formatResponse');

    // --- Verify IMPORTS edges ---
    let importsCount = 0;
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'IMPORTS') importsCount++;
    }
    expect(importsCount).toBeGreaterThan(0);
  });

  it('detects communities', () => {
    expect(result.communityResult).toBeDefined();
    expect(result.communityResult?.stats.totalCommunities).toBeGreaterThan(0);

    // Community nodes should be in the graph
    const communityNodes: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Community') communityNodes.push(n.properties.name);
    });
    expect(communityNodes.length).toBeGreaterThan(0);

    // MEMBER_OF relationships should exist
    let memberOfCount = 0;
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'MEMBER_OF') memberOfCount++;
    }
    expect(memberOfCount).toBeGreaterThan(0);
  });

  it('detects execution flows (processes)', () => {
    expect(result.processResult).toBeDefined();
    expect(result.processResult?.stats.totalProcesses).toBeGreaterThan(0);

    const proc = result.processResult?.processes[0] ?? {
      id: '',
      stepCount: 0,
      trace: [],
      entryPointId: '',
      terminalId: '',
      processType: '',
    };

    // Each process should have valid structure
    expect(proc.id).toBeTruthy();
    expect(proc.stepCount).toBeGreaterThanOrEqual(3); // minSteps default
    expect(proc.trace.length).toBe(proc.stepCount);
    expect(proc.entryPointId).toBeTruthy();
    expect(proc.terminalId).toBeTruthy();
    expect(proc.processType).toMatch(/^(intra_community|cross_community)$/);

    // Process nodes should be in the graph
    const processNode = result.graph.getNode(proc.id);
    expect(processNode).toBeDefined();
    expect(processNode!.label).toBe('Process');

    // STEP_IN_PROCESS relationships should exist with sequential ordering
    const steps: number[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'STEP_IN_PROCESS' && rel.targetId === proc.id) {
        steps.push(rel.step);
      }
    }
    expect(steps.length).toBe(proc.stepCount);
    // Steps should be sequential 1, 2, 3, ...
    const sorted = [...steps].sort((a, b) => a - b);
    sorted.forEach((s, i) => expect(s).toBe(i + 1));
  });

  it('reports progress through all 6 phases', () => {
    expect(phases).toContain('extracting');
    expect(phases).toContain('structure');
    expect(phases).toContain('parsing');
    expect(phases).toContain('communities');
    expect(phases).toContain('processes');
    expect(phases).toContain('complete');
  });

  it('returns correct repoPath in result', () => {
    expect(result.repoPath).toBe(MINI_REPO);
  });
});

// ─── Pipeline error handling ──────────────────────────────────────────

describe('pipeline error handling', () => {
  it('returns empty result for non-existent repo path', async () => {
    const result = await runPipelineFromRepo('/nonexistent/path/xyz123', () => {});
    expect(result.totalFileCount).toBe(0);
  }, 30000);

  it('handles empty directory gracefully', async () => {
    const tmpDir = path.join(os.tmpdir(), `gn-pipeline-empty-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      const result = await runPipelineFromRepo(tmpDir, () => {});
      // Empty repo should produce empty or minimal graph
      expect(result.totalFileCount).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
