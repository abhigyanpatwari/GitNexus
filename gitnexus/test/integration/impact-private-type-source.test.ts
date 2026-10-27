import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const sources: Record<string, string> = {
  'clause.ts': 'interface ClauseEntry { value: string }\nexport { ClauseEntry };\n',
  'commented.ts':
    'interface CommentedEntry {}\nexport function verifyCommented() {}\n// exported separately\nexport { CommentedEntry };\n',
  'commented-use.ts':
    "import type { CommentedEntry } from './commented';\nexport type Alias = CommentedEntry;\n",
  'clause-use.ts':
    "import type { ClauseEntry } from './clause';\nexport function consume(x: ClauseEntry) { return x.value; }\n",
  'default.ts': 'class DefaultEntry {}\nexport default DefaultEntry;\n',
  'default-use.ts': "import Entry from './default';\nexport { Entry };\n",
  'cjs.js': 'class CjsEntry {}\nmodule.exports = CjsEntry;\n',
  'cjs-use.js': "const Entry = require('./cjs');\nmodule.exports = Entry;\n",
  'ambient.d.ts': 'interface AmbientEntry { value: string }\n',
  'global.ts': "import './side';\ndeclare global { interface GlobalEntry { value: string } }\n",
  'side.ts': 'export const side = true;\n',
  'global-use.ts':
    "import './global';\nexport function consumeGlobal(x: GlobalEntry) { return x.value; }\n",
  'ambient-use.ts':
    "import type { AmbientEntry } from './ambient';\nexport function consumeAmbient(x: AmbientEntry) { return x.value; }\n",
  'private.ts':
    'interface PrivateEntry { value: string }\nexport function verify() { return true; }\n',
  'private-use.ts':
    "import { verify } from './private';\nexport function check() { return verify(); }\n",
  'private.js': 'class PrivateClass {}\nexport function verifyClass() { return true; }\n',
  'private-js-use.js':
    "import { verifyClass } from './private.js';\nexport function checkClass() { return verifyClass(); }\n",
};

let backend: LocalBackend;
let repoPath: string;
const exportFlags = new Map<string, boolean | undefined>();

withTestLbugDB(
  'impact-private-type-source',
  () => {
    it.each([
      ['ClauseEntry', 'clause-use.ts'],
      ['CommentedEntry', 'commented-use.ts'],
      ['DefaultEntry', 'default-use.ts'],
      ['CjsEntry', 'cjs-use.js'],
      ['AmbientEntry', 'ambient-use.ts'],
      ['GlobalEntry', 'global-use.ts'],
    ])('retains importers for %s despite the parser storing false', async (target, importer) => {
      expect(exportFlags.get(target)).toBe(false);
      const result = await backend.callTool('impact', { target, direction: 'upstream' });
      expect(
        (result.byDepth[1] ?? [])
          .filter((item: { id: string }) => item.id.startsWith('File:'))
          .map((item: { id: string }) => item.id),
      ).toEqual([`File:${importer}`]);
    });

    it.each(['PrivateEntry', 'PrivateClass'])(
      'does not borrow file importers for %s',
      async (target) => {
        expect(exportFlags.get(target)).toBe(false);
        const result = await backend.callTool('impact', { target, direction: 'upstream' });
        expect(result.impactedCount).toBe(0);
        expect(result.risk).toBe('UNKNOWN');
      },
    );
  },
  {
    poolAdapter: true,
    beforeFTS: async (dbPath) => {
      const storageDir = path.dirname(dbPath);
      repoPath = path.join(storageDir, 'source');
      await fs.mkdir(repoPath);
      await Promise.all(
        Object.entries(sources).map(([name, content]) =>
          fs.writeFile(path.join(repoPath, name), content),
        ),
      );
      const result = await runPipelineFromRepo(repoPath, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
      });
      for (const node of result.graph.nodes) {
        if (node.label === 'Class' || node.label === 'Interface') {
          exportFlags.set(node.properties.name, node.properties.isExported);
        }
      }
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(result.graph, repoPath, storageDir);
    },
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'private-source',
          path: repoPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
        },
      ]);
      backend = new LocalBackend();
      await backend.init();
    },
  },
);
