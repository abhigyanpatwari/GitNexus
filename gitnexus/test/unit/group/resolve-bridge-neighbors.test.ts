import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanupTempDir } from '../../helpers/test-db.js';
import { resolveBridgeNeighbors } from '../../../src/core/group/cross-impact.js';
import {
  writeBridge,
  openBridgeDbReadOnly,
  closeBridgeDb,
} from '../../../src/core/group/bridge-db.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from './fixtures.js';

/**
 * U1 — direct coverage for the shared bridge-neighbor join extracted from
 * `runGroupImpact`. Mirrors the close-then-reopen Windows guard used by the
 * other writeBridge tests (`itLbugReopen`).
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

/** Build a bridge with one consumer→provider ContractLink (both UIDs populated). */
async function writeLinkedBridge(groupDir: string): Promise<void> {
  const consumer = makeContract({
    repo: 'app/frontend',
    role: 'consumer',
    symbolUid: 'consumer-uid',
    symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
    symbolName: 'fetchUsers',
    contractId: 'http::GET::/api/users',
    confidence: 0.5,
  });
  const provider = makeContract({
    repo: 'app/backend',
    role: 'provider',
    symbolUid: 'provider-uid',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    contractId: 'http::GET::/api/users',
    confidence: 0.9,
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

describe('resolveBridgeNeighbors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-neighbors-'));
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('returns [] for an empty uid set without touching the DB', async () => {
    // A null handle would throw if the DB were queried; the empty-set guard
    // must short-circuit before any query.
    const handleSentinel = null as unknown as Parameters<typeof resolveBridgeNeighbors>[0];
    const rows = await resolveBridgeNeighbors(handleSentinel, {
      localRepo: 'app/backend',
      uids: [],
      direction: 'upstream',
    });
    expect(rows).toEqual([]);
  });

  itLbugReopen('downstream: consumer uid resolves to its provider neighbor', async () => {
    await writeLinkedBridge(tmpDir);
    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    const rows = await resolveBridgeNeighbors(handle!, {
      localRepo: 'app/frontend',
      uids: ['consumer-uid'],
      direction: 'downstream',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      neighborRepo: 'app/backend',
      neighborUid: 'provider-uid',
      matchType: 'exact',
      confidence: 0.9,
      contractId: 'http::GET::/api/users',
      contractType: 'http',
    });
    await closeBridgeDb(handle!);
  });

  itLbugReopen('upstream: provider uid resolves to its consumer neighbor', async () => {
    await writeLinkedBridge(tmpDir);
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await resolveBridgeNeighbors(handle!, {
      localRepo: 'app/backend',
      uids: ['provider-uid'],
      direction: 'upstream',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      neighborRepo: 'app/frontend',
      neighborUid: 'consumer-uid',
      contractId: 'http::GET::/api/users',
    });
    await closeBridgeDb(handle!);
  });

  itLbugReopen('unknown uid yields no neighbors', async () => {
    await writeLinkedBridge(tmpDir);
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await resolveBridgeNeighbors(handle!, {
      localRepo: 'app/frontend',
      uids: ['no-such-uid'],
      direction: 'downstream',
    });
    expect(rows).toEqual([]);
    await closeBridgeDb(handle!);
  });
});
