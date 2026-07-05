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

  it('errors when from is missing', async () => {
    const port = makePort({}, {});
    const r = await runGroupTrace({ port, gitnexusDir: tmpDir }, { name: 'g1' });
    expect(r).toMatchObject({ status: 'error', error: expect.stringContaining('from') });
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

  it('flags not_found as possibly-incomplete when a member DB cannot be queried', async () => {
    // reg-be's resolveSymbol throws (corrupt/locked DB). A throw must NOT be
    // reported as a clean not_found ("symbol absent"); the result carries a
    // degraded-member note so the caller knows the answer may be incomplete.
    const responders: Record<string, () => Promise<GroupSymbolResolution>> = {
      'reg-be': () => Promise.reject(new Error('DB locked')),
      'reg-fe': () => Promise.resolve({ kind: 'not_found' }),
    };
    const base = makePort({}, {});
    const port: GroupToolPort = {
      ...base,
      resolveSymbol: async (repo) =>
        (responders[repo.name] ?? (() => Promise.resolve({ kind: 'not_found' })))(),
    };
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'Ghost', to: 'Target' },
    );
    expect(r).toMatchObject({
      status: 'not_found',
      role: 'from',
      notes: expect.arrayContaining([expect.stringContaining('could not be queried')]),
    });
    // The degraded member is named.
    expect((r as { notes: string[] }).notes.join(' ')).toContain('app/backend');
  });

  it('flags a SUCCESSFUL trace as possibly-incomplete when a member DB cannot be queried', async () => {
    // reg-be throws (locked DB) while reg-fe resolves both endpoints and the
    // same-repo trace succeeds. The `ok` result must STILL carry the degraded
    // note — group resolution is only unique among the members we could query,
    // so if the unreachable member also held `from`/`to` the answer is suspect.
    const feSyms: Record<string, GroupSymbolResolution> = {
      checkout: okSym('checkout-uid', 'checkout', 'src/a.ts', 1),
      callUsers: okSym('callUsers-uid', 'callUsers', 'src/a.ts', 5),
    };
    const responders: Record<string, (q: { name?: string }) => Promise<GroupSymbolResolution>> = {
      'reg-be': () => Promise.reject(new Error('DB locked')),
      'reg-fe': (q) => Promise.resolve(feSyms[q.name ?? ''] ?? { kind: 'not_found' }),
    };
    const base = makePort(
      {},
      {
        'reg-fe:checkout-uid->callUsers-uid': okTrace(
          [
            { name: 'checkout', filePath: 'src/a.ts', startLine: 1 },
            { name: 'callUsers', filePath: 'src/a.ts', startLine: 5 },
          ],
          [{ relType: 'CALLS', confidence: 1 }],
        ),
      },
    );
    const port: GroupToolPort = {
      ...base,
      resolveSymbol: async (repo, q) =>
        (responders[repo.name] ?? (() => Promise.resolve({ kind: 'not_found' })))(q),
    };
    const r = await runGroupTrace(
      { port, gitnexusDir: tmpDir },
      { name: 'g1', from: 'checkout', to: 'callUsers' },
    );
    expect(r).toMatchObject({
      status: 'ok',
      notes: expect.arrayContaining([expect.stringContaining('could not be queried')]),
    });
    expect((r as { notes: string[] }).notes.join(' ')).toContain('app/backend');
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

  itLbugReopen(
    'stitches an HTTP-style crossing with EMPTY symbolUid via the contract-file fallback',
    async () => {
      // HTTP contracts hardcode symbolUid:'' and only record the file. When the
      // user's from/to resolve into the contract files, the file-level fallback
      // anchors the boundary so the trace still stitches.
      const consumer = makeContract({
        repo: 'app/frontend',
        role: 'consumer',
        symbolUid: '', // <-- empty, like a real HTTP source-scan contract
        symbolRef: { filePath: 'src/api.ts', name: 'fetch' },
        symbolName: 'fetch',
        contractId: 'http::GET::/api/users',
      });
      const provider = makeContract({
        repo: 'app/backend',
        role: 'provider',
        symbolUid: '',
        symbolRef: { filePath: 'src/routes.ts', name: 'handler' },
        symbolName: 'handler',
        contractId: 'http::GET::/api/users',
      });
      const link: CrossLink = {
        from: { repo: 'app/frontend', symbolUid: '', symbolRef: consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: '', symbolRef: provider.symbolRef },
        type: 'http',
        contractId: 'http::GET::/api/users',
        matchType: 'exact',
        confidence: 1,
      };
      await writeBridge(groupDir, {
        contracts: [consumer, provider],
        crossLinks: [link],
        repoSnapshots: {},
        missingRepos: [],
      });

      const port = makePort(
        {
          // from/to resolve to symbols that LIVE IN the contract files.
          'reg-fe:callUsers': okSym('callUsers-uid', 'callUsers', 'src/api.ts', 3),
          'reg-be:getUsers': okSym('getUsers-uid', 'getUsers', 'src/routes.ts', 5),
        },
        {
          // Trivial same-symbol segments (from IS the consumer, to IS the provider).
          'reg-fe:callUsers-uid->callUsers-uid': okTrace(
            [{ name: 'callUsers', filePath: 'src/api.ts', startLine: 3 }],
            [],
          ),
          'reg-be:getUsers-uid->getUsers-uid': okTrace(
            [{ name: 'getUsers', filePath: 'src/routes.ts', startLine: 5 }],
            [],
          ),
        },
      );
      const r = await runGroupTrace(
        { port, gitnexusDir: tmpDir },
        { name: 'g1', from: 'callUsers', to: 'getUsers' },
      );
      expect(r).toMatchObject({
        status: 'ok',
        crossings: [{ contractId: 'http::GET::/api/users' }],
        hops: [
          { name: 'callUsers', repo: 'app/frontend' },
          { name: 'getUsers', repo: 'app/backend' },
        ],
        notes: expect.arrayContaining([expect.stringContaining('anchored by contract FILE')]),
      });
    },
  );

  itLbugReopen(
    'destination trace (no `to`) reports an ANONYMOUS handler endpoint by route + file',
    async () => {
      // The inherent case: the provider handler is an anonymous arrow with no
      // symbol (symbolUid:''). Omitting `to` follows the consumer's HTTP call to
      // the endpoint, reported by route + file even though it has no name.
      const consumer = makeContract({
        repo: 'app/frontend',
        role: 'consumer',
        symbolUid: 'callUsers-uid',
        symbolRef: { filePath: 'src/api.ts', name: 'callUsers' },
        symbolName: 'callUsers',
        contractId: 'http::GET::/api/users',
      });
      const provider = makeContract({
        repo: 'app/backend',
        role: 'provider',
        symbolUid: '', // anonymous handler — no symbol in the graph
        symbolRef: { filePath: 'src/routes.ts', name: 'handler' },
        symbolName: 'handler',
        contractId: 'http::GET::/api/users',
      });
      const link: CrossLink = {
        from: { repo: 'app/frontend', symbolUid: 'callUsers-uid', symbolRef: consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: '', symbolRef: provider.symbolRef },
        type: 'http',
        contractId: 'http::GET::/api/users',
        matchType: 'exact',
        confidence: 1,
      };
      await writeBridge(groupDir, {
        contracts: [consumer, provider],
        crossLinks: [link],
        repoSnapshots: {},
        missingRepos: [],
      });

      const port = makePort(
        { 'reg-fe:callUsers': okSym('callUsers-uid', 'callUsers', 'src/api.ts', 3) },
        {
          'reg-fe:callUsers-uid->callUsers-uid': okTrace(
            [{ name: 'callUsers', filePath: 'src/api.ts', startLine: 3 }],
            [],
          ),
        },
      );
      // NO `to` — destination trace.
      const r = await runGroupTrace(
        { port, gitnexusDir: tmpDir },
        { name: 'g1', from: 'callUsers' },
      );
      expect(r).toMatchObject({
        status: 'ok',
        crossings: [{ contractId: 'http::GET::/api/users', toRepo: 'app/backend' }],
        to: {
          name: '<http::GET::/api/users handler>',
          repo: 'app/backend',
          filePath: 'src/routes.ts',
        },
        hops: [
          { name: 'callUsers', repo: 'app/frontend' },
          { name: '<http::GET::/api/users handler>', repo: 'app/backend' },
        ],
        edges: [{ relType: 'CONTRACT_LINK' }],
        notes: expect.arrayContaining([expect.stringContaining('anonymous')]),
      });
    },
  );

  itLbugReopen(
    'destination trace anonymizes an unresolved Laravel `route` placeholder (#2276)',
    async () => {
      // A named-controller / closure Laravel provider that did not resolve keeps
      // the synthetic `'route'` placeholder (never a real symbol name). It must
      // be treated as anonymous — shown as `<route handler>` — exactly like the
      // `'handler'`/`'fetch'` sentinels, not displayed as the literal `route`.
      const consumer = makeContract({
        repo: 'app/frontend',
        role: 'consumer',
        symbolUid: 'callUsers-uid',
        symbolRef: { filePath: 'src/api.ts', name: 'callUsers' },
        symbolName: 'callUsers',
        contractId: 'http::GET::/api/users',
      });
      const provider = makeContract({
        repo: 'app/backend',
        role: 'provider',
        symbolUid: '', // unresolved file-scope closure / named-controller route
        symbolRef: { filePath: 'routes/web.php', name: 'route' },
        symbolName: 'route',
        contractId: 'http::GET::/api/users',
      });
      const link: CrossLink = {
        from: { repo: 'app/frontend', symbolUid: 'callUsers-uid', symbolRef: consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: '', symbolRef: provider.symbolRef },
        type: 'http',
        contractId: 'http::GET::/api/users',
        matchType: 'exact',
        confidence: 1,
      };
      await writeBridge(groupDir, {
        contracts: [consumer, provider],
        crossLinks: [link],
        repoSnapshots: {},
        missingRepos: [],
      });

      const port = makePort(
        { 'reg-fe:callUsers': okSym('callUsers-uid', 'callUsers', 'src/api.ts', 3) },
        {
          'reg-fe:callUsers-uid->callUsers-uid': okTrace(
            [{ name: 'callUsers', filePath: 'src/api.ts', startLine: 3 }],
            [],
          ),
        },
      );
      const r = await runGroupTrace(
        { port, gitnexusDir: tmpDir },
        { name: 'g1', from: 'callUsers' },
      );
      expect(r).toMatchObject({
        status: 'ok',
        to: {
          name: '<http::GET::/api/users handler>',
          repo: 'app/backend',
          filePath: 'routes/web.php',
        },
        hops: [
          { name: 'callUsers', repo: 'app/frontend' },
          { name: '<http::GET::/api/users handler>', repo: 'app/backend' },
        ],
        notes: expect.arrayContaining([expect.stringContaining('anonymous')]),
      });
    },
  );

  itLbugReopen('destination trace not_found when no HTTP link leaves the repo', async () => {
    await writeUnlinkedBridge(groupDir);
    const port = makePort(
      { 'reg-fe:checkout': okSym('checkout-uid', 'checkout', 'src/checkout.ts', 10) },
      {},
    );
    const r = await runGroupTrace({ port, gitnexusDir: tmpDir }, { name: 'g1', from: 'checkout' });
    expect(r).toMatchObject({
      status: 'not_found',
      role: 'to',
      notes: expect.arrayContaining([expect.stringContaining('No outgoing HTTP ContractLink')]),
    });
  });

  itLbugReopen(
    'destination trace is AMBIGUOUS when a file makes multiple HTTP calls with empty uids',
    async () => {
      // Two HTTP consumer contracts in the SAME file, both with empty symbolUid
      // (the file-fallback case). `from` lives in that file, so `trace(from->from)`
      // trivially succeeds for BOTH — the destination must be reported ambiguous,
      // not silently resolved to the highest-confidence sibling.
      // Distinct consumer NAMES so the bridge links resolve uniquely, but the
      // SAME file (src/api.ts) and empty uid so both hit the file-fallback.
      const mk = (cid: string, consName: string, provFile: string) => ({
        consumer: makeContract({
          repo: 'app/frontend',
          role: 'consumer',
          symbolUid: '',
          symbolRef: { filePath: 'src/api.ts', name: consName },
          symbolName: consName,
          contractId: cid,
        }),
        provider: makeContract({
          repo: 'app/backend',
          role: 'provider',
          symbolUid: '',
          symbolRef: { filePath: provFile, name: 'handler' },
          symbolName: 'handler',
          contractId: cid,
        }),
      });
      const users = mk('http::GET::/api/users', 'fetchUsers', 'src/users.ts');
      const orders = mk('http::GET::/api/orders', 'fetchOrders', 'src/orders.ts');
      const link = (c: typeof users): CrossLink => ({
        from: { repo: 'app/frontend', symbolUid: '', symbolRef: c.consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: '', symbolRef: c.provider.symbolRef },
        type: 'http',
        contractId: c.consumer.contractId,
        matchType: 'exact',
        confidence: 1,
      });
      await writeBridge(groupDir, {
        contracts: [users.consumer, users.provider, orders.consumer, orders.provider],
        crossLinks: [link(users), link(orders)],
        repoSnapshots: {},
        missingRepos: [],
      });

      const port = makePort(
        { 'reg-fe:caller': okSym('caller-uid', 'caller', 'src/api.ts', 3) },
        {
          'reg-fe:caller-uid->caller-uid': okTrace(
            [{ name: 'caller', filePath: 'src/api.ts', startLine: 3 }],
            [],
          ),
        },
      );
      const r = await runGroupTrace({ port, gitnexusDir: tmpDir }, { name: 'g1', from: 'caller' });
      expect(r).toMatchObject({
        status: 'ambiguous',
        role: 'to',
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'http::GET::/api/users' }),
          expect.objectContaining({ id: 'http::GET::/api/orders' }),
        ]),
        notes: expect.arrayContaining([expect.stringContaining('more than one HTTP call')]),
      });
    },
  );

  itLbugReopen('destination trace success still flags a degraded member', async () => {
    // reg-fe resolves `from` and the destination follows an HTTP link to an
    // anonymous backend handler; reg-be throws during resolveSymbol. The ok
    // result must still carry the degraded note, keeping the no-`to` path aligned
    // with explicit `to` traces (authoritative only among queryable members).
    const consumer = makeContract({
      repo: 'app/frontend',
      role: 'consumer',
      symbolUid: 'callUsers-uid',
      symbolRef: { filePath: 'src/api.ts', name: 'callUsers' },
      symbolName: 'callUsers',
      contractId: 'http::GET::/api/users',
    });
    const provider = makeContract({
      repo: 'app/backend',
      role: 'provider',
      symbolUid: '',
      symbolRef: { filePath: 'src/routes.ts', name: 'handler' },
      symbolName: 'handler',
      contractId: 'http::GET::/api/users',
    });
    const link: CrossLink = {
      from: { repo: 'app/frontend', symbolUid: 'callUsers-uid', symbolRef: consumer.symbolRef },
      to: { repo: 'app/backend', symbolUid: '', symbolRef: provider.symbolRef },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1,
    };
    await writeBridge(groupDir, {
      contracts: [consumer, provider],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });

    const feSyms: Record<string, GroupSymbolResolution> = {
      callUsers: okSym('callUsers-uid', 'callUsers', 'src/api.ts', 3),
    };
    const responders: Record<string, (q: { name?: string }) => Promise<GroupSymbolResolution>> = {
      'reg-be': () => Promise.reject(new Error('DB locked')),
      'reg-fe': (q) => Promise.resolve(feSyms[q.name ?? ''] ?? { kind: 'not_found' }),
    };
    const base = makePort(
      {},
      {
        'reg-fe:callUsers-uid->callUsers-uid': okTrace(
          [{ name: 'callUsers', filePath: 'src/api.ts', startLine: 3 }],
          [],
        ),
      },
    );
    const port: GroupToolPort = {
      ...base,
      resolveSymbol: async (repo, q) =>
        (responders[repo.name] ?? (() => Promise.resolve({ kind: 'not_found' })))(q),
    };
    const r = await runGroupTrace({ port, gitnexusDir: tmpDir }, { name: 'g1', from: 'callUsers' });
    expect(r).toMatchObject({
      status: 'ok',
      to: { name: '<http::GET::/api/users handler>' },
      notes: expect.arrayContaining([
        expect.stringContaining('anonymous'),
        expect.stringContaining('could not be queried'),
      ]),
    });
  });

  itLbugReopen(
    'destination trace is AMBIGUOUS when `from` reaches multiple PRECISE endpoints',
    async () => {
      // `dispatch` reaches two consumer functions, each with a resolved uid and
      // linked to a different provider route. This pins the PRECISE ambiguity tier
      // (distinct from the file-level case) so a future change cannot silently pick
      // the highest-confidence destination.
      const mk = (
        cid: string,
        consName: string,
        consUid: string,
        consFile: string,
        prov: string,
      ) => ({
        consumer: makeContract({
          repo: 'app/frontend',
          role: 'consumer',
          symbolUid: consUid,
          symbolRef: { filePath: consFile, name: consName },
          symbolName: consName,
          contractId: cid,
        }),
        provider: makeContract({
          repo: 'app/backend',
          role: 'provider',
          symbolUid: `uid-${prov}`,
          symbolRef: { filePath: 'src/routes.ts', name: prov },
          symbolName: prov,
          contractId: cid,
        }),
      });
      const a = mk('http::GET::/api/a', 'fetchA', 'fetchA-uid', 'src/a.ts', 'handlerA');
      const b = mk('http::GET::/api/b', 'fetchB', 'fetchB-uid', 'src/b.ts', 'handlerB');
      const link = (c: typeof a): CrossLink => ({
        from: {
          repo: 'app/frontend',
          symbolUid: c.consumer.symbolUid,
          symbolRef: c.consumer.symbolRef,
        },
        to: {
          repo: 'app/backend',
          symbolUid: c.provider.symbolUid,
          symbolRef: c.provider.symbolRef,
        },
        type: 'http',
        contractId: c.consumer.contractId,
        matchType: 'exact',
        confidence: 1,
      });
      await writeBridge(groupDir, {
        contracts: [a.consumer, a.provider, b.consumer, b.provider],
        crossLinks: [link(a), link(b)],
        repoSnapshots: {},
        missingRepos: [],
      });

      const port = makePort(
        { 'reg-fe:dispatch': okSym('dispatch-uid', 'dispatch', 'src/main.ts', 1) },
        {
          'reg-fe:dispatch-uid->fetchA-uid': okTrace(
            [
              { name: 'dispatch', filePath: 'src/main.ts', startLine: 1 },
              { name: 'fetchA', filePath: 'src/a.ts', startLine: 1 },
            ],
            [{ relType: 'CALLS', confidence: 1 }],
          ),
          'reg-fe:dispatch-uid->fetchB-uid': okTrace(
            [
              { name: 'dispatch', filePath: 'src/main.ts', startLine: 1 },
              { name: 'fetchB', filePath: 'src/b.ts', startLine: 1 },
            ],
            [{ relType: 'CALLS', confidence: 1 }],
          ),
        },
      );
      const r = await runGroupTrace(
        { port, gitnexusDir: tmpDir },
        { name: 'g1', from: 'dispatch' },
      );
      expect(r).toMatchObject({
        status: 'ambiguous',
        role: 'to',
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'http::GET::/api/a' }),
          expect.objectContaining({ id: 'http::GET::/api/b' }),
        ]),
        notes: expect.arrayContaining([expect.stringContaining('more than one HTTP endpoint')]),
      });
    },
  );

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

  itLbugReopen(
    'memoizes the home-repo segment across crossings that share one consumer',
    async () => {
      // Two ContractLinks from the SAME consumer (c1) to two providers (p1, p2).
      // p1's provider→to segment fails; p2's succeeds. The from→consumer segment
      // (segA) depends only on the consumer uid, so it must be traced ONCE even
      // though two crossings are attempted — the O(2·N) → O(distinct endpoints) fix.
      const consumer = makeContract({
        repo: 'app/frontend',
        role: 'consumer',
        symbolUid: 'c1',
        symbolRef: { filePath: 'src/api.ts', name: 'callBoth' },
        symbolName: 'callBoth',
        contractId: 'http::GET::/api/a',
      });
      const provider1 = makeContract({
        repo: 'app/backend',
        role: 'provider',
        symbolUid: 'p1',
        symbolRef: { filePath: 'src/r1.ts', name: 'h1' },
        symbolName: 'h1',
        contractId: 'http::GET::/api/a',
      });
      const provider2 = makeContract({
        repo: 'app/backend',
        role: 'provider',
        symbolUid: 'p2',
        symbolRef: { filePath: 'src/r2.ts', name: 'h2' },
        symbolName: 'h2',
        contractId: 'http::GET::/api/b',
      });
      const link1: CrossLink = {
        from: { repo: 'app/frontend', symbolUid: 'c1', symbolRef: consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: 'p1', symbolRef: provider1.symbolRef },
        type: 'http',
        contractId: 'http::GET::/api/a',
        matchType: 'exact',
        confidence: 0.9,
      };
      const link2: CrossLink = {
        from: { repo: 'app/frontend', symbolUid: 'c1', symbolRef: consumer.symbolRef },
        to: { repo: 'app/backend', symbolUid: 'p2', symbolRef: provider2.symbolRef },
        type: 'http',
        contractId: 'http::GET::/api/b',
        matchType: 'exact',
        confidence: 0.8,
      };
      await writeBridge(groupDir, {
        contracts: [consumer, provider1, provider2],
        crossLinks: [link1, link2],
        repoSnapshots: {},
        missingRepos: [],
      });

      const handles: Record<string, GroupRepoHandle> = {
        'reg-fe': { id: 'fe', name: 'reg-fe', repoPath: '/fe', storagePath: '/fe/.gitnexus' },
        'reg-be': { id: 'be', name: 'reg-be', repoPath: '/be', storagePath: '/be/.gitnexus' },
      };
      const symbolTable: Record<string, GroupSymbolResolution> = {
        'reg-fe:start': okSym('start-uid', 'start', 'src/start.ts', 1),
        'reg-be:target': okSym('target-uid', 'target', 'src/target.ts', 1),
      };
      const traceTable: Record<string, unknown> = {
        'reg-fe:start-uid->c1': okTrace(
          [
            { name: 'start', filePath: 'src/start.ts', startLine: 1 },
            { name: 'callBoth', filePath: 'src/api.ts', startLine: 1 },
          ],
          [{ relType: 'CALLS', confidence: 1 }],
        ),
        'reg-be:p1->target-uid': { status: 'no_path' },
        'reg-be:p2->target-uid': okTrace(
          [{ name: 'target', filePath: 'src/target.ts', startLine: 1 }],
          [],
        ),
      };
      const traceCalls: string[] = [];
      const port: GroupToolPort = {
        resolveRepo: async (rp) => handles[String(rp)] ?? handles['reg-fe']!,
        impact: async () => ({}),
        query: async () => ({}),
        impactByUid: async () => null,
        context: async () => ({}),
        resolveSymbol: async (repo, q) =>
          symbolTable[`${repo.name}:${q.name ?? q.uid ?? ''}`] ?? { kind: 'not_found' },
        trace: async (repo, params) => {
          const key = `${repo.name}:${params.from_uid}->${params.to_uid}`;
          traceCalls.push(key);
          return traceTable[key] ?? { status: 'no_path' };
        },
      };

      const r = await runGroupTrace(
        { port, gitnexusDir: tmpDir },
        { name: 'g1', from: 'start', to: 'target' },
      );
      // p2's crossing wins (p1's provider segment had no path).
      expect(r).toMatchObject({
        status: 'ok',
        crossings: [{ contractId: 'http::GET::/api/b' }],
      });
      // segA (start → c1) was traced exactly once despite two crossings sharing c1.
      expect(traceCalls.filter((k) => k === 'reg-fe:start-uid->c1')).toHaveLength(1);
    },
  );

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
