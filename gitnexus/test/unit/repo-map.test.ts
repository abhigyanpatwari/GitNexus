import { describe, expect, it, vi } from 'vitest';
import {
  REPO_OVERVIEW_LIMITS,
  REPO_OVERVIEW_QUERIES,
  REPO_OVERVIEW_QUERY_BUDGET,
  REPO_OVERVIEW_QUERY_CONCURRENCY,
  formatRepoOverview,
  generateRepoOverview,
  moduleFromPath,
  repoOverviewCallQuery,
  type RepoOverviewDeps,
} from '../../src/mcp/local/repo-map.js';

type QueryLogEntry = { cypher: string; params: Record<string, unknown> };

const FIXTURE_LABELS = ['Function', 'Class', 'Method'];
const OUTGOING_CALL_QUERIES = new Set([
  REPO_OVERVIEW_QUERIES.outgoingCalls,
  ...FIXTURE_LABELS.map((label) => repoOverviewCallQuery('outgoing', label)),
]);
const INCOMING_CALL_QUERIES = new Set([
  REPO_OVERVIEW_QUERIES.incomingCalls,
  ...FIXTURE_LABELS.map((label) => repoOverviewCallQuery('incoming', label)),
]);

function createExecutor(router: (cypher: string, params: Record<string, unknown>) => unknown[]): {
  deps: RepoOverviewDeps;
  log: QueryLogEntry[];
} {
  const log: QueryLogEntry[] = [];
  return {
    log,
    deps: {
      executeParameterized: vi.fn(async (cypher, params) => {
        log.push({ cypher, params });
        return router(cypher, params);
      }),
    },
  };
}

function richRouter(cypher: string, params: Record<string, unknown>): unknown[] {
  const q = REPO_OVERVIEW_QUERIES;
  if (cypher === q.files) {
    return Array.from({ length: 30 }, (_, i) => ({
      id: `file:${i}`,
      name: `file${i}.ts`,
      filePath: `src/mod${i % 5}/file${i}.ts`,
    }));
  }
  if (cypher === q.initialSymbols) {
    return Array.from({ length: 16 }, (_, i) => ({
      id: `sym:init:${i}`,
      name: `Init${i}`,
      filePath: `src/mod${i % 5}/file${i}.ts`,
      label: 'Function',
      fileId: `file:${i}`,
    }));
  }
  if (cypher === q.communities) {
    return Array.from({ length: 8 }, (_, i) => ({
      id: `community:${i}`,
      label: `Cluster ${i}`,
      heuristicLabel: `Area ${i}`,
      symbolCount: 100 + i,
      cohesion: 0.5,
    }));
  }
  if (cypher === q.communityMembers) {
    return Array.from({ length: 64 }, (_, i) => ({
      communityId: `community:${i % 8}`,
      id: `sym:member:${i}`,
      name: `Member${i}`,
      filePath: `src/mod${i % 5}/member${i}.ts`,
      label: 'Class',
    }));
  }
  if (cypher === q.processHeaders) {
    return Array.from({ length: 8 }, (_, i) => ({
      id: `proc:${i}`,
      label: `Process ${i}`,
      heuristicLabel: `Flow ${i}`,
      stepCount: 12,
      processType: 'cross_community',
    }));
  }
  if (cypher === q.processSteps) {
    const pid = String(params.processId);
    return Array.from({ length: 8 }, (_, i) => ({
      id: `sym:step:${pid}:${i}`,
      name: `Step${i}`,
      filePath: `src/mod${i % 5}/step${i}.ts`,
      step: i + 1,
      label: 'Method',
    }));
  }
  if (OUTGOING_CALL_QUERIES.has(cypher) || INCOMING_CALL_QUERIES.has(cypher)) {
    const seedId = String(params.seedId);
    const prefix = cypher === q.outgoingCalls ? 'out' : 'in';
    return Array.from({ length: 8 }, (_, i) => ({
      id: `${prefix}:${seedId}:${i}`,
      name: `${prefix}Neighbor${i}`,
      filePath: `src/mod${(i + 1) % 5}/neighbor${i}.ts`,
      label: 'Method',
    }));
  }
  throw new Error(`unexpected query: ${cypher}`);
}

describe('moduleFromPath', () => {
  it('uses a stable two-segment directory prefix', () => {
    expect(moduleFromPath('src/mcp/local/repo-map.ts')).toBe('src/mcp');
    expect(moduleFromPath('packages\\cli\\src\\index.ts')).toBe('packages/cli');
    expect(moduleFromPath('auth.ts')).toBe('(root)');
    expect(moduleFromPath('')).toBe('(root)');
  });
});

describe('generateRepoOverview', () => {
  it('issues at most 77 bounded, anchored queries on a full cold call', async () => {
    const { deps, log } = createExecutor(richRouter);
    const overview = await generateRepoOverview(
      {
        name: 'demo',
        repoPath: '/tmp/demo',
        stats: { files: 100, nodes: 500, edges: 900, communities: 20, processes: 30 },
      },
      deps,
    );

    expect(overview.queryBudget.executed).toBeLessThanOrEqual(REPO_OVERVIEW_QUERY_BUDGET.total);
    expect(overview.queryBudget.executed).toBe(77);
    expect(overview.queryBudget.q3b).toBe(8);
    expect(overview.queryBudget.q4a).toBe(32);
    expect(overview.queryBudget.q4b).toBe(32);
    expect(overview.queryBudget.phases).toEqual({
      files: 1,
      initialSymbols: 1,
      communities: 1,
      communityMembers: 1,
      processHeaders: 1,
      processSteps: 8,
      outgoingCalls: 32,
      incomingCalls: 32,
    });

    for (const entry of log) {
      expect(entry.cypher).toMatch(/LIMIT \$limit/);
      expect(entry.cypher).not.toContain('MATCH ()-[');
      expect(
        typeof entry.params.limit === 'number' || typeof entry.params.seedId === 'string',
      ).toBe(true);
    }
    expect(REPO_OVERVIEW_QUERIES.outgoingCalls).not.toMatch(/ORDER BY/);
    expect(REPO_OVERVIEW_QUERIES.incomingCalls).not.toMatch(/ORDER BY/);
    expect(REPO_OVERVIEW_QUERIES.communityMembers).not.toMatch(/ORDER BY/);

    expect(log.find((e) => e.cypher === REPO_OVERVIEW_QUERIES.files)?.params).toEqual({
      limit: 30,
    });
    expect(log.find((e) => e.cypher === REPO_OVERVIEW_QUERIES.initialSymbols)?.params).toEqual({
      fileIds: expect.any(Array),
      limit: 16,
    });
    expect(log.find((e) => e.cypher === REPO_OVERVIEW_QUERIES.communityMembers)?.params).toEqual({
      communityIds: expect.any(Array),
      limit: 64,
    });
    expect(log.filter((e) => e.cypher === REPO_OVERVIEW_QUERIES.processSteps)).toHaveLength(8);
    for (const entry of log.filter((e) => e.cypher === REPO_OVERVIEW_QUERIES.processSteps)) {
      expect(entry.params).toEqual({ processId: expect.stringMatching(/^proc:/), limit: 8 });
    }
    const callEntries = log.filter(
      (e) => OUTGOING_CALL_QUERIES.has(e.cypher) || INCOMING_CALL_QUERIES.has(e.cypher),
    );
    expect(callEntries).toHaveLength(64);
    for (const entry of callEntries) {
      expect(entry.params).toEqual({ seedId: expect.any(String), limit: 8 });
    }
  });

  it('reports sampled modules, hubs, workflows, boundaries and completeness', async () => {
    const { deps } = createExecutor(richRouter);
    const overview = await generateRepoOverview(
      {
        name: 'demo',
        stats: { files: 100, nodes: 500, edges: 900, communities: 20, processes: 30 },
      },
      deps,
    );

    expect(overview.nodeCount).toBe(500);
    expect(overview.edgeCount).toBe(900);
    expect(overview.modules.length).toBeGreaterThan(0);
    expect(overview.modules.every((m) => m.sampled && m.fileCount <= 30)).toBe(true);
    expect(overview.modules[0].language).toBe('TypeScript');

    expect(overview.architecturalHubs.length).toBeGreaterThan(0);
    expect(overview.architecturalHubs[0].ranking).toBe('sampled-candidates-only');
    expect(overview.architecturalHubs[0].degree).toBe(
      overview.architecturalHubs[0].sampledIncoming + overview.architecturalHubs[0].sampledOutgoing,
    );
    for (const hub of overview.architecturalHubs) {
      expect(hub.responsibilities.length).toBeLessThanOrEqual(
        REPO_OVERVIEW_LIMITS.maxResponsibilities,
      );
      for (const responsibility of hub.responsibilities) {
        expect(responsibility.inferred).toBe(true);
        expect(responsibility.basis).toBe('sampled CALLS edges');
      }
    }

    expect(overview.workflows).toHaveLength(8);
    expect(overview.workflows[0]).toMatchObject({
      processId: expect.any(String),
      label: expect.any(String),
      stepCount: 12,
      sampledSteps: 8,
      stepsTruncated: true,
      sampled: true,
    });
    expect(overview.integrationBoundaries.length).toBeGreaterThan(0);
    expect(overview.integrationBoundaries.every((b) => b.inferred)).toBe(true);
    expect(overview.integrationBoundaries).toEqual(
      [...overview.integrationBoundaries].sort(
        (a, b) =>
          b.callCount - a.callCount ||
          a.fromModule.localeCompare(b.fromModule) ||
          a.toModule.localeCompare(b.toModule),
      ),
    );

    expect(overview.completeness.files).toMatchObject({ returned: 30, limit: 30, truncated: true });
    expect(overview.completeness.communities.truncated).toBe(true);
    expect(overview.completeness.processes.truncated).toBe(true);
    expect(overview.sampling).toMatchObject({
      hubsAreGloballyRanked: false,
      integrationBoundariesAreGloballyRanked: false,
      neighborSelectionDeterministic: false,
      responsibilitiesInferred: true,
    });
    expect(overview.warnings.join('\n')).toMatch(/SAMPLED CANDIDATES|sampled candidates/);
    expect(overview.warnings.join('\n')).toMatch(/nondeterministic/);
    expect(overview.warnings.join('\n')).toMatch(/INFERRED|inferred/);
  });

  it('anchors CALLS queries on sampled node labels and falls back safely', async () => {
    const { deps, log } = createExecutor((cypher) => {
      const q = REPO_OVERVIEW_QUERIES;
      if (cypher === q.files) {
        return [{ id: 'f1', name: 'a.ts', filePath: 'src/a/a.ts' }];
      }
      if (cypher === q.initialSymbols) {
        return [
          { id: 's1', name: 'S1', filePath: 'src/a/s1.ts', label: ['Function'], fileId: 'f1' },
          {
            id: 's2',
            name: 'S2',
            filePath: 'src/a/s2.ts',
            label: 'not a valid label!',
            fileId: 'f1',
          },
        ];
      }
      if (cypher === q.communities || cypher === q.processHeaders) return [];
      if (OUTGOING_CALL_QUERIES.has(cypher) || INCOMING_CALL_QUERIES.has(cypher)) return [];
      throw new Error(`unexpected query: ${cypher}`);
    });

    await generateRepoOverview({ name: 'labels' }, deps);

    expect(log.some((e) => e.cypher === repoOverviewCallQuery('outgoing', 'Function'))).toBe(true);
    expect(log.some((e) => e.cypher === repoOverviewCallQuery('incoming', 'Function'))).toBe(true);
    expect(
      log.filter((e) => e.cypher === REPO_OVERVIEW_QUERIES.outgoingCalls).map((e) => e.params),
    ).toEqual([{ seedId: 's2', limit: 8 }]);
    expect(
      log.filter((e) => e.cypher === REPO_OVERVIEW_QUERIES.incomingCalls).map((e) => e.params),
    ).toEqual([{ seedId: 's2', limit: 8 }]);
  });

  it('runs independent seed lookups with bounded concurrency', async () => {
    let started = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirstBatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    const deps: RepoOverviewDeps = {
      executeParameterized: vi.fn(async (cypher, params) => {
        if (OUTGOING_CALL_QUERIES.has(cypher) || INCOMING_CALL_QUERIES.has(cypher)) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const position = started++;
          if (position < REPO_OVERVIEW_QUERY_CONCURRENCY) await gate;
          active -= 1;
          return [];
        }
        return richRouter(cypher, params);
      }),
    };

    const pending = generateRepoOverview({ name: 'demo' }, deps);
    for (let i = 0; i < 20 && started < REPO_OVERVIEW_QUERY_CONCURRENCY; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(started).toBe(REPO_OVERVIEW_QUERY_CONCURRENCY);
    expect(maxActive).toBe(REPO_OVERVIEW_QUERY_CONCURRENCY);

    releaseFirstBatch();
    await pending;
    expect(maxActive).toBe(REPO_OVERVIEW_QUERY_CONCURRENCY);
  });

  it('degrades cleanly when symbol/community/process seeds are absent', async () => {
    const { deps, log } = createExecutor((cypher, params) => {
      const q = REPO_OVERVIEW_QUERIES;
      if (cypher === q.files) {
        return [
          { id: 'f1', name: 'auth.ts', filePath: 'src/auth/auth.ts' },
          { id: 'f2', name: 'util.py', filePath: 'tools/util.py' },
        ];
      }
      if (cypher === q.initialSymbols || cypher === q.communities || cypher === q.processHeaders) {
        return [];
      }
      throw new Error(`unexpected query: ${JSON.stringify(params)} (${cypher})`);
    });
    const overview = await generateRepoOverview({ name: 'tiny' }, deps);

    expect(overview.modules.map((m) => m.path).sort()).toEqual(['src/auth', 'tools']);
    expect(overview.modules.find((m) => m.path === 'tools')?.language).toBe('Python');
    expect(overview.architecturalHubs).toEqual([]);
    expect(overview.integrationBoundaries).toEqual([]);
    expect(overview.workflows).toEqual([]);
    expect(overview.warnings.join('\n')).toMatch(/No symbol seeds were available/);
    expect(log.some((e) => e.cypher === REPO_OVERVIEW_QUERIES.outgoingCalls)).toBe(false);
    expect(overview.queryBudget.executed).toBe(4);
  });

  it('keeps a query failure as a warning instead of failing the overview', async () => {
    const { deps } = createExecutor((cypher, params) => {
      if (cypher === REPO_OVERVIEW_QUERIES.communities) throw new Error('table missing');
      return richRouter(cypher, params);
    });
    const overview = await generateRepoOverview({ name: 'demo' }, deps);

    expect(overview.communities).toEqual([]);
    expect(overview.warnings.join('\n')).toMatch(
      /communities query failed; its sample is incomplete: table missing/,
    );
    expect(overview.queryBudget.phases.communities).toBe(1);
  });

  it('renders concise markdown that labels sampling limits', async () => {
    const { deps } = createExecutor(richRouter);
    const overview = await generateRepoOverview({ name: 'demo' }, deps);
    const markdown = formatRepoOverview(overview);

    expect(markdown).toContain('# Repository: demo');
    expect(markdown).toContain('## Modules (bounded file sample)');
    expect(markdown).toContain('## Architectural Hubs (sampled candidates; not globally ranked)');
    expect(markdown).toContain('## Workflows (sampled processes)');
    expect(markdown).toContain('## Integration Boundaries (sampled cross-module CALLS)');
    expect(markdown).toContain('neighbor selection is nondeterministic');
    expect(markdown).toContain(' responsibilities are inferred');
    expect(markdown.length).toBeLessThan(12_000);
  });
});
