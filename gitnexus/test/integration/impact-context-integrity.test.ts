import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { retryRename } from '../../src/storage/fs-atomic.js';
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

describe('native string projections after checkpointed deletion (#3354)', () => {
  it('keeps long symbol identities associated with their source rows across segments', async () => {
    const temp = await createTempDir();
    const db = new lbug.Database(path.join(temp.dbPath, 'scan.lbug'), 128 * 1024 * 1024);
    const conn = new lbug.Connection(db, 4);
    const source = Array.from({ length: 10_000 }, (_, startLine) => ({
      id: `Function:src/generated/rené-${String(startLine).padStart(5, '0')}.ts:fn${startLine}`,
      name: `generated_function_${startLine}_é`,
      filePath: `src/generated/rené-${String(startLine).padStart(5, '0')}.ts`,
      startLine,
    }));
    const projection =
      'RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine';
    const read = async (query: string) => {
      const result = await conn.query(query);
      try {
        const cursor = Array.isArray(result) ? result[0] : result;
        return await cursor.getAll();
      } finally {
        await closeQueryResults(result);
      }
    };

    try {
      await read(
        'CREATE NODE TABLE Function(id STRING, name STRING, filePath STRING, startLine INT64, PRIMARY KEY(id))',
      );
      // Separate checkpoints create segment boundaries inside scan vectors.
      // LadybugDB 0.18.3's filtered STRING scan could retain another row's
      // printable identities here (LadybugDB/ladybug#678, fixed by #737).
      for (let batch = 0; batch < 4; batch++) {
        const csvPath = path.join(temp.dbPath, `rows-${batch}.csv`);
        const csv = source
          .slice(batch * 2500, (batch + 1) * 2500)
          .map((row) =>
            Object.values(row)
              .map((value) => JSON.stringify(value))
              .join(','),
          )
          .join('\n');
        await fs.writeFile(csvPath, `${csv}\n`);
        await read(
          `COPY Function FROM ${JSON.stringify(csvPath.replaceAll('\\', '/'))} (HEADER=false)`,
        );
        await read('CHECKPOINT');
      }
      expect(await read(`MATCH (n:Function) ${projection} ORDER BY n.startLine`)).toEqual(source);

      await read(
        'MATCH (n:Function) WHERE n.startLine >= 3000 AND n.startLine < 3400 DETACH DELETE n',
      );
      await read('CHECKPOINT');
      const surviving = source.filter((row) => row.startLine < 3000 || row.startLine >= 3400);
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const order of ['', ' ORDER BY n.startLine']) {
          const rows = await read(`MATCH (n:Function) ${projection}${order}`);
          expect(new Set(rows.map((row) => row.id)).size).toBe(surviving.length);
          expect(
            rows.sort((a, b) => {
              if (typeof a.startLine !== 'number' || typeof b.startLine !== 'number') {
                throw new Error('Expected numeric startLine values from the database');
              }
              return a.startLine - b.startLine;
            }),
          ).toEqual(surviving);
        }
      }
      // Point lookups independently verify values in the affected segments;
      // a repeatably wrong scan must never become the test's reference answer.
      for (const startLine of [1600, 7486]) {
        expect(
          await read(`MATCH (n:Function {id: '${source[startLine].id}'}) ${projection}`),
        ).toEqual([source[startLine]]);
      }
      expect(await read(`MATCH (n:Function {id: '${source[3000].id}'}) ${projection}`)).toEqual([]);
    } finally {
      try {
        await conn.close();
      } finally {
        try {
          await db.close();
        } finally {
          await temp.cleanup();
        }
      }
    }
  });
});

// Windows graph replacement is opt-in in production. The repeated-read
// characterization above remains enabled there; only this POSIX swap is skipped.
describe.skipIf(process.platform === 'win32')('warm backend index replacement (#3354)', () => {
  it('reads changed callers, processes and a new symbol through the real freshness window', async () => {
    const temp = await createTempDir();
    let backend: LocalBackend | undefined;
    vi.stubEnv('GITNEXUS_HOME', path.join(temp.dbPath, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', path.join(temp.dbPath, 'index'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    const paths = getStoragePaths(temp.dbPath);
    const stagedPath = `${paths.lbugPath}.replacement`;
    const replacement = {
      entry: {
        id: 'Function:src/replacement-entry.ts:startReplacement',
        name: 'startReplacement',
        filePath: 'src/replacement-entry.ts',
      },
      caller: {
        id: 'Function:src/replacement-caller.ts:callReplacement',
        name: 'callReplacement',
        filePath: 'src/replacement-caller.ts',
      },
      reader: {
        id: 'Function:src/replacement-reader.ts:readReplacement',
        name: 'readReplacement',
        filePath: 'src/replacement-reader.ts',
      },
    };
    const nextProcess = { id: 'process:replacement', label: 'Replacement flow' };
    const oldProcess = processes.alphaOther;

    const seed = async (dbPath: string, next: boolean) => {
      await adapter.initLbug(dbPath);
      try {
        const caller = next ? replacement.caller : nodes.alphaOtherCaller;
        const reader = next ? replacement.reader : nodes.alphaReader;
        const process = next ? nextProcess : oldProcess;
        const entry = next ? replacement.entry : caller;
        for (const node of [nodes.alpha, caller, reader, ...(next ? [entry] : [])]) {
          await adapter.executeQuery(
            `CREATE (:Function {id: '${node.id}', name: '${node.name}', filePath: '${node.filePath}', startLine: 1, endLine: 3})`,
          );
        }
        await adapter.executeQuery(
          `CREATE (:Process {id: '${process.id}', label: '${process.label}', heuristicLabel: '${process.label}', processType: 'intra_community', stepCount: ${next ? 3 : 2}, communities: [], entryPointId: '${entry.id}', terminalId: '${nodes.alpha.id}'})`,
        );
        await adapter.executeQuery(edge(caller, nodes.alpha, 'CALLS'));
        await adapter.executeQuery(edge(reader, nodes.alpha, 'ACCESSES'));
        if (next) await adapter.executeQuery(edge(entry, caller, 'CALLS'));
        const steps = next ? [entry, caller, nodes.alpha] : [caller, nodes.alpha];
        for (const [step, node] of steps.entries()) {
          await adapter.executeQuery(
            `MATCH (n:Function {id: '${node.id}'}), (p:Process {id: '${process.id}'}) CREATE (n)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: 'trace-detection', step: ${step}}]->(p)`,
          );
        }
        await adapter.flushWAL();
      } finally {
        await adapter.closeLbug();
      }
    };
    const processMembership = (next: boolean, step: number) => ({
      ...(next ? nextProcess : { id: oldProcess.id, label: oldProcess.label }),
      processType: 'intra_community',
      step,
    });
    const expectedCaller = (node: NodeIdentity, next: boolean, step: number) => ({
      ...node,
      relationType: 'CALLS',
      confidence: 1,
      processes: [processMembership(next, step)],
    });
    const expectGeneration = (
      impact: Awaited<ReturnType<LocalBackend['callTool']>>,
      context: Awaited<ReturnType<LocalBackend['callTool']>>,
      next: boolean,
    ) => {
      const caller = next ? replacement.caller : nodes.alphaOtherCaller;
      const reader = next ? replacement.reader : nodes.alphaReader;
      const entry = next ? replacement.entry : caller;
      const process = next ? nextProcess : oldProcess;
      expect(impact).not.toHaveProperty('error');
      expect(impact).not.toHaveProperty('partial');
      expect(impact.target).toMatchObject(nodes.alpha);
      expect(impact.risk).toBe('LOW');
      expect(impact.epistemic).toBe('exact');
      expect(impact.impactedCount).toBe(next ? 2 : 1);
      expect(impact.summary).toEqual({ direct: 1, processes_affected: 1, modules_affected: 0 });
      expect(impact.byDepthCounts).toEqual(next ? { 1: 1, 2: 1 } : { 1: 1 });
      const byDepth = Object.fromEntries(
        Object.entries(impact.byDepth).map(([depth, rows]) => [
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
      expect(byDepth).toEqual({
        1: [expectedCaller(caller, next, next ? 1 : 0)],
        ...(next ? { 2: [expectedCaller(entry, true, 0)] } : {}),
      });
      expect(impact.affected_processes).toEqual([
        {
          name: entry.name,
          type: 'Function',
          filePath: entry.filePath,
          affected_process_count: 1,
          total_hits: next ? 2 : 1,
          earliest_broken_step: 0,
        },
      ]);
      expect(impact.affected_modules).toEqual([]);
      expect(impact.affected_routes).toEqual([]);
      expect(context).not.toHaveProperty('error');
      expect(context.status).toBe('found');
      expect(context.epistemic).toBe('exact');
      expect(context.symbol).toMatchObject({
        uid: nodes.alpha.id,
        name: nodes.alpha.name,
        filePath: nodes.alpha.filePath,
      });
      expect(
        Object.fromEntries(
          Object.entries(context.incoming).map(([type, refs]) => [
            type,
            (refs as ContextRef[]).map(({ uid, name, filePath }) => ({ id: uid, name, filePath })),
          ]),
        ),
      ).toEqual({ calls: [caller], accesses: [reader] });
      expect(context.outgoing).toEqual({});
      expect(context.processes).toEqual([
        {
          id: process.id,
          name: process.label,
          step_index: next ? 2 : 1,
          step_count: next ? 3 : 2,
        },
      ]);
    };

    try {
      await seed(paths.lbugPath, false);
      const meta = {
        repoPath: temp.dbPath,
        storagePath: paths.storagePath,
        lastCommit: 'graph-a',
        indexedAt: new Date().toISOString(),
        scopeExtractionReceipt: 1 as const,
        stats: { files: 3, nodes: 4, processes: 1, communities: 0 },
      };
      await saveMeta(paths.storagePath, meta);
      await registerRepo(temp.dbPath, meta, { name: REPO });
      const heldBackend = new LocalBackend();
      backend = heldBackend;
      expect(await heldBackend.init()).toBe(true);
      const impact = () =>
        heldBackend.callTool('impact', {
          repo: REPO,
          target: nodes.alpha.name,
          direction: 'upstream',
        });
      const context = () => heldBackend.callTool('context', { repo: REPO, uid: nodes.alpha.id });
      expectGeneration(await impact(), await context(), false);
      expect(
        await heldBackend.callTool('context', { repo: REPO, uid: replacement.entry.id }),
      ).toHaveProperty('error');

      // Keep this backend and its read pool alive. Publish only after the
      // separate staged writer has closed, exactly as run-analyze does.
      await seed(stagedPath, true);
      for (const suffix of ['.wal', '.shadow', '.wal.checkpoint']) {
        await expect(fs.stat(`${stagedPath}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await retryRename(stagedPath, paths.lbugPath);
      const nextMeta = {
        ...meta,
        lastCommit: 'graph-b',
        indexedAt: new Date(Date.now() + 1).toISOString(),
        stats: { files: 4, nodes: 5, processes: 1, communities: 0 },
      };
      await saveMeta(paths.storagePath, nextMeta);
      await registerRepo(temp.dbPath, nextMeta, { name: REPO });

      // An independent native read-only Database opens the published path.
      // It does not share LocalBackend's pool or trigger its reinitialization.
      const freshDb = new lbug.Database(paths.lbugPath, 128 * 1024 * 1024, true, true);
      const freshConn = new lbug.Connection(freshDb);
      try {
        const read = async (query: string) => {
          const result = await freshConn.query(query);
          try {
            const cursor = Array.isArray(result) ? result[0] : result;
            return await cursor.getAll();
          } finally {
            await closeQueryResults(result);
          }
        };
        expect(
          await read(`
          MATCH (n:Function)
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath
          ORDER BY id
        `),
        ).toEqual(
          [nodes.alpha, ...Object.values(replacement)].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          ),
        );
        expect(
          await read(`
          MATCH (n:Function)-[r:CodeRelation]->(target:Function {id: '${nodes.alpha.id}'})
          WHERE r.type IN ['CALLS', 'ACCESSES']
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, r.type AS relationType
          ORDER BY id
        `),
        ).toEqual([
          { ...replacement.caller, relationType: 'CALLS' },
          { ...replacement.reader, relationType: 'ACCESSES' },
        ]);
        expect(
          await read(`
          MATCH (n:Function)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN n.id AS id, p.id AS processId, p.heuristicLabel AS label,
                 r.step AS step, p.stepCount AS stepCount, p.entryPointId AS entryPointId
          ORDER BY step
        `),
        ).toEqual(
          [replacement.entry, replacement.caller, nodes.alpha].map((node, step) => ({
            id: node.id,
            processId: nextProcess.id,
            label: nextProcess.label,
            step,
            stepCount: 3,
            entryPointId: replacement.entry.id,
          })),
        );
      } finally {
        await freshConn.close();
        await freshDb.close();
      }

      // Poll the SAME backend through its unchanged five-second throttle.
      // No private watermark override, poolInit, reset or restart is used.
      const deadline = Date.now() + 15_000;
      let refreshed = await context();
      while (refreshed.processes?.[0]?.id !== nextProcess.id && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        refreshed = await context();
      }
      expectGeneration(await impact(), refreshed, true);
      for (let repeat = 0; repeat < 3; repeat++) {
        expectGeneration(await impact(), await context(), true);
        const introduced = await heldBackend.callTool('context', {
          repo: REPO,
          name: replacement.entry.name,
        });
        expect(introduced).not.toHaveProperty('error');
        expect(introduced.status).toBe('found');
        expect(introduced.symbol).toMatchObject({
          uid: replacement.entry.id,
          name: replacement.entry.name,
          filePath: replacement.entry.filePath,
        });
        expect(introduced.processes).toEqual([
          { id: nextProcess.id, name: nextProcess.label, step_index: 0, step_count: 3 },
        ]);
      }
    } finally {
      try {
        await backend?.dispose();
      } finally {
        await adapter.closeLbug();
        vi.unstubAllEnvs();
        await temp.cleanup();
      }
    }
  });
});
