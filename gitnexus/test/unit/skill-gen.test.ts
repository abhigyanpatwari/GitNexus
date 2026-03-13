/**
 * Unit & integration tests for the skill file generator.
 *
 * Tests generateSkillFiles() — the only public export from cli/skill-gen.ts.
 * Validates return values (skill metadata), aggregation logic, edge cases,
 * and the on-disk SKILL.md files produced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { generateSkillFiles } from '../../src/cli/skill-gen.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship, KnowledgeGraph } from '../../src/core/graph/types.js';
import type { CommunityNode, CommunityMembership, CommunityDetectionResult } from '../../src/core/ingestion/community-processor.js';
import type { ProcessNode, ProcessDetectionResult } from '../../src/core/ingestion/process-processor.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// ============================================================================
// FIXTURE HELPERS
// ============================================================================

/** Create a GraphNode with commonly-needed properties */
function makeNode(
  id: string,
  name: string,
  label: GraphNode['label'],
  filePath: string,
  startLine: number,
  isExported: boolean,
): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, startLine, endLine: startLine + 10, isExported },
  };
}

/** Create a GraphRelationship between two nodes */
function makeRel(
  id: string,
  sourceId: string,
  targetId: string,
  type: GraphRelationship['type'],
): GraphRelationship {
  return { id, sourceId, targetId, type, confidence: 1.0, reason: '' };
}

/** Create a CommunityNode with default cohesion */
function makeCommunity(
  id: string,
  label: string,
  symbolCount: number,
  cohesion: number = 0.75,
): CommunityNode {
  return { id, label, heuristicLabel: label, cohesion, symbolCount };
}

/** Create a membership record linking a node to a community */
function makeMembership(nodeId: string, communityId: string): CommunityMembership {
  return { nodeId, communityId };
}

/** Create a ProcessNode for testing execution flows */
function makeProcess(
  id: string,
  label: string,
  communities: string[],
  stepCount: number,
): ProcessNode {
  return {
    id,
    label,
    heuristicLabel: label,
    processType: communities.length > 1 ? 'cross_community' : 'intra_community',
    stepCount,
    communities,
    entryPointId: '',
    terminalId: '',
    trace: [],
  };
}

/**
 * Assemble a full PipelineResult from individual pieces.
 * Only graph is required; community and process data default to empty.
 */
function buildPipelineResult(opts: {
  graph: KnowledgeGraph;
  repoPath: string;
  communities?: CommunityNode[];
  memberships?: CommunityMembership[];
  processes?: ProcessNode[];
}): PipelineResult {
  const communityResult: CommunityDetectionResult = {
    communities: opts.communities ?? [],
    memberships: opts.memberships ?? [],
    stats: {
      totalCommunities: (opts.communities ?? []).length,
      modularity: 0.5,
      nodesProcessed: (opts.memberships ?? []).length,
    },
  };

  const processResult: ProcessDetectionResult | undefined =
    opts.processes
      ? {
          processes: opts.processes,
          steps: [],
          stats: {
            totalProcesses: opts.processes.length,
            crossCommunityCount: opts.processes.filter(p => p.processType === 'cross_community').length,
            avgStepCount: opts.processes.length > 0
              ? opts.processes.reduce((s, p) => s + p.stepCount, 0) / opts.processes.length
              : 0,
            entryPointsFound: 0,
          },
        }
      : undefined;

  return {
    graph: opts.graph,
    repoPath: opts.repoPath,
    totalFileCount: 0,
    communityResult,
    processResult,
  };
}

// ============================================================================
// TESTS — RETURN VALUES
// ============================================================================

describe('generateSkillFiles — return values', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-skill-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  /**
   * When memberships array is empty, there is nothing to group into skills.
   * Should return an empty skills array and the expected output path.
   */
  it('returns empty skills when memberships is empty', async () => {
    const graph = createKnowledgeGraph();
    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph,
      repoPath: tmpDir,
      communities: [],
      memberships: [],
    }));

    expect(result.skills).toEqual([]);
    expect(result.outputPath).toBe(path.join(tmpDir, '.claude', 'skills', 'generated'));
  });

  /**
   * Communities with fewer than 3 symbols are filtered out.
   * Three communities each with 2 symbols should all be excluded.
   */
  it('returns empty skills when all communities are below threshold', async () => {
    const graph = createKnowledgeGraph();
    // Add 6 nodes — 2 per community
    for (let i = 0; i < 6; i++) {
      graph.addNode(makeNode(`fn:n${i}`, `n${i}`, 'Function', `${tmpDir}/src/f${i}.ts`, 1, false));
    }

    const communities = [
      makeCommunity('c1', 'Small1', 2),
      makeCommunity('c2', 'Small2', 2),
      makeCommunity('c3', 'Small3', 2),
    ];
    const memberships = [
      makeMembership('fn:n0', 'c1'), makeMembership('fn:n1', 'c1'),
      makeMembership('fn:n2', 'c2'), makeMembership('fn:n3', 'c2'),
      makeMembership('fn:n4', 'c3'), makeMembership('fn:n5', 'c3'),
    ];

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toEqual([]);
  });

  /**
   * A single valid community with 5 nodes across 2 files, some exported.
   * Should return exactly 1 skill with correct metadata.
   */
  it('returns 1 skill for a single valid community', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode('fn:a', 'alpha', 'Function', `${tmpDir}/src/auth/login.ts`, 1, true));
    graph.addNode(makeNode('fn:b', 'beta', 'Function', `${tmpDir}/src/auth/login.ts`, 20, false));
    graph.addNode(makeNode('fn:c', 'gamma', 'Class', `${tmpDir}/src/auth/session.ts`, 1, true));
    graph.addNode(makeNode('fn:d', 'delta', 'Function', `${tmpDir}/src/auth/session.ts`, 40, false));
    graph.addNode(makeNode('fn:e', 'epsilon', 'Function', `${tmpDir}/src/auth/session.ts`, 60, true));

    const communities = [makeCommunity('c1', 'Auth', 5, 0.8)];
    const memberships = ['fn:a', 'fn:b', 'fn:c', 'fn:d', 'fn:e']
      .map(id => makeMembership(id, 'c1'));

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].label).toBe('Auth');
    expect(result.skills[0].symbolCount).toBe(5);
    expect(result.skills[0].fileCount).toBe(2);
    expect(result.skills[0].name).toBe('auth');
  });

  /**
   * Two communities with the same heuristicLabel should be aggregated
   * into one skill with summed symbolCount.
   */
  it('aggregates communities with same label into one skill', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 8; i++) {
      graph.addNode(makeNode(`fn:n${i}`, `n${i}`, 'Function', `${tmpDir}/src/auth/f${i}.ts`, 1, false));
    }

    const communities = [
      makeCommunity('c1', 'Auth', 4, 0.7),
      makeCommunity('c2', 'Auth', 4, 0.9),
    ];
    const memberships = [
      ...['fn:n0', 'fn:n1', 'fn:n2', 'fn:n3'].map(id => makeMembership(id, 'c1')),
      ...['fn:n4', 'fn:n5', 'fn:n6', 'fn:n7'].map(id => makeMembership(id, 'c2')),
    ];

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].label).toBe('Auth');
    expect(result.skills[0].symbolCount).toBe(8);
  });

  /**
   * The generator caps output at 20 skills regardless of how many
   * communities pass the threshold.
   */
  it('caps skills at 20 even with more valid communities', async () => {
    const graph = createKnowledgeGraph();
    const communities: CommunityNode[] = [];
    const memberships: CommunityMembership[] = [];

    for (let i = 0; i < 25; i++) {
      const commId = `c${i}`;
      communities.push(makeCommunity(commId, `Area${i}`, 4));
      for (let j = 0; j < 4; j++) {
        const nodeId = `fn:c${i}_n${j}`;
        graph.addNode(makeNode(nodeId, `func_${i}_${j}`, 'Function', `${tmpDir}/src/area${i}/f${j}.ts`, 1, false));
        memberships.push(makeMembership(nodeId, commId));
      }
    }

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(20);
  });

  /**
   * Skills should be sorted by symbolCount descending so the most
   * significant community appears first.
   */
  it('sorts skills by symbol count descending', async () => {
    const graph = createKnowledgeGraph();
    const sizes = [10, 5, 3];
    const communities: CommunityNode[] = [];
    const memberships: CommunityMembership[] = [];

    for (let ci = 0; ci < 3; ci++) {
      const commId = `c${ci}`;
      communities.push(makeCommunity(commId, `Area${ci}`, sizes[ci]));
      for (let ni = 0; ni < sizes[ci]; ni++) {
        const nodeId = `fn:c${ci}_n${ni}`;
        graph.addNode(makeNode(nodeId, `func_${ci}_${ni}`, 'Function', `${tmpDir}/src/area${ci}/f${ni}.ts`, 1, false));
        memberships.push(makeMembership(nodeId, commId));
      }
    }

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(3);
    expect(result.skills[0].symbolCount).toBe(10);
    expect(result.skills[1].symbolCount).toBe(5);
    expect(result.skills[2].symbolCount).toBe(3);
  });

  /**
   * When the communities array is empty but memberships exist with nodes
   * in an "auth/" folder, the fallback builder should derive a label from
   * the most common parent directory.
   */
  it('uses fallback builder when communities array is empty', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:n${i}`, `authFunc${i}`, 'Function', `${tmpDir}/src/auth/file${i}.ts`, 1, true));
    }

    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:n${i}`, 'comm_0'));

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities: [], memberships,
    }));

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].label).toBe('Auth');
  });

  /**
   * When processResult is undefined, the generator should still work
   * without crashing — it simply has no execution flows.
   */
  it('does not crash when processResult is undefined', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:n${i}`, `func${i}`, 'Function', `${tmpDir}/src/core/f${i}.ts`, 1, false));
    }

    const communities = [makeCommunity('c1', 'Core', 4)];
    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:n${i}`, 'c1'));

    const pipeline: PipelineResult = {
      graph,
      repoPath: tmpDir,
      totalFileCount: 0,
      communityResult: {
        communities,
        memberships,
        stats: { totalCommunities: 1, modularity: 0.5, nodesProcessed: 4 },
      },
      processResult: undefined,
    };

    const result = await generateSkillFiles(tmpDir, 'TestProject', pipeline);
    expect(result.skills).toHaveLength(1);
  });

  /**
   * Memberships that reference node IDs not present in the graph
   * should be silently skipped without crashing.
   */
  it('does not crash when memberships reference missing nodes', async () => {
    const graph = createKnowledgeGraph();
    // Only add 2 real nodes but membership references 4
    graph.addNode(makeNode('fn:real1', 'real1', 'Function', `${tmpDir}/src/mod/a.ts`, 1, false));
    graph.addNode(makeNode('fn:real2', 'real2', 'Function', `${tmpDir}/src/mod/b.ts`, 1, false));

    const communities = [makeCommunity('c1', 'Mod', 4)];
    const memberships = [
      makeMembership('fn:real1', 'c1'),
      makeMembership('fn:real2', 'c1'),
      makeMembership('fn:ghost1', 'c1'),
      makeMembership('fn:ghost2', 'c1'),
    ];

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    // Community has symbolCount=4 which passes threshold, but only 2 real nodes resolve
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].fileCount).toBe(2);
  });

  /**
   * When the same nodeId appears in two raw community IDs that get
   * aggregated into the same label, it should not be double-counted
   * in the file output.
   */
  it('does not double-count nodes shared across aggregated communities', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode('fn:shared', 'shared', 'Function', `${tmpDir}/src/data/shared.ts`, 1, true));
    graph.addNode(makeNode('fn:a', 'a', 'Function', `${tmpDir}/src/data/a.ts`, 1, false));
    graph.addNode(makeNode('fn:b', 'b', 'Function', `${tmpDir}/src/data/b.ts`, 1, false));

    // Two raw communities both named "Data", both containing fn:shared
    const communities = [
      makeCommunity('c1', 'Data', 2, 0.8),
      makeCommunity('c2', 'Data', 2, 0.7),
    ];
    const memberships = [
      makeMembership('fn:shared', 'c1'),
      makeMembership('fn:a', 'c1'),
      makeMembership('fn:shared', 'c2'),
      makeMembership('fn:b', 'c2'),
    ];

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);
    // fileCount should be 3 (shared.ts, a.ts, b.ts) — not 4
    expect(result.skills[0].fileCount).toBe(3);
  });
});

// ============================================================================
// TESTS — FILE OUTPUT
// ============================================================================

describe('generateSkillFiles — file output', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-skill-out-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  /** Helper: create a standard 2-community setup for file-output tests */
  function twoCommSetup() {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:a${i}`, `alphaFn${i}`, 'Function', `${tmpDir}/src/alpha/f${i}.ts`, i * 10 + 1, i < 2));
    }
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:b${i}`, `betaFn${i}`, 'Function', `${tmpDir}/src/beta/f${i}.ts`, i * 10 + 1, i < 2));
    }

    const communities = [
      makeCommunity('cA', 'Alpha', 4, 0.85),
      makeCommunity('cB', 'Beta', 4, 0.60),
    ];
    const memberships = [
      ...[0, 1, 2, 3].map(i => makeMembership(`fn:a${i}`, 'cA')),
      ...[0, 1, 2, 3].map(i => makeMembership(`fn:b${i}`, 'cB')),
    ];

    return { graph, communities, memberships };
  }

  /**
   * Verify that each community produces a directory under generated/
   * containing a SKILL.md file.
   */
  it('creates generated/{name}/SKILL.md for each community', async () => {
    const { graph, communities, memberships } = twoCommSetup();

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    const outputDir = path.join(tmpDir, '.claude', 'skills', 'generated');
    const alphaSkill = await fs.readFile(path.join(outputDir, 'alpha', 'SKILL.md'), 'utf-8');
    const betaSkill = await fs.readFile(path.join(outputDir, 'beta', 'SKILL.md'), 'utf-8');
    expect(alphaSkill.length).toBeGreaterThan(0);
    expect(betaSkill.length).toBeGreaterThan(0);
  });

  /**
   * SKILL.md files should start with YAML frontmatter containing
   * name and description fields.
   */
  it('starts with frontmatter containing name and description', async () => {
    const { graph, communities, memberships } = twoCommSetup();

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'generated', 'alpha', 'SKILL.md'),
      'utf-8',
    );
    expect(content.startsWith('---')).toBe(true);
    expect(content).toContain('name:');
    expect(content).toContain('description:');
  });

  /**
   * A community with exported symbols, processes, and cross-community
   * CALLS edges should have all optional sections rendered.
   */
  it('includes Entry Points, Execution Flows, Connected Areas when data exists', async () => {
    const graph = createKnowledgeGraph();
    // Community A: exported symbols
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:a${i}`, `alphaFn${i}`, 'Function', `${tmpDir}/src/alpha/f${i}.ts`, 1, true));
    }
    // Community B: target of cross-community calls
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:b${i}`, `betaFn${i}`, 'Function', `${tmpDir}/src/beta/f${i}.ts`, 1, false));
    }
    // Cross-community CALLS edge: A -> B
    graph.addRelationship(makeRel('r1', 'fn:a0', 'fn:b0', 'CALLS'));

    const communities = [
      makeCommunity('cA', 'Alpha', 4, 0.85),
      makeCommunity('cB', 'Beta', 4, 0.60),
    ];
    const memberships = [
      ...[0, 1, 2, 3].map(i => makeMembership(`fn:a${i}`, 'cA')),
      ...[0, 1, 2, 3].map(i => makeMembership(`fn:b${i}`, 'cB')),
    ];

    const processes = [makeProcess('p1', 'AlphaFlow', ['cA'], 5)];

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships, processes,
    }));

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'generated', 'alpha', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('## Entry Points');
    expect(content).toContain('## Execution Flows');
    expect(content).toContain('## Connected Areas');
  });

  /**
   * A community with no exports, no processes, and no cross-community
   * calls should omit the optional sections entirely.
   */
  it('omits Entry Points, Execution Flows, Connected Areas when absent', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:n${i}`, `func${i}`, 'Function', `${tmpDir}/src/isolated/f${i}.ts`, 1, false));
    }

    const communities = [makeCommunity('c1', 'Isolated', 4)];
    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:n${i}`, 'c1'));

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships, processes: [],
    }));

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'generated', 'isolated', 'SKILL.md'),
      'utf-8',
    );

    expect(content).not.toContain('## Entry Points');
    expect(content).not.toContain('## Execution Flows');
    expect(content).not.toContain('## Connected Areas');
  });

  /**
   * Running generateSkillFiles twice with different communities should
   * clean up the first run's output directories.
   */
  it('cleans up previous run output on re-run', async () => {
    const graph1 = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph1.addNode(makeNode(`fn:x${i}`, `xFunc${i}`, 'Function', `${tmpDir}/src/first/f${i}.ts`, 1, false));
    }

    // First run
    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph: graph1, repoPath: tmpDir,
      communities: [makeCommunity('c1', 'First', 4)],
      memberships: [0, 1, 2, 3].map(i => makeMembership(`fn:x${i}`, 'c1')),
    }));

    const outputDir = path.join(tmpDir, '.claude', 'skills', 'generated');
    const firstRunDirs = await fs.readdir(outputDir);
    expect(firstRunDirs).toContain('first');

    // Second run with different community
    const graph2 = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph2.addNode(makeNode(`fn:y${i}`, `yFunc${i}`, 'Function', `${tmpDir}/src/second/f${i}.ts`, 1, false));
    }

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph: graph2, repoPath: tmpDir,
      communities: [makeCommunity('c2', 'Second', 4)],
      memberships: [0, 1, 2, 3].map(i => makeMembership(`fn:y${i}`, 'c2')),
    }));

    const secondRunDirs = await fs.readdir(outputDir);
    expect(secondRunDirs).toContain('second');
    expect(secondRunDirs).not.toContain('first');
  });

  /**
   * The rendered SKILL.md should contain a stats line matching the
   * community's symbol count, file count, and cohesion percentage.
   */
  it('contains stats line with correct symbol count, file count, cohesion', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 5; i++) {
      graph.addNode(makeNode(`fn:s${i}`, `statsFn${i}`, 'Function', `${tmpDir}/src/stats/f${i}.ts`, 1, false));
    }

    const communities = [makeCommunity('c1', 'Stats', 5, 0.82)];
    const memberships = [0, 1, 2, 3, 4].map(i => makeMembership(`fn:s${i}`, 'c1'));

    await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'generated', 'stats', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('5 symbols | 5 files | Cohesion: 82%');
  });

  /**
   * Labels with special characters (like "C++ Core") should be converted
   * to a valid kebab-case directory name without crashing.
   */
  it('handles special characters in label for directory name', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:cpp${i}`, `cppFunc${i}`, 'Function', `${tmpDir}/src/cpp/f${i}.ts`, 1, false));
    }

    const communities = [makeCommunity('c1', 'C++ Core', 4)];
    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:cpp${i}`, 'c1'));

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);
    // The kebab name should only contain lowercase alphanumerics and dashes
    expect(result.skills[0].name).toMatch(/^[a-z0-9-]+$/);

    const skillPath = path.join(tmpDir, '.claude', 'skills', 'generated', result.skills[0].name, 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  /**
   * Nodes with no filePath should not crash the generator.
   * The skill should still be generated with fileCount 0.
   */
  it('handles nodes with no filePath', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(`fn:nf${i}`, `nofileFunc${i}`, 'Function', '', 0, false));
    }

    const communities = [makeCommunity('c1', 'NoFile', 4)];
    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:nf${i}`, 'c1'));

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].fileCount).toBe(0);
  });

  /**
   * Node filePaths containing Windows-style backslashes should be
   * normalized to forward slashes in the Key Files table (which uses
   * toRelativePath). The Key Symbols table renders raw filePath as-is,
   * so we only check the Key Files section for normalization.
   */
  it('normalizes Windows backslash paths in Key Files output', async () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 4; i++) {
      graph.addNode(makeNode(
        `fn:w${i}`, `winFunc${i}`, 'Function',
        `${tmpDir}\\src\\win\\f${i}.ts`, 1, false,
      ));
    }

    const communities = [makeCommunity('c1', 'Win', 4)];
    const memberships = [0, 1, 2, 3].map(i => makeMembership(`fn:w${i}`, 'c1'));

    const result = await generateSkillFiles(tmpDir, 'TestProject', buildPipelineResult({
      graph, repoPath: tmpDir, communities, memberships,
    }));

    expect(result.skills).toHaveLength(1);

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'generated', 'win', 'SKILL.md'),
      'utf-8',
    );

    // Extract the Key Files section between "## Key Files" and the next "##"
    const keyFilesMatch = content.match(/## Key Files\n([\s\S]*?)(?=\n##)/);
    expect(keyFilesMatch).not.toBeNull();
    const keyFilesSection = keyFilesMatch![1];
    // Key Files section should use forward slashes only
    expect(keyFilesSection).not.toMatch(/\\/);
    // Verify it actually has file paths
    expect(keyFilesSection).toContain('src/win/f0.ts');
  });
});
