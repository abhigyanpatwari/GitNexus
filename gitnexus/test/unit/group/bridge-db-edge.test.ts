import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  writeBridge,
  openBridgeDbReadOnly,
  queryBridge,
  closeBridgeDb,
} from '../../../src/core/group/bridge-db.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from './fixtures.js';

describe('bridge-db edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-edge-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_openBridgeDbReadOnly_version_gate_returns_null_for_incompatible', async () => {
    // Create a dummy bridge.lbug file so the access check passes
    await fsp.writeFile(path.join(tmpDir, 'bridge.lbug'), 'dummy');
    // Write meta.json with an incompatible version (999)
    await fsp.writeFile(
      path.join(tmpDir, 'meta.json'),
      JSON.stringify({ version: 999, generatedAt: '', missingRepos: [] }),
    );

    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).toBeNull();
  });

  it('test_openBridgeDbReadOnly_bak_recovery_restores_bridge', async () => {
    // Write a valid bridge
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    // Move bridge.lbug → bridge.lbug.bak (simulating interrupted swap)
    const dbPath = path.join(tmpDir, 'bridge.lbug');
    const bakPath = path.join(tmpDir, 'bridge.lbug.bak');
    await fsp.rename(dbPath, bakPath);

    // openBridgeDbReadOnly should auto-recover from .bak
    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    const rows = await queryBridge<{ repo: string }>(
      handle!,
      'MATCH (c:Contract) RETURN c.repo AS repo',
    );
    expect(rows).toHaveLength(1);
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_crossLink_with_missing_to_node_silently_skipped', async () => {
    const provider = makeContract({ repo: 'backend', role: 'provider' });
    const consumer = makeContract({
      repo: 'frontend',
      role: 'consumer',
      symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      symbolName: 'fetchUsers',
    });
    // CrossLink referencing a 'to' endpoint that doesn't match any contract node
    const link: CrossLink = {
      from: {
        repo: 'frontend',
        symbolUid: '',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      },
      to: {
        repo: 'nonexistent-repo',
        symbolUid: 'uid-missing',
        symbolRef: { filePath: 'src/missing.ts', name: 'missingFn' },
      },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1.0,
    };

    // Should not throw — the link is silently skipped
    await writeBridge(tmpDir, {
      contracts: [provider, consumer],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });

    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    // No cross-links should exist since 'to' node was missing
    const rows = await queryBridge<{ matchType: string }>(
      handle!,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.matchType AS matchType',
    );
    expect(rows).toHaveLength(0);
    // But contracts should still be present
    const contractRows = await queryBridge<{ repo: string }>(
      handle!,
      'MATCH (c:Contract) RETURN c.repo AS repo',
    );
    expect(contractRows).toHaveLength(2);
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_manifest_grpc_link_with_symbol_uids_persists_queryable_contract_edge', async () => {
    const provider = makeContract({
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      role: 'provider',
      repo: 'platform/auth',
      symbolUid: 'uid-auth-login',
      symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      symbolName: 'auth.AuthService/Login',
    });
    const consumer = makeContract({
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      role: 'consumer',
      repo: 'platform/orders',
      symbolUid: 'uid-orders-client',
      symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      symbolName: 'auth.AuthService/Login',
    });
    const link: CrossLink = {
      from: {
        repo: 'platform/orders',
        symbolUid: 'uid-orders-client',
        symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      },
      to: {
        repo: 'platform/auth',
        symbolUid: 'uid-auth-login',
        symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      },
      type: 'grpc',
      contractId: 'grpc::auth.AuthService/Login',
      matchType: 'manifest',
      confidence: 1.0,
    };

    await writeBridge(tmpDir, {
      contracts: [provider, consumer],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });

    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    const rows = await queryBridge<{
      contractId: string;
      matchType: string;
      fromRepo: string;
      toRepo: string;
    }>(
      handle!,
      `MATCH (a:Contract)-[l:ContractLink]->(b:Contract)
       RETURN l.contractId AS contractId, l.matchType AS matchType, l.fromRepo AS fromRepo, l.toRepo AS toRepo`,
    );
    expect(rows).toEqual([
      {
        contractId: 'grpc::auth.AuthService/Login',
        matchType: 'manifest',
        fromRepo: 'platform/orders',
        toRepo: 'platform/auth',
      },
    ]);
    await closeBridgeDb(handle!);
  });
});
