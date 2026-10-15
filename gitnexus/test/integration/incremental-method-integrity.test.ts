/**
 * Public-workflow regression for #3564/#3527. The reporters' private fixtures
 * and macOS environments are unavailable; passing this fixture does not
 * establish the cause of either report.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

type SymbolTuple = {
  uid: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
};

const FILE_COUNT = 70;
const METHODS_PER_FILE = 64;
const CHANGED_FILE = 'checks/test_batch_0.py';
const SWIFT_PATH = 'Sources/Sentinel.swift';
const SWIFT_SOURCE = 'struct UnrelatedSwiftSentinel {\n    let marker: Int = 701\n}\n';
const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const METHOD_SCAN = `MATCH (n:Method)
  RETURN n.id AS uid, n.name AS name, n.filePath AS filePath,
         n.startLine AS startLine, n.endLine AS endLine, n.content AS content
  ORDER BY uid`;

// The expected rows come from the source fixture, never from graph output or a
// previous database scan. Native spans are zero-based; context displays +1.
function pythonFixture(batch: number, changed = false): { source: string; tuples: SymbolTuple[] } {
  const filePath = `checks/test_batch_${batch}.py`;
  const className = `Batch${batch}`;
  const lines = ['import unittest', '', `class ${className}(unittest.TestCase):`];
  const tuples: SymbolTuple[] = [];
  for (let method = 0; method < METHODS_PER_FILE; method++) {
    const name = `test_sample_${batch}_${method}`;
    const body = [`    def ${name}(self):`, `        return ${batch * METHODS_PER_FILE + method}`];
    if (changed && method === 0) {
      body.splice(1, 0, '        updated_value = 9001');
      body[2] = '        return updated_value';
    }
    const startLine = lines.length;
    tuples.push({
      uid: `Method:${filePath}:${className}.${name}#0`,
      name,
      filePath,
      startLine,
      endLine: startLine + body.length - 1,
      // Stored symbol content preserves indentation and flattens newlines for FTS.
      content: body.join(' '),
    });
    lines.push(...body, '');
  }
  return { source: lines.join('\n'), tuples };
}

function expectContext(result: any, expected: SymbolTuple): void {
  expect(result).not.toHaveProperty('error');
  expect(result.status).toBe('found');
  expect(result.symbol).toMatchObject({
    ...expected,
    startLine: expected.startLine + 1,
    endLine: expected.endLine + 1,
  });
}

describe('Python Method identities across selective incremental writes with an optional Swift control (#3564, #3527)', () => {
  it('retains every source tuple across a class-method edit and fresh native/MCP readers', async () => {
    const temp = await createTempDir();
    let backend: LocalBackend | undefined;
    try {
      const root = await fs.realpath(temp.dbPath);
      const repo = path.join(root, 'method-integrity');
      await fs.mkdir(path.join(repo, 'checks'), { recursive: true });
      await fs.mkdir(path.join(repo, 'Sources'));
      await fs.mkdir(path.join(root, 'user-home'));
      vi.stubEnv('HOME', path.join(root, 'user-home'));
      vi.stubEnv('USERPROFILE', path.join(root, 'user-home'));
      vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
      vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
      vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      vi.stubEnv('GITNEXUS_CONTENT_RETENTION', 'full');
      vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
      vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
      await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
      if (swiftAvailable) await fs.writeFile(path.join(repo, SWIFT_PATH), SWIFT_SOURCE);
      const fixtures = Array.from({ length: FILE_COUNT }, (_, batch) => pythonFixture(batch));
      for (const fixture of fixtures) {
        await fs.writeFile(path.join(repo, fixture.tuples[0].filePath), fixture.source);
      }
      initGitRepo(repo);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      commitAll(repo, 'baseline Python methods and unrelated Swift struct');

      // This test isolates selective native writes from extension availability.
      // FTS corruption and query guards have separate real-native coverage.
      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      await runFullAnalysis(repo, options, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      backend = new LocalBackend();
      expect(await backend.init()).toBe(true);

      const readAll = async (expected: SymbolTuple[]): Promise<void> => {
        const ordered = [...expected].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
        // The entire Method table exceeds one 2048-row native vector. Reopen
        // the database for each scan rather than reusing the writer's view.
        await adapter.initLbug(lbugPath, { skipFts: true });
        try {
          expect(await adapter.executeQuery(METHOD_SCAN)).toEqual(ordered);
          if (swiftAvailable)
            expect(
              await adapter.executeQuery(
                `MATCH (n:Struct) RETURN n.id AS uid, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine, n.content AS content`,
              ),
            ).toEqual([
              {
                uid: `Struct:${SWIFT_PATH}:UnrelatedSwiftSentinel`,
                name: 'UnrelatedSwiftSentinel',
                filePath: SWIFT_PATH,
                startLine: 0,
                endLine: 2,
                content: SWIFT_SOURCE.trimEnd().replace(/\n/g, ' '),
              },
            ]);
        } finally {
          await adapter.closeLbug();
        }
        // Keep the same backend across both analyses, but release its native
        // reader before the in-place writer opens the DB. No mocked rows.
        const result = await backend!.callTool('cypher', { repo, statement: METHOD_SCAN });
        expect(result).not.toHaveProperty('error');
        expect(result.row_count).toBe(FILE_COUNT * METHODS_PER_FILE);
        expect(result.markdown).toBe(
          [
            '| uid | name | filePath | startLine | endLine | content |',
            '| --- | --- | --- | --- | --- | --- |',
            ...ordered.map(
              (tuple) =>
                `| ${Object.values(tuple)
                  .map((value) => String(value).replace(/\n/g, ' '))
                  .join(' | ')} |`,
            ),
          ].join('\n'),
        );
        for (const index of [0, 63, 2048, expected.length - 1]) {
          expectContext(
            await backend!.callTool('context', {
              repo,
              uid: expected[index].uid,
              include_content: true,
            }),
            expected[index],
          );
        }
        await backend!.dispose();
      };

      const before = fixtures.flatMap(({ tuples }) => tuples);
      expect(before).toHaveLength(4480);
      await readAll(before);

      const edited = pythonFixture(0, true);
      await fs.writeFile(path.join(repo, CHANGED_FILE), edited.source);
      commitAll(repo, 'edit one class method and shift later method spans');
      const refreshed = await runFullAnalysis(repo, options, { onProgress: () => {} });
      expect(refreshed.incrementalStats).toMatchObject({
        changedFiles: 1,
        deletedFiles: 0,
        writeMode: 'incremental',
      });
      await readAll([...edited.tuples, ...fixtures.slice(1).flatMap(({ tuples }) => tuples)]);
    } finally {
      await backend?.dispose();
      await adapter.closeLbug();
      vi.unstubAllEnvs();
      await temp.cleanup();
    }
  }, 180_000);
});
