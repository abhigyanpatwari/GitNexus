/**
 * E2E Integration Tests: data_flow tool (StateSlot shape conflict detection)
 *
 * Tests the full stack: LadybugDB seed → MCP tool call → result verification.
 * Covers StateSlot listing, filtering by kind/query, shape conflict detection,
 * and mismatchesOnly filtering.
 *
 * Uses hand-crafted Cypher seed data that represents what the pipeline
 * would produce for a project with React Query and SWR hooks sharing cache keys.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { STATE_SLOT_SEED_DATA, STATE_SLOT_FTS_INDEXES } from '../fixtures/state-slot-seed.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

withTestLbugDB('data-flow-e2e', (handle) => {
  let backend: LocalBackend;

  beforeAll(async () => {
    const ext = handle as typeof handle & { _backend?: LocalBackend };
    if (!ext._backend) {
      throw new Error('LocalBackend not initialized — afterSetup did not attach _backend to handle');
    }
    backend = ext._backend;
  });

  // ─── Test 1: Returns all state slots when no filter ──────────────

  describe('unfiltered listing', () => {
    it('returns all state slots when no filter is provided', async () => {
      const result = await backend.callTool('data_flow', {});

      expect(result).not.toHaveProperty('error');
      expect(result.slots).toBeDefined();
      expect(result.slots.length).toBe(2);
      expect(result.total).toBe(2);

      const names = result.slots.map((s: any) => s.name);
      expect(names).toContain('["vendor-patterns", slug]');
      expect(names).toContain('["vendor-stats", slug]');
    });
  });

  // ─── Test 2: Filters by slotKind ────────────────────────────────

  describe('slotKind filter', () => {
    it('returns only react-query slots when filtered by slotKind', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'react-query' });

      expect(result.slots.length).toBe(1);
      expect(result.slots[0].slotKind).toBe('react-query');
      expect(result.slots[0].name).toBe('["vendor-patterns", slug]');
    });
  });

  // ─── Test 3: Filters by query substring ─────────────────────────

  describe('query filter', () => {
    it('filters by query substring in slot name', async () => {
      const result = await backend.callTool('data_flow', { query: 'vendor-patterns' });

      expect(result.slots.length).toBe(1);
      expect(result.slots[0].name).toContain('vendor-patterns');
    });
  });

  // ─── Test 4: Detects shape conflict in shared cache key ─────────

  describe('shape conflict detection', () => {
    it('detects conflict when two producers write different shapes to the same slot', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'react-query' });

      const conflictSlot = result.slots.find((s: any) => s.name.includes('vendor-patterns'));
      expect(conflictSlot).toBeDefined();
      expect(conflictSlot.verdict).toBe('conflict');
    });

    it('reports conflict count in summary', async () => {
      const result = await backend.callTool('data_flow', {});

      expect(result.conflicts).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Test 5: Shows ok verdict for non-conflicting slot ──────────

  describe('ok verdict', () => {
    it('shows ok verdict for SWR slot with single producer', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'swr' });

      expect(result.slots.length).toBe(1);
      expect(result.slots[0].verdict).toBe('ok');
    });
  });

  // ─── Test 6: mismatchesOnly filters to conflicts only ───────────

  describe('mismatchesOnly filter', () => {
    it('returns only non-ok slots when mismatchesOnly is set', async () => {
      const result = await backend.callTool('data_flow', { mismatchesOnly: 'true' });

      expect(result.total).toBeLessThan(2);
      expect(result.slots.length).toBeGreaterThanOrEqual(1);
      for (const slot of result.slots) {
        expect(slot.verdict).not.toBe('ok');
      }
    });
  });

  // ─── Test 7: Returns producer and consumer details ──────────────

  describe('producer and consumer details', () => {
    it('returns correct producer names, files, and keys', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'react-query' });
      const slot = result.slots[0];

      expect(slot.producers.length).toBe(2);

      const producerNames = slot.producers.map((p: any) => p.name);
      expect(producerNames).toContain('useVendorPatterns');
      expect(producerNames).toContain('useVendorPatternsSummary');

      const fullProducer = slot.producers.find((p: any) => p.name === 'useVendorPatterns');
      expect(fullProducer.filePath).toBe('hooks/useVendorPatterns.ts');
      expect(fullProducer.keys).toEqual(expect.arrayContaining(['patterns', 'total', 'page']));

      const summaryProducer = slot.producers.find((p: any) => p.name === 'useVendorPatternsSummary');
      expect(summaryProducer.filePath).toBe('hooks/useVendorPatternsSummary.ts');
      expect(summaryProducer.keys).toEqual(expect.arrayContaining(['patterns', 'page']));
      // Summary producer should NOT have 'total' key — this is the source of the conflict
      expect(summaryProducer.keys).not.toContain('total');
    });

    it('returns correct consumer names and accessed keys', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'react-query' });
      const slot = result.slots[0];

      expect(slot.consumers.length).toBe(2);

      const consumerNames = slot.consumers.map((c: any) => c.name);
      expect(consumerNames).toContain('VendorDashboard');
      expect(consumerNames).toContain('VendorSidebar');

      const dashboard = slot.consumers.find((c: any) => c.name === 'VendorDashboard');
      expect(dashboard.filePath).toBe('components/VendorDashboard.tsx');
      expect(dashboard.accessedKeys).toEqual(expect.arrayContaining(['patterns', 'total', 'page']));
    });

    it('returns SWR slot producer and consumer details', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'swr' });
      const slot = result.slots[0];

      expect(slot.producers.length).toBe(1);
      expect(slot.producers[0].name).toBe('useVendorStats');
      expect(slot.producers[0].keys).toEqual(expect.arrayContaining(['count', 'trend']));

      expect(slot.consumers.length).toBe(1);
      expect(slot.consumers[0].name).toBe('VendorStatsWidget');
      expect(slot.consumers[0].accessedKeys).toEqual(expect.arrayContaining(['count', 'trend']));
    });
  });

}, {
  seed: STATE_SLOT_SEED_DATA,
  ftsIndexes: STATE_SLOT_FTS_INDEXES,
  poolAdapter: true,
  afterSetup: async (handle) => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'test-data-flow-repo',
        path: '/test/data-flow-repo',
        storagePath: handle.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
        stats: { files: 6, nodes: 12, communities: 1, processes: 0 },
      },
    ]);

    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
  },
});
