/**
 * Integration test: an empty upstream walk is UNKNOWN risk, never LOW.
 *
 * `risk: LOW` asserts "safe to change". That is a claim ABOUT callers, so a
 * walk that resolved NONE has nothing to base it on: the symbol is either
 * genuinely unused, or reached only through a reference class the index does
 * not record (a property access on a plain object, a bare-identifier read of a
 * module-scope `Const` — neither mints a reference site today). Reporting LOW
 * there is the false-safe signal `anyKnownRisk` already refuses to emit on the
 * ambiguous-candidate path, and that #2687 removed by making an undetermined
 * `impactedCount` `null` rather than `0`.
 *
 * Direction matters: an empty DOWNSTREAM walk says this symbol resolved no
 * callees, which is not a safety verdict, so it keeps its existing risk.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SEED = [
  // No edges in either direction — the empty-walk case.
  `CREATE (orphan:Function {id: 'Function:src/orphan.ts:orphanHelper', name: 'orphanHelper', filePath: 'src/orphan.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  // A resolved caller -> callee pair — the control that must stay LOW.
  `CREATE (used:Function {id: 'Function:src/used.ts:usedHelper', name: 'usedHelper', filePath: 'src/used.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (caller:Function {id: 'Function:src/caller.ts:callerFn', name: 'callerFn', filePath: 'src/caller.ts', startLine: 1, endLine: 8, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/caller.ts:callerFn'}), (b:Function {id:'Function:src/used.ts:usedHelper'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
  // Two symbols sharing a name, both caller-less: forces the AMBIGUOUS
  // fan-out, which builds its own candidate shape rather than returning the
  // single-symbol one.
  `CREATE (t1:Function {id: 'Function:src/a.ts:orphanTwin', name: 'orphanTwin', filePath: 'src/a.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (t2:Function {id: 'Function:src/b.ts:orphanTwin', name: 'orphanTwin', filePath: 'src/b.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
];

withTestLbugDB(
  'impact-zero-caller-risk',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('reports UNKNOWN, not LOW, when an upstream walk resolves no callers', async () => {
      const result = await backend.callTool('impact', {
        target: 'orphanHelper',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.impactedCount).toBe(0);
      expect(result.risk).toBe('UNKNOWN');
    });

    // The ambiguous fan-out narrows candidates into a fresh object, and that
    // shape had no `riskNote` field — so the same `UNKNOWN` arrived with no
    // explanation, on the path where the reader has the LEAST context. The
    // note is the whole point of the verdict.
    it('carries riskNote onto ambiguous candidates too', async () => {
      const result = await backend.callTool('impact', {
        target: 'orphanTwin',
        direction: 'upstream',
      });
      expect(result.status).toBe('ambiguous');
      const candidates = result.candidates as {
        risk: string;
        riskNote?: string;
        probeFailed?: boolean;
      }[];
      expect(candidates.length).toBeGreaterThan(1);
      for (const c of candidates) {
        expect(c.risk).toBe('UNKNOWN');
        expect(typeof c.riskNote).toBe('string');
        expect(c.riskNote).toMatch(/not evidence/i);
      }
    });

    // `UNKNOWN` on this path used to mean exactly one thing — the probe threw.
    // The zero-caller branch gives it a second meaning, so a reader must still
    // be able to tell a resolved-and-empty walk from a broken one.
    it('marks a resolved zero-caller candidate as NOT probe-failed', async () => {
      const result = await backend.callTool('impact', {
        target: 'orphanTwin',
        direction: 'upstream',
      });
      const candidates = result.candidates as { probeFailed?: boolean }[];
      for (const c of candidates) expect(c.probeFailed).toBeUndefined();
    });

    it('explains the withheld verdict in riskNote', async () => {
      const result = await backend.callTool('impact', {
        target: 'orphanHelper',
        direction: 'upstream',
      });
      expect(typeof result.riskNote).toBe('string');
      // The note must say absence-of-edges is not proof of disuse; an agent
      // gating its own edits reads this instead of inferring safety from 0.
      expect(result.riskNote).toMatch(/not evidence/i);
    });

    it('leaves a resolved caller set at LOW with no riskNote', async () => {
      const result = await backend.callTool('impact', {
        target: 'usedHelper',
        direction: 'upstream',
      });
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
      expect(result.risk).toBe('LOW');
      expect(result.riskNote).toBeUndefined();
    });

    it('does not hedge an empty DOWNSTREAM walk — that is not a safety claim', async () => {
      const result = await backend.callTool('impact', {
        target: 'orphanHelper',
        direction: 'downstream',
      });
      expect(result.impactedCount).toBe(0);
      expect(result.risk).toBe('LOW');
      expect(result.riskNote).toBeUndefined();
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 3, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
