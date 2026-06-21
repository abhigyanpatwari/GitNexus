/**
 * Integration tests: every singleton-`conn` helper reachable during the
 * WAL-checkpoint-driver window must route through `withConnLock` (PR #2264
 * tri-review, P1). These helpers issued raw `conn.query` on the shared
 * connection while the driver could fire a concurrent CHECKPOINT — the same
 * native double-free this branch fixes, on the incremental `--pdg` path.
 *
 * Mirrors `lbug-core-adapter.test.ts`: one isolated temp DB via `withTestLbugDB`.
 * `withConnLock` is mocked to a call-through spy so we can assert each helper
 * acquires the lock while the real serialization still runs. Routing assertions
 * use an empty (initialized) DB — they prove the lock is taken regardless of
 * whether any rows match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// Spy `withConnLock` while preserving its real behavior (call-through). The
// adapter imports this module, so the spy observes every lock acquisition.
vi.mock('../../src/core/lbug/conn-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/conn-lock.js')>();
  return {
    ...actual,
    withConnLock: vi.fn(actual.withConnLock) as typeof actual.withConnLock,
  };
});
import { withConnLock } from '../../src/core/lbug/conn-lock.js';
const lockSpy = vi.mocked(withConnLock);

withTestLbugDB('conn-serialization', () => {
  describe('singleton-conn helpers acquire withConnLock (P1 #2264)', () => {
    beforeEach(() => {
      // Setup (clear/seed/flush) already exercised the lock; reset so each
      // assertion reflects only the helper under test.
      lockSpy.mockClear();
    });

    it('U1: deleteAllCommunitiesAndProcesses routes through withConnLock', async () => {
      const { deleteAllCommunitiesAndProcesses } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const result = await deleteAllCommunitiesAndProcesses();
      expect(lockSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ nodesDeleted: 0 });
    });

    it('U2: queryImporters routes through withConnLock', async () => {
      const { queryImporters } = await import('../../src/core/lbug/lbug-adapter.js');
      const importers = await queryImporters('any/path.ts');
      expect(lockSpy).toHaveBeenCalled();
      expect(importers).toEqual([]);
    });
  });
});
