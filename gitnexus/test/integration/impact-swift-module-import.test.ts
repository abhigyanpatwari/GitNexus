/**
 * Consumers of persisted IMPORTS for a Swift `import X`: impact, context and a
 * "files importing this file" Cypher see the importer only on the module files
 * it uses. For impact the IMPORTS edge is the file-level record of a type
 * dependency, so the used file must keep it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const USED = 'Sources/DTO/Used.swift';
const UNUSED = 'Sources/DTO/Unused.swift';
const VIEW = 'Sources/App/View.swift';

const sources: Record<string, string> = {
  'Package.swift': [
    '// swift-tools-version:5.7',
    'import PackageDescription',
    '',
    'let package = Package(',
    '    name: "Shop",',
    '    targets: [',
    '        .target(name: "DTO"),',
    '        .target(name: "App", dependencies: ["DTO"]),',
    '    ]',
    ')',
    '',
  ].join('\n'),
  // Classes: impact and context seed a class's owning file, whose incoming
  // IMPORTS are the importers.
  [USED]: 'public final class Used {\n    public let id: Int = 1\n}\n',
  [UNUSED]: 'public final class Unused {\n    public let id: Int = 1\n}\n',
  [VIEW]: 'import DTO\n\nfunc show(_ item: Used) -> Int {\n    return item.id\n}\n',
};

let backend: LocalBackend;
let repoPath: string;

const fileIds = (result: { byDepth?: Record<string, { id: string }[]> }): string[] =>
  Object.values(result.byDepth ?? {})
    .flat()
    .map((item) => item.id)
    .filter((id) => id.startsWith('File:'));

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))('Swift import X consumers', () => {
  withTestLbugDB(
    'impact-swift-module-import',
    () => {
      it('lists the importer at depth 1 for the type it uses', async () => {
        const result = await backend.callTool('impact', {
          target: 'Used',
          file_path: USED,
          direction: 'upstream',
        });
        expect((result.byDepth[1] ?? []).map((item: { id: string }) => item.id)).toContain(
          `File:${VIEW}`,
        );
      });

      it('does not list the importer for a module type it never names', async () => {
        const result = await backend.callTool('impact', {
          target: 'Unused',
          file_path: UNUSED,
          direction: 'upstream',
        });
        expect(fileIds(result)).not.toContain(`File:${VIEW}`);
      });

      it('shows the importer as an incoming import of the used type only', async () => {
        const used = await backend.callTool('context', { name: 'Used', file_path: USED });
        expect((used.incoming.imports ?? []).map((row: { name: string }) => row.name)).toEqual([
          'View.swift',
        ]);
        const unused = await backend.callTool('context', { name: 'Unused', file_path: UNUSED });
        expect(unused.incoming.imports ?? []).toEqual([]);
      });

      it('answers "files importing this file" with the importer of the used file only', async () => {
        const importers = async (target: string) =>
          backend.callTool('cypher', {
            statement:
              "MATCH (a:File)-[r:CodeRelation {type: 'IMPORTS'}]->(b:File {filePath: $target}) " +
              'RETURN a.filePath AS importer',
            params: { target },
          });
        const used = await importers(USED);
        expect(used.row_count).toBe(1);
        expect(used.markdown).toContain(VIEW);
        expect((await importers(UNUSED)).row_count).toBe(0);
      });
    },
    {
      poolAdapter: true,
      beforeFTS: async (dbPath) => {
        const storageDir = path.dirname(dbPath);
        repoPath = path.join(storageDir, 'source');
        for (const [name, content] of Object.entries(sources)) {
          await fs.mkdir(path.dirname(path.join(repoPath, name)), { recursive: true });
          await fs.writeFile(path.join(repoPath, name), content);
        }
        const result = await runPipelineFromRepo(repoPath, () => {}, {
          skipGraphPhases: true,
          workerPoolSize: 1,
        });
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.loadGraphToLbug(result.graph, repoPath, storageDir);
      },
      afterSetup: async (handle) => {
        vi.mocked(listRegisteredRepos).mockResolvedValue([
          {
            name: 'swift-module-import',
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
});
