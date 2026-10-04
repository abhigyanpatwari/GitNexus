/** Corrupt detail rows must not become usable context/impact answers (#3354). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, aop } = vi.hoisted(() => ({
  db: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  aop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...db,
}));
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...db,
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'integrity-fixture',
      path: '/tmp/integrity-fixture',
      storagePath: '/tmp/integrity-fixture/.gitnexus',
      indexedAt: '2026-10-03T12:00:00Z',
      lastCommit: 'fixture',
      stats: { files: 2, nodes: 2, edges: 1, communities: 0, processes: 1 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
  loadMeta: vi.fn().mockResolvedValue({
    pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
  }),
}));
vi.mock('../../src/core/git-staleness.js', () => ({
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));
vi.mock('../../src/storage/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/git.js')>()),
  getGitRoot: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/mcp/local/aop-metadata.js', () => ({ querySpringAopMetadata: aop }));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { SymbolIdentityError } from '../../src/mcp/local/query-result-integrity.js';

const TARGET = {
  id: 'func:target',
  name: 'target',
  type: 'Function',
  filePath: 'src/target.ts',
  startLine: 1,
  endLine: 4,
};
const REF = {
  relType: 'CALLS',
  uid: 'func:caller',
  name: 'caller',
  filePath: 'src/caller.ts',
  kind: 'Function',
};
const EDGE = {
  sourceId: TARGET.id,
  id: REF.uid,
  name: REF.name,
  type: REF.kind,
  filePath: REF.filePath,
  relType: 'CALLS',
  confidence: 1,
};
const PROCESS = {
  pId: 'proc:caller',
  name: 'Caller flow',
  processType: 'intra_community',
  entryPointId: REF.uid,
  hits: 1,
  minStep: 0,
  stepCount: 2,
  epName: REF.name,
  epType: REF.kind,
  epFilePath: REF.filePath,
};
const BAD = 'corrupt\0persisted-value';

type Seam =
  | 'target'
  | 'targetLabels'
  | 'aopRows'
  | 'pdgSeed'
  | 'pdgNeighbor'
  | 'pdgOwner'
  | 'pdgStatement'
  | 'pdgSelf'
  | 'pdgCalleeBlocks'
  | 'pdgSummary'
  | 'pdgSpans'
  | 'incoming'
  | 'classIncoming'
  | 'outgoing'
  | 'typedProperties'
  | 'contextProcess'
  | 'contextRoute'
  | 'chain'
  | 'seeds'
  | 'members'
  | 'frontier'
  | 'process'
  | 'backfill'
  | 'membership'
  | 'modules'
  | 'impactRoute'
  | 'metadata';
let backend: LocalBackend;
let rows: Partial<Record<Seam, unknown[]>>;
let failedSeam: Seam | undefined;

function fixture(seam: Seam): unknown[] {
  if (failedSeam === seam) throw new Error('ordinary unavailable query');
  return rows[seam] ?? [];
}

function querySeam(query: string, params: Record<string, any> | undefined): Seam | undefined {
  if (params?.symName || params?.uid) return 'target';
  if (query.includes("RETURN n.id AS id, 'Class' AS label")) return 'targetLabels';
  if (query.includes("r.reason STARTS WITH 'spring-aop:v1:'")) return 'aopRows';
  if (query.includes('RETURN s.id AS id, s.name AS name')) return 'pdgOwner';
  if (query.includes('RETURN s.id AS id, s.filePath AS filePath')) return 'pdgSpans';
  if (query.includes('RETURN c.id AS id, r.reason AS reason')) return 'pdgSummary';
  if (query.includes('RETURN a.id AS id, r.reason AS reason')) return 'pdgSelf';
  if (query.includes('RETURN a.id AS id ORDER BY a.startLine')) return 'pdgSeed';
  if (query.includes('RETURN b.id AS id')) {
    if (query.includes('b.calleeIds AS calleeIds')) return 'pdgCalleeBlocks';
    if (query.includes('b.text AS text')) return 'pdgStatement';
    return 'pdgSeed';
  }
  if (query.includes('BasicBlock') && query.includes('RETURN DISTINCT')) return 'pdgNeighbor';
  if (query.includes('WITH DISTINCT caller') || query.includes('WITH DISTINCT target'))
    return 'chain';
  if (query.includes('caller.id AS uid'))
    return query.includes('(ctor:Constructor)') ? 'classIncoming' : 'incoming';
  if (query.includes('target.id AS uid')) return 'outgoing';
  if (query.includes('RETURN p.id AS uid')) return 'typedProperties';
  if (query.includes('RETURN p.id AS pid, p.heuristicLabel AS label')) return 'contextProcess';
  if (query.includes('RETURN route.name AS url')) return 'contextRoute';
  if (
    query.includes('RETURN c.id AS id') ||
    query.includes('RETURN f.id AS id') ||
    query.includes('RETURN p.id AS id')
  )
    return 'seeds';
  if (query.includes('RETURN DISTINCT member.id AS id')) return 'members';
  if (query.includes('AS sourceId')) return 'frontier';
  if (query.includes('RETURN p.id AS pId')) return 'process';
  if (query.includes('RETURN p.id AS pid, MIN(r.step) AS minStep')) return 'backfill';
  if (query.includes('RETURN s.id AS sid')) return 'membership';
  if (query.includes('c.heuristicLabel AS name')) return 'modules';
  if (query.includes('RETURN h.id AS hid')) return 'impactRoute';
  if (query.includes('n.visibility AS visibility')) return 'metadata';
  return undefined;
}

async function context(extra = {}) {
  return backend.callTool('context', { name: TARGET.name, ...extra });
}
async function impact(extra = {}) {
  return backend.callTool('impact', {
    target: TARGET.name,
    direction: 'upstream',
    maxDepth: 1,
    ...extra,
  });
}
function expectIntegrityError(result: any, isImpact = false) {
  expect(result.error).toMatch(/invalid symbol identity/i);
  expect(result.recoverySuggestion).toMatch(/analyze.*--force/);
  expect(JSON.stringify(result)).not.toContain('persisted-value');
  expect(result).not.toHaveProperty('symbol');
  expect(result).not.toHaveProperty('incoming');
  if (isImpact) {
    expect(result.risk).toBe('UNKNOWN');
    expect(result.impactedCount).toBeNull();
    expect(result.epistemic).not.toBe('exact');
  }
}
function tuple(value: Record<string, unknown>, keys: string[]): unknown[] {
  return keys.map((key) => value[key]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  aop.mockResolvedValue(undefined);
  failedSeam = undefined;
  rows = { target: [{ ...TARGET }], frontier: [{ ...EDGE }] };
  db.executeParameterized.mockImplementation(async (_db, query, params) => {
    const seam = querySeam(query, params);
    return seam ? fixture(seam) : [];
  });
  backend = new LocalBackend();
  await backend.init();
  vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
  vi.spyOn(backend as any, 'computeEpistemicBoundary').mockResolvedValue({ epistemic: 'exact' });
});

describe('identity corruption before target selection', () => {
  for (const corrupt of [true, false]) {
    it('distinguishes corrupt and ordinary ambiguous candidate failures: ' + corrupt, async () => {
      rows.target = [
        { ...TARGET, id: 'func:one', filePath: 'src/one.ts' },
        { ...TARGET, id: 'func:two', filePath: 'src/two.ts' },
      ];
      vi.spyOn(backend as any, '_runImpactBFS').mockRejectedValue(
        corrupt ? new SymbolIdentityError() : new Error('ordinary candidate failure'),
      );
      const result = await impact();
      if (corrupt) {
        expectIntegrityError(result, true);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe('ambiguous');
        expect(result.partialProbe).toBe(true);
      }
    });
  }
  for (const tool of ['context', 'impact']) {
    for (const badRow of [
      { id: BAD, label: 'Class' },
      { id: '', label: 'Class' },
      { id: 42, label: 'Class' },
      { id: TARGET.id, label: BAD },
    ]) {
      it('rejects corrupt label enrichment for ' + tool + JSON.stringify(badRow), async () => {
        rows.target = [{ ...TARGET, type: '' }];
        rows.targetLabels = [badRow, { id: TARGET.id, label: 'Class' }];
        expectIntegrityError(
          tool === 'context' ? await context() : await impact(),
          tool === 'impact',
        );
      });
    }
  }
  for (const shape of ['object', 'tuple']) {
    for (const field of ['name', 'filePath']) {
      for (const tool of ['context', 'impact', 'pdg impact']) {
        it('rejects NUL in target ' + field + ' from ' + shape + ' rows for ' + tool, async () => {
          const target = { ...TARGET, [field]: BAD };
          rows.target = [
            shape === 'tuple'
              ? tuple(target, ['id', 'name', 'type', 'filePath', 'startLine', 'endLine'])
              : target,
          ];
          expectIntegrityError(
            tool === 'context'
              ? await context()
              : await impact(tool === 'pdg impact' ? { mode: 'pdg' } : {}),
            tool !== 'context',
          );
        });
      }
    }
  }
  it('rejects corrupt exact-UID metadata before expansion', async () => {
    rows.target = [{ ...TARGET, filePath: BAD }];
    expectIntegrityError(await context({ uid: TARGET.id }));
    expectIntegrityError(await impact({ target_uid: TARGET.id }), true);
  });
  for (const field of ['name', 'filePath']) {
    it('rejects non-string target ' + field, async () => {
      rows.target = [{ ...TARGET, [field]: 42 }];
      expectIntegrityError(await context());
    });
  }
  it('validates every candidate before exact File narrowing', async () => {
    rows.target = [
      { ...TARGET, id: 'File:src/target.ts', name: 'target.ts', type: 'File' },
      { ...TARGET, id: 'func:other', filePath: BAD },
    ];
    expectIntegrityError(await context({ name: TARGET.filePath }));
  });
});

describe('context detail row integrity', () => {
  for (const seam of ['incoming', 'outgoing'] as const) {
    for (const shape of ['object', 'tuple']) {
      for (const field of ['uid', 'name', 'filePath']) {
        it('rejects NUL in ' + seam + ' ' + field + ' from ' + shape + ' rows', async () => {
          const ref = { ...REF, [field]: BAD };
          rows[seam] = [
            shape === 'tuple' ? tuple(ref, ['relType', 'uid', 'name', 'filePath', 'kind']) : ref,
          ];
          expectIntegrityError(await context());
        });
      }
      for (const badRow of [null, {}, [], { ...REF, uid: '' }, { ...REF, relType: '' }]) {
        it(
          'rejects incomplete ' +
            seam +
            ' row ' +
            JSON.stringify(badRow) +
            ' in ' +
            shape +
            ' response',
          async () => {
            rows[seam] = [
              shape === 'tuple' && badRow !== null
                ? tuple(badRow, ['relType', 'uid', 'name', 'filePath', 'kind'])
                : badRow,
            ];
            expectIntegrityError(await context());
          },
        );
      }
    }
  }
  for (const badRow of [
    null,
    {},
    [''],
    { pid: '' },
    { pid: 'proc:target', label: BAD },
    ['proc:target', BAD, 0, 0],
  ]) {
    it('rejects corrupt context process ' + JSON.stringify(badRow), async () => {
      rows.contextProcess = [badRow];
      expectIntegrityError(await context());
    });
  }
  it('does not swallow corrupt class expansion or typed property rows', async () => {
    rows.target = [{ ...TARGET, type: 'Class' }];
    rows.typedProperties = [{ uid: 'prop:target', name: 'prop', filePath: BAD, kind: 'Property' }];
    expectIntegrityError(await context());
  });
  it('rejects corrupt class refs before deduplication can discard them', async () => {
    rows.target = [{ ...TARGET, type: 'Class' }];
    rows.incoming = [REF];
    rows.classIncoming = [{ ...REF, filePath: BAD }];
    expectIntegrityError(await context());
  });
  for (const badRow of [{}, { ...REF, filePath: BAD }, { ...REF, uid: '' }]) {
    it('does not swallow corrupt chain rows ' + JSON.stringify(badRow), async () => {
      rows.chain = [badRow];
      expectIntegrityError(await context({ chain_depth: 1 }));
    });
  }
  it('rejects NUL in route names', async () => {
    rows.contextRoute = [{ url: BAD, method: 'GET' }];
    expectIntegrityError(await context());
  });
  it('rejects nested AOP identity fields while keeping the shared error envelope', async () => {
    aop.mockResolvedValue({
      framework: 'spring',
      advices: [{ adviceId: 'advice:1', adviceName: BAD }],
    });
    expectIntegrityError(await context());
  });
});

describe('impact detail row integrity', () => {
  for (const seam of ['frontier', 'process'] as const) {
    it(
      'PDG detail integrity rejects corrupt ' + seam + ' rows through the outer envelope',
      async () => {
        rows[seam] = [
          seam === 'frontier' ? { ...EDGE, filePath: BAD } : { ...PROCESS, epName: BAD },
        ];
        expectIntegrityError(await impact({ mode: 'pdg' }), true);
      },
    );
  }
  for (const shape of ['object', 'tuple']) {
    for (const field of ['id', 'name', 'filePath', 'sourceId']) {
      it('rejects NUL in frontier ' + field + ' from ' + shape + ' rows', async () => {
        const edge = { ...EDGE, [field]: BAD };
        rows.frontier = [
          shape === 'tuple'
            ? tuple(edge, [
                'sourceId',
                'id',
                'name',
                'type',
                'filePath',
                'relType',
                'confidence',
                'staticGated',
              ])
            : edge,
        ];
        expectIntegrityError(await impact(), true);
      });
    }
  }
  for (const badRow of [null, {}, [], { ...EDGE, id: '' }]) {
    it('rejects incomplete frontier rows ' + JSON.stringify(badRow), async () => {
      rows.frontier = [badRow];
      expectIntegrityError(await impact(), true);
    });
  }
  it('validates corrupt rows before test filtering', async () => {
    rows.frontier = [{ ...EDGE, filePath: 'test/corrupt\0.test.ts' }];
    expectIntegrityError(await impact({ includeTests: false }), true);
  });
  for (const shape of ['object', 'tuple']) {
    for (const field of ['pId', 'name', 'entryPointId', 'epName', 'epFilePath']) {
      it('rejects NUL in process ' + field + ' from ' + shape + ' rows', async () => {
        const process = { ...PROCESS, [field]: BAD };
        rows.process = [
          shape === 'tuple'
            ? tuple(process, [
                'pId',
                'name',
                'processType',
                'entryPointId',
                'hits',
                'minStep',
                'stepCount',
                'epName',
                'epType',
                'epFilePath',
              ])
            : process,
        ];
        expectIntegrityError(await impact({ summaryOnly: true }), true);
      });
    }
  }
  for (const badRow of [null, {}, [], { ...PROCESS, pId: '' }]) {
    it('does not aggregate incomplete processes ' + JSON.stringify(badRow), async () => {
      rows.process = [badRow];
      expectIntegrityError(await impact(), true);
    });
  }
  for (const badRow of [{}, { pid: BAD, minStep: 1 }]) {
    it(
      'does not swallow corrupt backfill process identities ' + JSON.stringify(badRow),
      async () => {
        rows.process = [{ ...PROCESS, minStep: null }];
        rows.backfill = [badRow];
        expectIntegrityError(await impact(), true);
      },
    );
  }
  for (const badRow of [
    {},
    { sid: REF.uid, pid: '' },
    { sid: REF.uid, pid: 'proc:caller', pName: BAD },
  ]) {
    it(
      'does not swallow corrupt per-symbol process identities ' + JSON.stringify(badRow),
      async () => {
        rows.process = [PROCESS];
        rows.membership = [badRow];
        expectIntegrityError(await impact(), true);
      },
    );
  }
  for (const type of ['Class', 'Const']) {
    for (const badRow of [{}, { ...TARGET, id: 'seed:1', filePath: BAD }]) {
      it('rejects corrupt ' + type + ' seeds ' + JSON.stringify(badRow), async () => {
        rows.target = [{ ...TARGET, type }];
        rows[type === 'Class' ? 'seeds' : 'members'] = [badRow];
        expectIntegrityError(await impact({ direction: 'downstream' }), true);
      });
    }
  }
  it('rejects NUL in module names before aggregation', async () => {
    rows.modules = [{ name: BAD, hits: 1 }];
    expectIntegrityError(await impact(), true);
  });
  it('rejects NUL in route names', async () => {
    rows.impactRoute = [{ hid: REF.uid, url: BAD }];
    expectIntegrityError(await impact(), true);
  });
  it('rejects nested AOP paths', async () => {
    aop.mockResolvedValue({
      framework: 'spring',
      advices: [{ adviceId: 'advice:1', adviceFilePath: BAD }],
    });
    expectIntegrityError(await impact(), true);
  });
});

describe('healthy and ordinary-failure compatibility', () => {
  it('preserves Unicode, opaque IDs, optional NULL metadata and source NUL', async () => {
    const content = 'const value = "actual\0source";';
    rows.target = [{ ...TARGET, name: 'café�', filePath: '源/café�.ts', content }];
    rows.incoming = [{ ...REF, name: '呼び出し�', filePath: null, kind: '' }];
    rows.contextProcess = [
      { pid: 'legacy:proc ', label: '', step: 0, stepCount: 0, entryPointId: null },
    ];
    rows.metadata = [{ annotations: ['@Text("source\0value")'], parameterTypes: null }];
    const result = await context({ include_content: true });
    expect(result.error).toBeUndefined();
    expect(result.symbol).toMatchObject({
      uid: TARGET.id,
      name: 'café�',
      filePath: '源/café�.ts',
      content,
    });
    expect(result.symbol.methodMetadata).toEqual({ annotations: ['@Text("source\0value")'] });
    expect(result.incoming.calls[0]).toMatchObject({ uid: REF.uid, name: '呼び出し�' });
    expect(result.processes).toEqual([
      { id: 'legacy:proc ', name: undefined, step_index: 0, step_count: 0 },
    ]);
  });
  it('preserves tuple zero steps and empty process labels', async () => {
    rows.contextProcess = [['proc:0', '', 0, 0, null]];
    expect((await context()).processes).toEqual([
      { id: 'proc:0', name: '', step_index: 0, step_count: 0 },
    ]);
  });
  it('allows absent OPTIONAL MATCH entry-point fields and missing legacy sourceId', async () => {
    rows.frontier = [{ ...EDGE, sourceId: undefined }];
    rows.process = [
      { ...PROCESS, name: '', entryPointId: null, epName: null, epType: null, epFilePath: null },
    ];
    const result = await impact();
    expect(result.error).toBeUndefined();
    expect(result.impactedCount).toBe(1);
    expect(result.affected_processes).toEqual([
      {
        name: 'unknown',
        type: 'Function',
        filePath: '',
        affected_process_count: 1,
        total_hits: 1,
        earliest_broken_step: 0,
      },
    ]);
  });
  it('keeps missing optional route fields as ordinary skipped enrichment', async () => {
    rows.contextRoute = [{}];
    rows.impactRoute = [{}];
    expect((await context()).error).toBeUndefined();
    expect((await impact()).error).toBeUndefined();
  });
  it('does not misdiagnose an unmatched user-supplied NUL as index corruption', async () => {
    rows.target = [];
    const contextResult = await context({ name: 'client\0input' });
    const impactResult = await impact({ target: 'client\0input' });
    expect(contextResult.error).toContain('not found');
    expect(impactResult.error).toContain('not found');
    expect(contextResult.recoverySuggestion).toBeUndefined();
    expect(impactResult.recoverySuggestion).toBeUndefined();
  });
  it('keeps ordinary process query failures degraded rather than integrity errors', async () => {
    failedSeam = 'process';
    const result = await impact();
    expect(result.error).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(result.impactedCount).toBe(1);
    expect(result.affected_processes).toEqual([]);
  });
  it('keeps ordinary PDG interprocedural failures as degraded results', async () => {
    vi.spyOn(backend as any, '_runImpactBFS').mockRejectedValue(
      new Error('ordinary bridge failure'),
    );
    const result = await impact({ mode: 'pdg' });
    expect(result.error).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(result.interproceduralError).toBe('ordinary bridge failure');
    expect(result.recoverySuggestion).toBeUndefined();
  });
  it('keeps ordinary context process query failures as unavailable enrichment', async () => {
    failedSeam = 'contextProcess';
    const result = await context();
    expect(result.error).toBeUndefined();
    expect(result.processes).toEqual([]);
  });
});

describe('raw PDG identities before coercion, caps, and projection', () => {
  const seed = 'BasicBlock:src/target.ts:2:0:0';
  const reached = 'BasicBlock:src/caller.ts:1:0:0';

  function preparePdg() {
    rows.pdgSeed = [{ id: seed }];
    rows.pdgNeighbor = [{ id: reached }];
    rows.pdgOwner = [{ id: REF.uid, name: REF.name, label: 'Function', startLine: 0 }];
    rows.pdgStatement = [{ id: reached, line: 1, endLine: 1, text: 'value = 1;' }];
  }

  for (const seam of ['pdgSeed', 'pdgNeighbor', 'pdgOwner', 'pdgStatement'] as const) {
    for (const bad of [BAD, '', null, 42]) {
      it('rejects raw ' + seam + ' identity ' + JSON.stringify(bad), async () => {
        preparePdg();
        rows[seam] = [{ id: bad, name: 'caller', label: 'Function', line: 1, startLine: 0 }];
        expectIntegrityError(
          await impact({ mode: 'pdg', ...(seam === 'pdgStatement' ? { line: 2 } : {}) }),
          true,
        );
      });
    }
  }
  for (const seam of ['pdgSeed', 'pdgNeighbor'] as const) {
    it('validates ' + seam + ' cap probe rows', async () => {
      preparePdg();
      rows[seam] = [{ id: seam === 'pdgSeed' ? seed : reached }, { id: BAD }];
      expectIntegrityError(await impact({ mode: 'pdg', limit: 1 }), true);
    });
  }
  for (const field of ['name', 'label']) {
    it('rejects raw owner ' + field + ' before String coercion', async () => {
      preparePdg();
      rows.pdgOwner = [{ id: REF.uid, name: 'caller', label: 'Function', [field]: BAD }];
      expectIntegrityError(await impact({ mode: 'pdg' }), true);
    });
  }
  for (const field of ['seedBlocks', 'reachableBlocks', 'intraReachableBlocks']) {
    for (const bad of [BAD, '', null, 42]) {
      it('rejects malformed final ' + field + ' members ' + JSON.stringify(bad), async () => {
        const healthy = await impact({ mode: 'pdg' });
        vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValue({
          ...healthy,
          [field]: [bad],
        });
        expectIntegrityError(await impact({ mode: 'pdg' }), true);
      });
    }
  }
  it('allows a generated unresolved owner marker', async () => {
    preparePdg();
    rows.pdgOwner = [];
    const result = await impact({ mode: 'pdg' });
    expect(result.error).toBeUndefined();
    expect(result.unresolvedBlockCount).toBe(1);
  });
  it('preserves Unicode owner tuples and source NUL', async () => {
    preparePdg();
    rows.pdgOwner = [[REF.uid, '呼び出し�', 'Function', 0]];
    expect((await impact({ mode: 'pdg' })).error).toBeUndefined();
    rows.pdgStatement = [{ id: reached, line: 1, endLine: 1, text: 'value = "source\0text";' }];
    const result = await impact({ mode: 'pdg', line: 2 });
    expect(result.error).toBeUndefined();
    expect(result.affectedStatements.some((s: any) => s.text.includes('\0'))).toBe(true);
  });
  for (const field of ['callees', 'calleeIds']) {
    it('does not swallow a corrupt statement bridge ' + field, async () => {
      preparePdg();
      const original = db.executeParameterized.getMockImplementation()!;
      db.executeParameterized.mockImplementation(async (...args) => {
        if (args[1].includes('RETURN b.' + field + ' AS ' + field)) {
          return [{ [field]: BAD }];
        }
        return original(...args);
      });
      expectIntegrityError(await impact({ mode: 'pdg', direction: 'downstream' }), true);
    });
  }
});

describe('real AOP helper identities before deduplication', () => {
  const reason =
    'spring-aop:v1:' +
    JSON.stringify({
      kind: 'advice',
      annotation: 'org.aspectj.lang.annotation.Around',
      advice: 'around',
      pointcut: 'execution(*)',
      match: 'static',
      activation: 'unknown',
      proxy: 'possible',
    });
  const advice = {
    sourceId: TARGET.id,
    sourceName: 'target',
    sourceFilePath: TARGET.filePath,
    targetId: 'advice:1',
    targetName: 'audit',
    targetFilePath: 'src/audit.ts',
    reason,
  };
  async function useRealAop() {
    const actual = await vi.importActual<typeof import('../../src/mcp/local/aop-metadata.js')>(
      '../../src/mcp/local/aop-metadata.js',
    );
    aop.mockImplementation(actual.querySpringAopMetadata);
    rows.target = [{ ...TARGET, type: 'Method' }];
  }
  for (const tool of ['context', 'impact']) {
    for (const field of ['sourceId', 'targetId']) {
      for (const bad of [BAD, '', null, 42]) {
        it('rejects raw AOP ' + field + ' for ' + tool + JSON.stringify(bad), async () => {
          await useRealAop();
          rows.aopRows = [{ ...advice, [field]: bad }, advice];
          expectIntegrityError(
            tool === 'context' ? await context() : await impact(),
            tool === 'impact',
          );
        });
      }
    }
    for (const field of ['sourceName', 'sourceFilePath', 'targetName', 'targetFilePath']) {
      it('rejects corrupt duplicate AOP ' + field + ' for ' + tool, async () => {
        await useRealAop();
        rows.aopRows = [{ ...advice, [field]: BAD }, advice];
        expectIntegrityError(
          tool === 'context' ? await context() : await impact(),
          tool === 'impact',
        );
      });
    }
  }
  it('validates the AOP cap-probe row', async () => {
    await useRealAop();
    rows.aopRows = [...Array.from({ length: 1000 }, () => advice), { ...advice, targetId: BAD }];
    expectIntegrityError(await context());
  });
  it('preserves Unicode and optional NULL metadata', async () => {
    await useRealAop();
    rows.aopRows = [
      { ...advice, sourceName: '源�', sourceFilePath: null, targetName: '', targetFilePath: null },
    ];
    const result = await context();
    expect(result.error).toBeUndefined();
    expect(result.symbol.aop.advices[0]).toMatchObject({
      adviceId: advice.targetId,
      advisedId: advice.sourceId,
      advisedName: '源�',
    });
  });
  it('keeps ordinary AOP query failures fail-soft', async () => {
    await useRealAop();
    failedSeam = 'aopRows';
    expect((await context()).error).toBeUndefined();
    expect((await impact()).error).toBeUndefined();
  });
  it('handles early AOP rejection while the frontier is pending', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    aop.mockRejectedValue(new SymbolIdentityError());
    const original = db.executeParameterized.getMockImplementation()!;
    db.executeParameterized.mockImplementation(async (...args) => {
      if (querySeam(args[1], args[2]) === 'frontier') {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return original(...args);
    });
    try {
      expectIntegrityError(await impact(), true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
