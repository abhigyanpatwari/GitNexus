import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { getStoragePaths, registerRepo, saveMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const REPO = 'query-integrity';
const nodes = {
  alpha: { id: 'Function:src/alpha.ts:runSweep', name: 'runSweep', filePath: 'src/alpha.ts' },
  alphaCaller: {
    id: 'Function:src/α/caller.ts:appelÉ',
    name: 'appelÉ',
    filePath: 'src/α/caller.ts',
  },
  alphaOtherCaller: {
    id: 'Function:src/other.ts:runOther',
    name: 'runOther',
    filePath: 'src/other.ts',
  },
  alphaRoot: { id: 'Function:src/root.ts:startSweep', name: 'startSweep', filePath: 'src/root.ts' },
  alphaReader: {
    id: 'Function:src/reader.ts:readSweep',
    name: 'readSweep',
    filePath: 'src/reader.ts',
  },
  beta: {
    id: 'Function:src/beta.ts:extractLeadingNumber',
    name: 'extractLeadingNumber',
    filePath: 'src/beta.ts',
  },
  betaCaller: {
    id: 'Function:src/number.ts:parseNumber',
    name: 'parseNumber',
    filePath: 'src/number.ts',
  },
  betaReader: {
    id: 'Function:src/number-view.ts:readNumber',
    name: 'readNumber',
    filePath: 'src/number-view.ts',
  },
} as const;

const processes = {
  alpha: {
    id: 'process:alpha',
    label: 'Sweep flow',
    entry: nodes.alphaRoot,
    terminal: nodes.alpha,
    stepCount: 3,
  },
  alphaOther: {
    id: 'process:alpha-other',
    label: 'Other sweep flow',
    entry: nodes.alphaOtherCaller,
    terminal: nodes.alpha,
    stepCount: 2,
  },
  beta: {
    id: 'process:beta',
    label: 'Number flow',
    entry: nodes.betaCaller,
    terminal: nodes.beta,
    stepCount: 2,
  },
} as const;

type NodeIdentity = { id: string; name: string; filePath: string };
type Membership = { id: string; label: string; processType: string; step: number };
type ImpactRow = NodeIdentity & {
  relationType: string;
  confidence: number;
  processes: Membership[];
};
type ContextRef = { uid: string; name: string; filePath: string };
type Target = 'alpha' | 'beta';

const membership = (
  process: (typeof processes)[keyof typeof processes],
  step: number,
): Membership => ({
  id: process.id,
  label: process.label,
  processType: 'intra_community',
  step,
});

const affectedProcess = (process: (typeof processes)[keyof typeof processes], hits: number) => ({
  name: process.entry.name,
  type: 'Function',
  filePath: process.entry.filePath,
  affected_process_count: 1,
  total_hits: hits,
  earliest_broken_step: 0,
});

const oracle = {
  alpha: {
    count: 3,
    direct: 2,
    byDepth: {
      1: [
        {
          ...nodes.alphaOtherCaller,
          relationType: 'CALLS',
          confidence: 1,
          processes: [membership(processes.alphaOther, 0)],
        },
        {
          ...nodes.alphaCaller,
          relationType: 'CALLS',
          confidence: 1,
          processes: [membership(processes.alpha, 1)],
        },
      ],
      2: [
        {
          ...nodes.alphaRoot,
          relationType: 'CALLS',
          confidence: 1,
          processes: [membership(processes.alpha, 0)],
        },
      ],
    },
    callers: [nodes.alphaOtherCaller, nodes.alphaCaller],
    accesses: [nodes.alphaReader],
    processes: [
      { id: processes.alpha.id, name: processes.alpha.label, step_index: 2, step_count: 3 },
      {
        id: processes.alphaOther.id,
        name: processes.alphaOther.label,
        step_index: 1,
        step_count: 2,
      },
    ],
    affectedProcesses: [
      affectedProcess(processes.alpha, 2),
      affectedProcess(processes.alphaOther, 1),
    ],
  },
  beta: {
    count: 1,
    direct: 1,
    byDepth: {
      1: [
        {
          ...nodes.betaCaller,
          relationType: 'CALLS',
          confidence: 1,
          processes: [membership(processes.beta, 0)],
        },
      ],
    },
    callers: [nodes.betaCaller],
    accesses: [nodes.betaReader],
    processes: [
      { id: processes.beta.id, name: processes.beta.label, step_index: 1, step_count: 2 },
    ],
    affectedProcesses: [affectedProcess(processes.beta, 1)],
  },
} as const;

// Compare the values returned by the native engine with a hand-written graph
// oracle, rather than accepting a repeated (and potentially wrong) first result.
function expectImpact(
  result: Awaited<ReturnType<LocalBackend['callTool']>>,
  target: Target,
  summaryOnly: boolean,
): void {
  const expected = oracle[target];
  expect(result).not.toHaveProperty('error');
  expect(result).not.toHaveProperty('partial');
  expect(result.target).toMatchObject(nodes[target]);
  expect(result.direction).toBe('upstream');
  expect(result.impactedCount).toBe(expected.count);
  expect(result.risk).toBe('LOW');
  expect(result.epistemic).toBe('exact');
  expect(result.summary).toEqual({
    direct: expected.direct,
    processes_affected: expected.affectedProcesses.length,
    modules_affected: 0,
  });
  expect(result.byDepthCounts).toEqual(target === 'alpha' ? { 1: 2, 2: 1 } : { 1: 1 });
  expect(result.affected_processes).toEqual(expected.affectedProcesses);
  expect(result.affected_modules).toEqual([]);
  expect(result.affected_routes).toEqual([]);
  if (summaryOnly) {
    expect(result).not.toHaveProperty('byDepth');
  } else {
    const byDepth = Object.fromEntries(
      Object.entries(result.byDepth).map(([depth, rows]) => [
        depth,
        (rows as ImpactRow[]).map(
          ({ id, name, filePath, relationType, confidence, processes: memberships }) => ({
            id,
            name,
            filePath,
            relationType,
            confidence,
            processes: memberships,
          }),
        ),
      ]),
    );
    expect(byDepth).toEqual(expected.byDepth);
  }
}

function expectContext(
  result: Awaited<ReturnType<LocalBackend['callTool']>>,
  target: Target,
): void {
  const expected = oracle[target];
  expect(result).not.toHaveProperty('error');
  expect(result.status).toBe('found');
  expect(result.symbol).toMatchObject({
    uid: nodes[target].id,
    name: nodes[target].name,
    filePath: nodes[target].filePath,
  });
  expect(result.epistemic).toBe('exact');
  const incoming = Object.fromEntries(
    Object.entries(result.incoming).map(([type, refs]) => [
      type,
      (refs as ContextRef[]).map(({ uid, name, filePath }) => ({ id: uid, name, filePath })),
    ]),
  );
  expect(incoming).toEqual({ calls: expected.callers, accesses: expected.accesses });
  expect(result.outgoing).toEqual({});
  expect(result.processes).toEqual(expected.processes);
}

function edge(source: NodeIdentity, target: NodeIdentity, type: 'CALLS' | 'ACCESSES'): string {
  return `MATCH (a:Function {id: '${source.id}'}), (b:Function {id: '${target.id}'}) CREATE (a)-[:CodeRelation {type: '${type}', confidence: 1.0, reason: 'direct', step: 0}]->(b)`;
}

function processStep(
  node: NodeIdentity,
  process: (typeof processes)[keyof typeof processes],
  step: number,
): string {
  return `MATCH (n:Function {id: '${node.id}'}), (p:Process {id: '${process.id}'}) CREATE (n)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: 'trace-detection', step: ${step}}]->(p)`;
}

describe('native impact/context result integrity (#3354)', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let backend: LocalBackend;
  let lbugPath: string;

  beforeAll(async () => {
    temp = await createTempDir();
    vi.stubEnv('GITNEXUS_HOME', path.join(temp.dbPath, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', path.join(temp.dbPath, 'index'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    const paths = getStoragePaths(temp.dbPath);
    lbugPath = paths.lbugPath;

    // Close the writer before LocalBackend opens its ordinary read pool. No
    // mocked registry or injected writable Database bypasses the read path.
    await adapter.initLbug(lbugPath);
    try {
      const seed = [
        ...Object.values(nodes).map(
          (node) =>
            `CREATE (:Function {id: '${node.id}', name: '${node.name}', filePath: '${node.filePath}', startLine: 1, endLine: 3})`,
        ),
        ...Object.values(processes).map(
          (process) =>
            `CREATE (:Process {id: '${process.id}', label: '${process.label}', heuristicLabel: '${process.label}', processType: 'intra_community', stepCount: ${process.stepCount}, communities: [], entryPointId: '${process.entry.id}', terminalId: '${process.terminal.id}'})`,
        ),
        edge(nodes.alphaCaller, nodes.alpha, 'CALLS'),
        edge(nodes.alphaOtherCaller, nodes.alpha, 'CALLS'),
        edge(nodes.alphaRoot, nodes.alphaCaller, 'CALLS'),
        edge(nodes.alphaReader, nodes.alpha, 'ACCESSES'),
        edge(nodes.betaCaller, nodes.beta, 'CALLS'),
        edge(nodes.betaReader, nodes.beta, 'ACCESSES'),
        processStep(nodes.alphaRoot, processes.alpha, 0),
        processStep(nodes.alphaCaller, processes.alpha, 1),
        processStep(nodes.alpha, processes.alpha, 2),
        processStep(nodes.alphaOtherCaller, processes.alphaOther, 0),
        processStep(nodes.alpha, processes.alphaOther, 1),
        processStep(nodes.betaCaller, processes.beta, 0),
        processStep(nodes.beta, processes.beta, 1),
      ];
      for (const query of seed) await adapter.executeQuery(query);
      await adapter.flushWAL();
    } finally {
      await adapter.closeLbug();
    }
    const meta = {
      repoPath: temp.dbPath,
      storagePath: paths.storagePath,
      lastCommit: 'integrity-fixture',
      indexedAt: new Date().toISOString(),
      scopeExtractionReceipt: 1 as const,
      stats: { files: 8, nodes: 11, processes: 3, communities: 0 },
    };
    await saveMeta(paths.storagePath, meta);
    await registerRepo(temp.dbPath, meta, { name: REPO });
    backend = new LocalBackend();
    expect(await backend.init()).toBe(true);
  });

  afterAll(async () => {
    try {
      await backend?.dispose();
    } finally {
      await adapter.closeLbug();
      vi.unstubAllEnvs();
      await temp?.cleanup();
    }
  });

  const impact = (target: Target, summaryOnly = false) =>
    backend.callTool('impact', {
      repo: REPO,
      target: nodes[target].name,
      direction: 'upstream',
      summaryOnly,
    });
  const context = (target: Target) =>
    backend.callTool('context', { repo: REPO, uid: nodes[target].id });

  it('returns exact values across identical sequential requests', async () => {
    for (let repeat = 0; repeat < 6; repeat++) {
      expectImpact(await impact('alpha', true), 'alpha', true);
      expectContext(await context('alpha'), 'alpha');
      expectImpact(await impact('alpha'), 'alpha', false);
    }
  });

  it('keeps unrelated targets isolated across mixed requests', async () => {
    for (const target of ['alpha', 'beta', 'beta', 'alpha'] as const) {
      expectImpact(await impact(target, true), target, true);
      expectContext(await context(target), target);
      expectImpact(await impact(target), target, false);
    }
  });

  it('keeps mixed concurrent prepared reads symbol-specific', async () => {
    for (let repeat = 0; repeat < 3; repeat++) {
      const results = await Promise.all([
        impact('alpha', true),
        context('beta'),
        impact('beta'),
        impact('beta', true),
        context('alpha'),
        impact('alpha'),
      ]);
      expectImpact(results[0], 'alpha', true);
      expectContext(results[1], 'beta');
      expectImpact(results[2], 'beta', false);
      expectImpact(results[3], 'beta', true);
      expectContext(results[4], 'alpha');
      expectImpact(results[5], 'alpha', false);
    }
  });

  it('returns exact relation rows directly from the pooled prepared adapter', async () => {
    // Warm the pool through the same backend, then check the native row
    // boundary independently of the tool's normalization and aggregation.
    expectContext(await context('alpha'), 'alpha');
    const read = (target: Target) =>
      executeParameterized(
        lbugPath,
        `
      MATCH (caller:Function)-[r:CodeRelation]->(target:Function {id: $id})
      WHERE r.type IN ['CALLS', 'ACCESSES']
      RETURN caller.id AS id, caller.name AS name, caller.filePath AS filePath, r.type AS relationType
      ORDER BY id
    `,
        { id: nodes[target].id },
      );
    const expectedRows = (target: Target) =>
      [
        ...oracle[target].callers.map((caller) => ({ ...caller, relationType: 'CALLS' })),
        ...oracle[target].accesses.map((reader) => ({ ...reader, relationType: 'ACCESSES' })),
      ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let repeat = 0; repeat < 4; repeat++) {
      expect(await read('alpha')).toEqual(expectedRows('alpha'));
      const [beta, alpha] = await Promise.all([read('beta'), read('alpha')]);
      expect(beta).toEqual(expectedRows('beta'));
      expect(alpha).toEqual(expectedRows('alpha'));
    }
  });
});
