import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanupTempDir } from '../../helpers/test-db.js';
import { runGroupTrace } from '../../../src/core/group/cross-trace.js';
import { writeBridge } from '../../../src/core/group/bridge-db.js';
import type {
  GroupToolPort,
  GroupRepoHandle,
  GroupSymbolResolution,
  GroupPdgFlowResult,
} from '../../../src/core/group/service.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from './fixtures.js';

/**
 * U2 — cross-repo trace stitching. The bridge (crossing pair query) is a real
 * bridge.lbug; the per-repo trace + symbol resolution are driven by a typed
 * mock port with data-driven (if-free) dispatch.
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

function writeGroupYaml(groupDir: string): void {
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: g1
description: ""
repos:
  app/frontend: reg-fe
  app/backend: reg-be
links: []
packages: {}
detect:
  http: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
  );
}

/** Real bridge with one frontend(consumer) → backend(provider) ContractLink. */
async function writeLinkedBridge(groupDir: string): Promise<void> {
  const consumer = makeContract({
    repo: 'app/frontend',
    role: 'consumer',
    symbolUid: 'consumer-uid',
    symbolRef: { filePath: 'src/api.ts', name: 'callUsers' },
    symbolName: 'callUsers',
    contractId: 'http::GET::/api/users',
  });
  const provider = makeContract({
    repo: 'app/backend',
    role: 'provider',
    symbolUid: 'provider-uid',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    contractId: 'http::GET::/api/users',
  });
  const link: CrossLink = {
    from: { repo: 'app/frontend', symbolUid: 'consumer-uid', symbolRef: consumer.symbolRef },
    to: { repo: 'app/backend', symbolUid: 'provider-uid', symbolRef: provider.symbolRef },
    type: 'http',
    contractId: 'http::GET::/api/users',
    matchType: 'exact',
    confidence: 0.9,
  };
  await writeBridge(groupDir, {
    contracts: [consumer, provider],
    crossLinks: [link],
    repoSnapshots: {},
    missingRepos: [],
  });
}

/** Bridge with contracts but NO frontend→backend link. */
async function writeUnlinkedBridge(groupDir: string): Promise<void> {
  await writeBridge(groupDir, {
    contracts: [
      makeContract({ repo: 'app/frontend', role: 'consumer', symbolUid: 'c2' }),
      makeContract({ repo: 'app/backend', role: 'provider', symbolUid: 'p2' }),
    ],
    crossLinks: [],
    repoSnapshots: {},
    missingRepos: [],
  });
}

function okSym(
  id: string,
  name: string,
  filePath: string,
  startLine: number,
): GroupSymbolResolution {
  return {
    kind: 'ok',
    symbol: { id, name, type: 'Function', filePath, startLine, endLine: startLine + 3 },
  };
}

function okTrace(
  hops: Array<{ name: string; filePath: string; startLine: number }>,
  edges: Array<{ relType: string; confidence: number }>,
): unknown {
  return {
    status: 'ok',
    from: hops[0],
    to: hops[hops.length - 1],
    hopCount: edges.length,
    hops,
    edges,
  };
}

/** Build a mock port from a symbol table and a trace table (both if-free). */
function makePort(
  symbolTable: Record<string, GroupSymbolResolution>,
  traceTable: Record<string, unknown>,
  pdgTable?: Record<string, GroupPdgFlowResult>,
): GroupToolPort {
  const handles: Record<string, GroupRepoHandle> = {
    'reg-fe': { id: 'fe', name: 'reg-fe', repoPath: '/fe', storagePath: '/fe/.gitnexus' },
    'reg-be': { id: 'be', name: 'reg-be', repoPath: '/be', storagePath: '/be/.gitnexus' },
  };
  return {
    resolveRepo: async (p) => handles[String(p)] ?? handles['reg-fe']!,
    impact: async () => ({}),
    query: async () => ({}),
    impactByUid: async () => null,
    context: async () => ({}),
    resolveSymbol: async (repo, q) =>
      symbolTable[`${repo.name}:${q.name ?? q.uid ?? ''}`] ?? { kind: 'not_found' },
    trace: async (repo, params) =>
      traceTable[`${repo.name}:${params.from_uid}->${params.to_uid}`] ?? { status: 'no_path' },
    ...(pdgTable
      ? {
          pdgFlows: async (
            repo: GroupRepoHandle,
            anchor: { uid?: string },
          ): Promise<GroupPdgFlowResult> =>
            pdgTable[`${repo.name}:${anchor.uid}`] ?? { available: false, hops: [] },
        }
      : {}),
  };
}

/** The cross-repo stitch fixtures (checkout -> getUsers over one ContractLink). */
function crossSymbolTable(): Record<string, GroupSymbolResolution> {
  return {
    'reg-fe:checkout': okSym('checkout-uid', 'checkout', 'src/checkout.ts', 10),
    'reg-be:getUsers': okSym('getUsers-uid', 'getUsers', 'src/routes.ts', 5),
  };
}

function crossTraceTable(): Record<string, unknown> {
  return {
    'reg-fe:checkout-uid->consumer-uid': okTrace(
      [
        { name: 'checkout', filePath: 'src/checkout.ts', startLine: 10 },
        { name: 'callUsers', filePath: 'src/api.ts', startLine: 3 },
      ],
      [{ relType: 'CALLS', confidence: 1 }],
    ),
    'reg-be:provider-uid->getUsers-uid': okTrace(
      [{ name: 'getUsers', filePath: 'src/routes.ts', startLine: 5 }],
      [],
    ),
  };
}

describe('runGroupTrace', () => {
  let tmpDir: string;
  let groupDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cross-trace-'));
    groupDir = path.join(tmpDir, 'groups', 'g1');
    writeGroupYaml(groupDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('errors when from/to are missing', async () => {
    const port = makePort({}, {});
    const r = await runGroupTrace({ port, gitnexusDir: tmpDir }, { name: 'g1', from: 'A' });
    expect(r).toMatchObject({ status: 'error', error: expect.stringContaining('to') });
  });

  it('not_found when the from symbol resolves in no member', async () => {
    const port = makePort({ 'reg-be:Target': okSym('t', 'Target', 'src/x.ts', 1) }, {});
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'Ghost', to: 'Target' },
    );
    expect(r).toMatchObject({ status: 'not_found', role: 'from' });
  });

  it('ambiguous when a symbol resolves in multiple members', async () => {
    const port = makePort(
      {
        'reg-fe:shared': okSym('s-fe', 'shared', 'fe/a.ts', 1),
        'reg-be:shared': okSym('s-be', 'shared', 'be/a.ts', 1),
        'reg-be:Target': okSym('t', 'Target', 'be/x.ts', 1),
      },
      {},
    );
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'shared', to: 'Target' },
    );
    expect(r).toMatchObject({
      status: 'ambiguous',
      role: 'from',
      candidates: expect.arrayContaining([
        expect.objectContaining({ repo: 'app/frontend' }),
        expect.objectContaining({ repo: 'app/backend' }),
      ]),
    });
  });

  itLbugReopen('stitches a cross-repo path over one ContractLink', async () => {
    await writeLinkedBridge(groupDir);
    const port = makePort(
      {
        'reg-fe:checkout': okSym('checkout-uid', 'checkout', 'src/checkout.ts', 10),
        'reg-be:getUsers': okSym('getUsers-uid', 'getUsers', 'src/routes.ts', 5),
      },
      {
        'reg-fe:checkout-uid->consumer-uid': okTrace(
          [
            { name: 'checkout', filePath: 'src/checkout.ts', startLine: 10 },
            { name: 'callUsers', filePath: 'src/api.ts', startLine: 3 },
          ],
          [{ relType: 'CALLS', confidence: 1 }],
        ),
        'reg-be:provider-uid->getUsers-uid': okTrace(
          [{ name: 'getUsers', filePath: 'src/routes.ts', startLine: 5 }],
          [],
        ),
      },
    );
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers' },
    );
    expect(r).toMatchObject({
      status: 'ok',
      crossings: [
        {
          fromRepo: 'app/frontend',
          toRepo: 'app/backend',
          contractId: 'http::GET::/api/users',
          matchType: 'exact',
        },
      ],
      hopCount: 2,
      hops: [
        { name: 'checkout', repo: 'app/frontend' },
        { name: 'callUsers', repo: 'app/frontend' },
        { name: 'getUsers', repo: 'app/backend' },
      ],
      edges: [{ relType: 'CALLS' }, { relType: 'CONTRACT_LINK', confidence: 0.9 }],
    });
  });

  itLbugReopen('same-repo endpoints trace locally with no crossing', async () => {
    await writeLinkedBridge(groupDir);
    const port = makePort(
      {
        'reg-be:handlerA': okSym('a-uid', 'handlerA', 'src/a.ts', 1),
        'reg-be:handlerB': okSym('b-uid', 'handlerB', 'src/b.ts', 1),
      },
      {
        'reg-be:a-uid->b-uid': okTrace(
          [
            { name: 'handlerA', filePath: 'src/a.ts', startLine: 1 },
            { name: 'handlerB', filePath: 'src/b.ts', startLine: 1 },
          ],
          [{ relType: 'CALLS', confidence: 1 }],
        ),
      },
    );
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'handlerA', to: 'handlerB' },
    );
    expect(r).toMatchObject({
      status: 'ok',
      crossings: [],
      hopCount: 1,
      hops: [
        { name: 'handlerA', repo: 'app/backend' },
        { name: 'handlerB', repo: 'app/backend' },
      ],
    });
  });

  itLbugReopen('not_found with a bridge note when no ContractLink connects the repos', async () => {
    await writeUnlinkedBridge(groupDir);
    const port = makePort(
      {
        'reg-fe:checkout': okSym('checkout-uid', 'checkout', 'src/checkout.ts', 10),
        'reg-be:getUsers': okSym('getUsers-uid', 'getUsers', 'src/routes.ts', 5),
      },
      {},
    );
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers' },
    );
    expect(r).toMatchObject({
      status: 'not_found',
      notes: expect.arrayContaining([expect.stringContaining('ContractLink')]),
    });
  });

  itLbugReopen('clamps crossDepth>1 and surfaces a note', async () => {
    await writeLinkedBridge(groupDir);
    const port = makePort(
      {
        'reg-fe:checkout': okSym('checkout-uid', 'checkout', 'src/checkout.ts', 10),
        'reg-be:getUsers': okSym('getUsers-uid', 'getUsers', 'src/routes.ts', 5),
      },
      {
        'reg-fe:checkout-uid->consumer-uid': okTrace(
          [{ name: 'checkout', filePath: 'src/checkout.ts', startLine: 10 }],
          [],
        ),
        'reg-be:provider-uid->getUsers-uid': okTrace(
          [{ name: 'getUsers', filePath: 'src/routes.ts', startLine: 5 }],
          [],
        ),
      },
    );
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers', crossDepth: 4 },
    );
    expect(r).toMatchObject({
      status: 'ok',
      notes: expect.arrayContaining([expect.stringContaining('Multi-hop')]),
    });
  });

  // ── U4: opt-in PDG data-flow enrichment ──────────────────────────────────

  itLbugReopen('pdg:true attaches data-flow for the boundary-adjacent segment', async () => {
    await writeLinkedBridge(groupDir);
    const port = makePort(crossSymbolTable(), crossTraceTable(), {
      'reg-fe:consumer-uid': {
        available: true,
        variable: 'userId',
        hops: [
          { line: 11, text: 'const userId = req.params.id', variable: 'userId' },
          { line: 12, text: 'callUsers(userId)', variable: 'userId' },
        ],
      },
    });
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers', pdg: true },
    );
    expect(r).toMatchObject({
      status: 'ok',
      dataFlow: [
        {
          repo: 'app/frontend',
          variable: 'userId',
          hops: [{ line: 11, variable: 'userId' }, { line: 12 }],
        },
      ],
      notes: expect.arrayContaining([expect.stringContaining('experimental')]),
    });
  });

  itLbugReopen('pdg:true with no PDG layer degrades with a note and no dataFlow', async () => {
    await writeLinkedBridge(groupDir);
    const port = makePort(crossSymbolTable(), crossTraceTable(), {
      'reg-fe:consumer-uid': { available: false, hops: [] },
      'reg-be:provider-uid': { available: false, hops: [] },
    });
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers', pdg: true },
    );
    expect(r).toMatchObject({
      status: 'ok',
      notes: expect.arrayContaining([expect.stringContaining('No PDG layer')]),
    });
    expect((r as { dataFlow?: unknown }).dataFlow).toBeUndefined();
  });

  itLbugReopen('pdg omitted never requests enrichment', async () => {
    await writeLinkedBridge(groupDir);
    let pdgCalls = 0;
    const base = makePort(crossSymbolTable(), crossTraceTable());
    const port: typeof base = {
      ...base,
      pdgFlows: async () => {
        pdgCalls++;
        return { available: true, hops: [{ line: 1, text: 'x' }] };
      },
    };
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'getUsers' },
    );
    expect(r).toMatchObject({ status: 'ok' });
    expect((r as { dataFlow?: unknown }).dataFlow).toBeUndefined();
    expect(pdgCalls).toBe(0);
  });
});
