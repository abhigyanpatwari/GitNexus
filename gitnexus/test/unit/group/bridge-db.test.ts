import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  openBridgeDb,
  ensureBridgeSchema,
  queryBridge,
  closeBridgeDb,
  contractNodeId,
  retryRename,
  writeBridge,
  openBridgeDbReadOnly,
  readBridgeMeta,
  bridgeExists,
  createContractLookupIndex,
  indexContract,
  findContractNode,
} from '../../../src/core/group/bridge-db.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from './fixtures.js';

describe('bridge-db core', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_openBridgeDb_returns_handle_and_closes', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    expect(handle).toBeDefined();
    expect(handle._db).toBeDefined();
    expect(handle._conn).toBeDefined();
    expect(handle.groupDir).toBe(tmpDir);
    // Close should not throw
    await closeBridgeDb(handle);
  });

  it('test_ensureBridgeSchema_creates_tables_idempotent', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    await ensureBridgeSchema(handle);
    // Run again — should not throw
    await ensureBridgeSchema(handle);
    const rows = await queryBridge<{ cnt: number }>(
      handle,
      'MATCH (c:Contract) RETURN count(c) AS cnt',
    );
    expect(rows[0].cnt).toBe(0);
    await closeBridgeDb(handle);
  });

  it('test_queryBridge_returns_inserted_data', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    await ensureBridgeSchema(handle);
    await queryBridge(
      handle,
      `CREATE (c:Contract {
      id: 'abc123', contractId: 'http::GET::/api', type: 'http', role: 'provider',
      repo: 'backend', confidence: 0.9
    })`,
    );
    const rows = await queryBridge<{ repo: string; confidence: number }>(
      handle,
      'MATCH (c:Contract) RETURN c.repo AS repo, c.confidence AS confidence',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('backend');
    expect(rows[0].confidence).toBe(0.9);
    await closeBridgeDb(handle);
  });

  it('test_queryBridge_parameterized', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    await ensureBridgeSchema(handle);
    await queryBridge(
      handle,
      `CREATE (c:Contract {
      id: 'p1', contractId: 'http::GET::/api', type: 'http', role: 'provider',
      repo: 'backend', confidence: 0.9
    })`,
    );
    const rows = await queryBridge<{ repo: string }>(
      handle,
      'MATCH (c:Contract) WHERE c.repo = $r RETURN c.repo AS repo',
      { r: 'backend' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('backend');
    await closeBridgeDb(handle);
  });

  it('test_contractNodeId_full_sha256', () => {
    const id = contractNodeId('backend', 'http::GET::/api', 'provider', 'src/routes.ts');
    expect(id).toHaveLength(64); // full SHA-256 hex
    // Same inputs → same hash
    const id2 = contractNodeId('backend', 'http::GET::/api', 'provider', 'src/routes.ts');
    expect(id).toBe(id2);
    // Different filePath → different hash
    const id3 = contractNodeId('backend', 'http::GET::/api', 'provider', 'src/other.ts');
    expect(id).not.toBe(id3);
  });
});

describe('writeBridge + read', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-write-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_writeBridge_creates_bridge_lbug_file', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: { backend: { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: ['missing-repo'],
    });
    const exists = await bridgeExists(tmpDir);
    expect(exists).toBe(true);
  });

  it('test_writeBridge_returns_report_with_insert_counts', async () => {
    const report = await writeBridge(tmpDir, {
      contracts: [makeContract(), makeContract({ repo: 'frontend', role: 'consumer' })],
      crossLinks: [],
      repoSnapshots: { backend: { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: [],
    });
    expect(report.contractsInserted).toBe(2);
    expect(report.contractsFailed).toBe(0);
    expect(report.snapshotsInserted).toBe(1);
    expect(report.snapshotsFailed).toBe(0);
    expect(report.linksInserted).toBe(0);
    expect(report.linksFailed).toBe(0);
    expect(report.linksDroppedMissingNode).toBe(0);
    expect(report.sampleErrors).toHaveLength(0);
  });

  it('test_writeBridge_counts_dropped_links_with_missing_nodes', async () => {
    // Provider + cross-link that references a non-existent consumer node →
    // findContractNode returns null for `from`, link gets dropped.
    const provider = makeContract({ role: 'provider' });
    const report = await writeBridge(tmpDir, {
      contracts: [provider],
      crossLinks: [
        {
          from: {
            repo: 'ghost',
            symbolUid: '',
            symbolRef: { filePath: 'nowhere.ts', name: 'ghostFn' },
          },
          to: {
            repo: provider.repo,
            symbolUid: provider.symbolUid,
            symbolRef: provider.symbolRef,
          },
          type: 'http',
          contractId: provider.contractId,
          matchType: 'exact',
          confidence: 1.0,
        },
      ],
      repoSnapshots: {},
      missingRepos: [],
    });
    expect(report.linksInserted).toBe(0);
    expect(report.linksDroppedMissingNode).toBe(1);
    expect(report.linksFailed).toBe(0);
    expect(report.contractsInserted).toBe(1);
  });

  it('test_writeBridge_contracts_queryable', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract(), makeContract({ repo: 'frontend', role: 'consumer' })],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    const rows = await queryBridge<{ repo: string }>(
      handle!,
      'MATCH (c:Contract) RETURN c.repo AS repo',
    );
    expect(rows).toHaveLength(2);
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_meta_json_persists_missingRepos', async () => {
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: ['repo-a', 'repo-b'],
    });
    const meta = await readBridgeMeta(tmpDir);
    expect(meta.missingRepos).toEqual(['repo-a', 'repo-b']);
    expect(meta.version).toBeGreaterThan(0);
    expect(meta.generatedAt).toBeTruthy();
  });

  it('test_writeBridge_repoSnapshots_queryable', async () => {
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: { 'hr/backend': { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ id: string; indexedAt: string }>(
      handle!,
      'MATCH (s:RepoSnapshot) RETURN s.id AS id, s.indexedAt AS indexedAt',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('hr/backend');
    expect(rows[0].indexedAt).toBe('2026-01-01');
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_crossLinks_queryable', async () => {
    const provider = makeContract({ repo: 'backend', role: 'provider' });
    const consumer = makeContract({
      repo: 'frontend',
      role: 'consumer',
      symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      symbolName: 'fetchUsers',
    });
    const link: CrossLink = {
      from: {
        repo: 'frontend',
        symbolUid: '',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      },
      to: {
        repo: 'backend',
        symbolUid: 'uid-1',
        symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
      },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1.0,
    };
    await writeBridge(tmpDir, {
      contracts: [provider, consumer],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ fromRepo: string; toRepo: string; matchType: string }>(
      handle!,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo, l.matchType AS matchType',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fromRepo).toBe('frontend');
    expect(rows[0].toRepo).toBe('backend');
    expect(rows[0].matchType).toBe('exact');
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_duplicate_contracts_and_links_are_deduped', async () => {
    const provider = makeContract({
      repo: 'backend',
      role: 'provider',
      symbolUid: '',
      symbolName: 'auth.AuthService/Login',
      symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      meta: { source: 'manifest' },
    });
    const concreteProvider = makeContract({
      ...provider,
      symbolUid: 'uid-auth-login',
      symbolName: 'Login',
      confidence: 0.85,
      meta: { source: 'analyze' },
    });
    const consumer = makeContract({
      repo: 'frontend',
      role: 'consumer',
      symbolUid: '',
      symbolName: 'auth.AuthService/Login',
      symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      meta: { source: 'manifest' },
    });
    const link: CrossLink = {
      from: {
        repo: 'frontend',
        symbolUid: '',
        symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      },
      to: {
        repo: 'backend',
        symbolUid: '',
        symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      },
      type: 'grpc',
      contractId: 'grpc::auth.AuthService/Login',
      matchType: 'manifest',
      confidence: 1,
    };

    await writeBridge(tmpDir, {
      contracts: [provider, concreteProvider, consumer],
      crossLinks: [link, { ...link }],
      repoSnapshots: {},
      missingRepos: [],
    });

    const handle = await openBridgeDbReadOnly(tmpDir);
    const contracts = await queryBridge<{ repo: string; symbolUid: string; symbolName: string }>(
      handle!,
      'MATCH (c:Contract) RETURN c.repo AS repo, c.symbolUid AS symbolUid, c.symbolName AS symbolName ORDER BY c.repo',
    );
    const links = await queryBridge<{ fromRepo: string; toRepo: string }>(
      handle!,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo',
    );

    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toEqual({
      repo: 'backend',
      symbolUid: 'uid-auth-login',
      symbolName: 'Login',
    });
    expect(links).toHaveLength(1);
    await closeBridgeDb(handle!);
  });

  it('test_openBridgeDbReadOnly_returns_null_for_missing', async () => {
    const handle = await openBridgeDbReadOnly(path.join(tmpDir, 'nonexistent'));
    expect(handle).toBeNull();
  });

  it('test_bridgeExists_false_for_missing', async () => {
    expect(await bridgeExists(path.join(tmpDir, 'nonexistent'))).toBe(false);
  });

  it('test_writeBridge_overwrites_previous', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    await writeBridge(tmpDir, {
      contracts: [makeContract({ repo: 'new-repo' })],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ repo: string }>(
      handle!,
      'MATCH (c:Contract) RETURN c.repo AS repo',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('new-repo');
    await closeBridgeDb(handle!);
  });

  it('test_readBridgeMeta_returns_defaults_for_missing', async () => {
    const meta = await readBridgeMeta(path.join(tmpDir, 'nonexistent'));
    expect(meta.version).toBe(0);
    expect(meta.generatedAt).toBe('');
    expect(meta.missingRepos).toEqual([]);
  });
});

describe('retryRename', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on EBUSY and eventually succeeds', async () => {
    // Spy on fs.promises.rename and make the first two attempts fail with
    // EBUSY, then succeed on the third. Verifies that Windows-style
    // transient rename failures don't immediately bubble up.
    const attempts: Array<[string, string]> = [];
    let calls = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dst) => {
      attempts.push([String(src), String(dst)]);
      calls++;
      if (calls < 3) {
        const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      // Third attempt: pretend the rename worked.
      return undefined;
    });

    await retryRename('/src/a', '/dst/b', 3);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(attempts.every(([s, d]) => s === '/src/a' && d === '/dst/b')).toBe(true);
  });

  it('rethrows non-retryable errors immediately', async () => {
    // A non-retryable code (e.g. ENOENT) should NOT be swallowed into a
    // retry loop — that would mask real bugs and waste time.
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      const err = new Error('no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await expect(retryRename('/src/a', '/dst/b', 5)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      const err = new Error('locked') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    await expect(retryRename('/src/a', '/dst/b', 3)).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(3);
  });

  it('retries on EACCES as well', async () => {
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return undefined;
    });

    await retryRename('/src/a', '/dst/b', 3);
    expect(calls).toBe(2);
  });
});

describe('findContractNode', () => {
  // Pure-function tests for the lookup index + three-tier resolver that
  // were previously an inner closure of `writeBridge` and therefore
  // untestable in isolation. Every test here builds its own index and
  // never touches the DB.

  it('returns null on empty index', () => {
    const index = createContractLookupIndex();
    expect(findContractNode(index, 'backend', 'provider', 'uid-1', 'src/a.ts', 'foo')).toBeNull();
  });

  it('tier 1: returns contract matched by symbolUid', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', repo: 'backend', role: 'provider' });
    indexContract(index, c, 'node-A');
    expect(findContractNode(index, 'backend', 'provider', 'uid-42', 'anywhere.ts', 'anyName')).toBe(
      'node-A',
    );
  });

  it('tier 1 is repo-scoped: same uid in a different repo does not match', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', repo: 'backend' });
    indexContract(index, c, 'node-A');
    expect(
      findContractNode(index, 'frontend', 'provider', 'uid-42', 'src/routes.ts', 'getUsers'),
    ).toBeNull();
  });

  it('tier 1 is role-scoped: provider uid match does not resolve consumer query', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', role: 'provider', repo: 'backend' });
    indexContract(index, c, 'node-A');
    expect(
      findContractNode(index, 'backend', 'consumer', 'uid-42', 'src/routes.ts', 'getUsers'),
    ).toBeNull();
  });

  it('tier 2: falls through to filePath + symbolName when symbolUid is empty', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/ctrl.ts', name: 'handler' },
      symbolName: 'handler',
    });
    indexContract(index, c, 'node-B');
    expect(findContractNode(index, 'backend', 'provider', '', 'src/ctrl.ts', 'handler')).toBe(
      'node-B',
    );
  });

  it('tier 2: falls through when the given symbolUid does not match anything', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: 'uid-real',
      symbolRef: { filePath: 'src/ctrl.ts', name: 'handler' },
    });
    indexContract(index, c, 'node-B');
    // Wrong uid; but filePath+name still resolves.
    expect(
      findContractNode(index, 'backend', 'provider', 'uid-wrong', 'src/ctrl.ts', 'handler'),
    ).toBe('node-B');
  });

  it('tier 3: resolves by filePath alone when exactly one contract lives there', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/solo.ts', name: 'actualName' },
    });
    indexContract(index, c, 'node-C');
    // filePath+name miss (name is wrong), but tier 3 picks the sole entry.
    expect(findContractNode(index, 'backend', 'provider', '', 'src/solo.ts', 'wrongName')).toBe(
      'node-C',
    );
  });

  it('tier 3: does NOT resolve when multiple contracts live in the same file', () => {
    const index = createContractLookupIndex();
    const a = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/multi.ts', name: 'handlerA' },
    });
    const b = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/multi.ts', name: 'handlerB' },
      contractId: 'http::GET::/api/b',
    });
    indexContract(index, a, 'node-MA');
    indexContract(index, b, 'node-MB');
    // Wrong symbolName → no tier 2 match. Two contracts in the same file
    // → tier 3 must refuse to guess.
    expect(
      findContractNode(index, 'backend', 'provider', '', 'src/multi.ts', 'unknown'),
    ).toBeNull();
  });

  it('prefers tier 1 over tier 2 when both could resolve', () => {
    const index = createContractLookupIndex();
    const tier1Contract = makeContract({
      symbolUid: 'uid-1',
      symbolRef: { filePath: 'src/a.ts', name: 'first' },
    });
    const tier2Contract = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/a.ts', name: 'first' },
      contractId: 'http::POST::/api/x',
    });
    indexContract(index, tier1Contract, 'tier1-id');
    indexContract(index, tier2Contract, 'tier2-id');
    expect(findContractNode(index, 'backend', 'provider', 'uid-1', 'src/a.ts', 'first')).toBe(
      'tier1-id',
    );
  });
});
