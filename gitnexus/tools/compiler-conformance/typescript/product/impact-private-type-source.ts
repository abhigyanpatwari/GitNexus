import fs from 'node:fs/promises';
import path from 'node:path';
import { after, it } from 'node:test';
import { expect } from 'expect';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { LocalBackend } from '../../../../src/mcp/local/local-backend.js';
import { registerRepo, saveMeta } from '../../../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../support/indexed-db.js';
import { registerCases } from '../support/cases.mjs';
import { createTestEnvironment } from '../support/environment.js';

const typescriptProject = new URL(
  '../../../../test/fixtures/compiler-conformance/typescript-private-type-imports/',
  import.meta.url,
);
const environment = createTestEnvironment();
after(async () => {
  try {
    await backend?.dispose();
  } finally {
    environment.restore();
  }
});

const otherSources: Record<string, string> = {
  'invoice.py': 'class Invoice:\n    pass\n\ndef total():\n    return 1\n',
  'billing.py': 'from invoice import Invoice\ndef bill():\n    return Invoice()\n',
  'totals.py': 'from invoice import total\ndef report():\n    return total()\n',
  'value-alias.js':
    'class ValueAliasedClass {}\nexport const PublishedClass = ValueAliasedClass;\n',
  'value-alias-use.js':
    "import { PublishedClass } from './value-alias';\nexport function constructAlias() { return new PublishedClass(); }\n",
  'cjs.js': 'class CjsEntry {}\nmodule.exports = CjsEntry;\n',
  'cjs-use.js': "const Entry = require('./cjs');\nmodule.exports = Entry;\n",
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
    registerCases(
      it,
      [
        ['ClauseEntry', 'clause-use.ts'],
        ['CommentedEntry', 'commented-use.ts'],
        ['DefaultEntry', 'default-use.ts'],
        ['AliasedEntry', 'type-alias-use.ts'],
        ['AliasedClass', 'wrapped-alias-use.ts'],
        ['CjsEntry', 'cjs-use.js'],
        ['AmbientEntry', 'ambient-use.ts'],
        ['GlobalEntry', 'global-use.ts'],
      ],
      'retains importers for %s despite the parser storing false',
      async (target: string, importer: string) => {
        expect(exportFlags.get(target)).toBe(false);
        const result = await backend.callTool('impact', { target, direction: 'upstream' });
        expect(
          (result.byDepth[1] ?? [])
            .filter((item: { id: string }) => item.id.startsWith('File:'))
            .map((item: { id: string }) => item.id),
        ).toEqual([`File:${importer}`]);
      },
    );

    it('reports only evidenced Python class dependants when a module exports several symbols', async () => {
      const result = await backend.callTool('impact', {
        target: 'Invoice',
        direction: 'upstream',
        maxDepth: 1,
      });
      expect(result.byDepth[1].map((row: { filePath: string }) => row.filePath)).toEqual([
        'billing.py',
      ]);
    });

    it('retains importers of a class exposed through an exported value alias', async () => {
      expect(exportFlags.get('ValueAliasedClass')).toBe(false);
      const result = await backend.callTool('impact', {
        target: 'ValueAliasedClass',
        direction: 'upstream',
      });
      expect(
        Object.values(result.byDepth as Record<string, { id: string }[]>)
          .flat()
          .map((item) => item.id),
      ).toContain('File:value-alias-use.js');
    });

    registerCases(
      it,
      ['PrivateEntry', 'PrivateClass'],
      'does not borrow file importers for %s',
      async (target: string) => {
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
      await fs.cp(typescriptProject, repoPath, { recursive: true });
      await Promise.all(
        Object.entries(otherSources).map(([name, content]) =>
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
      const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(result.graph, repoPath, storageDir);
    },
    afterSetup: async (handle) => {
      const storagePath = handle.tmpHandle.dbPath;
      environment.set('GITNEXUS_HOME', path.join(storagePath, 'home'));
      const meta = {
        repoPath,
        storagePath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
      };
      await saveMeta(storagePath, meta);
      await registerRepo(repoPath, meta, { name: 'private-source', storagePath });
      backend = new LocalBackend();
      await backend.init();
    },
  },
);
