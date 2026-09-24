/**
 * R3-1 — an empty incoming list must say WHY when the analyzer declined.
 *
 * Per-language inference is correct: a JavaScript read must not resolve to a
 * Java field on name uniqueness alone. But declining silently makes an empty
 * result for a field anchored only in another language byte-identical to an
 * empty result for a field nobody reads — and those demand opposite actions
 * ("look in the other language, or grep" versus "delete it").
 *
 * Found out-of-sample: six fields in the reporting repo whose definitions live
 * only in `apps/research-dashboard/**` answered 0 for every backend read, while
 * the in-sample set — which happened to be exactly the anchored subset — scored
 * 5/5. That gap is the whole finding.
 *
 * The graph cannot answer this at query time: the unlinked reads mint no edge
 * and no node, so the only record is the analyze pass that declined them. Hence
 * the fact travels through repo meta.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});

import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const SEED = [
  // The anchor: a TypeScript-side property. Its JavaScript readers produced no
  // edge, which is exactly the state under test.
  `CREATE (p:\`Property\` {id:'Property:apps/dash/src/api/live.ts:LiveRow.wickRatio', name:'wickRatio', filePath:'apps/dash/src/api/live.ts', startLine:4, endLine:4, content:'wickRatio: number;', description:''})`,
  // A control property with no cross-language story at all.
  `CREATE (q:\`Property\` {id:'Property:apps/dash/src/api/live.ts:LiveRow.plainField', name:'plainField', filePath:'apps/dash/src/api/live.ts', startLine:5, endLine:5, content:'plainField: number;', description:''})`,
];

type BackendHandle = IndexedDBHandle & { _backend?: LocalBackend };

withTestLbugDB(
  'context-cross-language-anchor',
  (handle) => {
    describe('context() explains a cross-language-only anchor (R3-1)', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as BackendHandle;
        if (!ext._backend) {
          throw new Error('LocalBackend not initialized — afterSetup did not attach _backend');
        }
        backend = ext._backend;
      });

      it('attaches the reason and the anchor languages', async () => {
        const result = await backend.callTool('context', { name: 'wickRatio' });
        expect(result).not.toHaveProperty('error');
        // Asserted present, NOT guarded on. An `if (undefined) return` here
        // would skip every assertion below and pass with the feature deleted —
        // which is exactly how the round-2 ambiguity assertion went vacuous.
        expect(result.anchorLanguages).toBeDefined();
        expect(result.anchorLanguages).toContain('typescript');
        expect(String(result.unresolved)).toMatch(/not linked/i);
        // The note must not be mistakable for "unused".
        expect(String(result.unresolved)).toMatch(/not evidence the field is unused/i);
      });

      it('says nothing for a property with no cross-language story', async () => {
        const result = await backend.callTool('context', { name: 'plainField' });
        expect(result).not.toHaveProperty('error');
        expect(result.unresolved).toBeUndefined();
        expect(result.anchorLanguages).toBeUndefined();
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const storagePath = handle.tmpHandle.dbPath;
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 2, communities: 0, processes: 0 },
        },
      ] as never);
      // Stamp exactly what the analyze pass records when it declines to link a
      // field whose only definitions are in another language.
      const metaDir = path.dirname(handle.dbPath);
      const meta = (await loadMeta(metaDir)) ?? {};
      await saveMeta(metaDir, {
        ...meta,
        crossLanguageProperties: [{ name: 'wickRatio', languages: ['typescript'] }],
      } as never);
      expect(fs.existsSync(metaDir)).toBe(true);
      const backend = new LocalBackend();
      await backend.init();
      (handle as BackendHandle)._backend = backend;
    },
  },
);
