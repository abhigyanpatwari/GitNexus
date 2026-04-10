import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  openBridgeDb,
  ensureBridgeSchema,
  queryBridge,
  closeBridgeDb,
  contractNodeId,
  writeBridge,
  openBridgeDbReadOnly,
  readBridgeMeta,
  bridgeExists,
} from '../../../src/core/group/bridge-db.js';
import type { StoredContract, CrossLink } from '../../../src/core/group/types.js';

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

  const makeContract = (overrides: Partial<StoredContract> = {}): StoredContract => ({
    contractId: 'http::GET::/api/users',
    type: 'http',
    role: 'provider',
    symbolUid: 'uid-1',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    confidence: 0.85,
    meta: {},
    repo: 'backend',
    ...overrides,
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
