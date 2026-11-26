import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

it.each(['ts', 'js'])(
  'updates unchanged callers when a property key crosses the budget (%s)',
  async (extension) => {
    const temp = await createTempDir();
    vi.resetModules();
    vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY', '5');
    vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT', '32');
    const { closeLbug, executeQuery, initLbug } =
      await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const { getStoragePaths } = await import('../../src/storage/repo-manager.js');
    try {
      const root = await fs.realpath(temp.dbPath);
      vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
      vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
      vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
      const repo = path.join(root, 'incremental');
      const coldRepo = path.join(root, 'cold');
      const left = (count: number) =>
        `export function left(provider) { ${'provider.run(); '.repeat(count)} }\n`;
      for (const target of [repo, coldRepo]) {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, '.gitignore'), '.gitnexus/\n');
        await fs.writeFile(
          path.join(target, `registry.${extension}`),
          'export function first() {}\nexport function second() {}\n' +
            'export const one = { run: first };\nexport const two = { run: second };\n',
        );
        await fs.writeFile(
          path.join(target, `right.${extension}`),
          'export function right(provider) { provider.run(); }\n',
        );
        // Unrelated files ensure this really exercises selective writeback.
        for (let i = 0; i < 12; i++) {
          await fs.writeFile(
            path.join(target, `independent-${i}.${extension}`),
            `export function standalone${i}() { return ${i}; }\n`,
          );
        }
        await fs.writeFile(path.join(target, `left.${extension}`), left(1));
        initGitRepo(target);
        commitAll(target, 'initial property dispatch');
      }
      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      const callbacks = { onProgress: () => {} };
      const readEdges = async (target: string) => {
        await initLbug(getStoragePaths(target).lbugPath, { skipFts: true });
        try {
          return await executeQuery(
            'MATCH (a)-[r:CodeRelation]->(b) WHERE r.reason IN ' +
              "['property-dispatch', 'scope-resolution: value-ref'] " +
              'RETURN a.name AS source, b.name AS target, r.type AS type ' +
              'ORDER BY source, target, type',
          );
        } finally {
          await closeLbug();
        }
      };
      for (const [step, [count, expectedCalls]] of (
        [
          [1, 4],
          [2, 0],
          [1, 4],
        ] as const
      ).entries()) {
        for (const target of [repo, coldRepo]) {
          await fs.writeFile(path.join(target, `left.${extension}`), left(count));
        }
        const result = await runFullAnalysis(repo, options, callbacks);
        if (step > 0) {
          expect(result.incrementalStats).toMatchObject({
            changedFiles: 1,
            writeMode: 'incremental',
          });
        }
        // A fresh parser and full DB rebuild provide the independent control.
        await runFullAnalysis(
          coldRepo,
          { ...options, force: true, useParseCache: false },
          callbacks,
        );
        const cold = await readEdges(coldRepo);
        expect(cold.filter((edge) => edge.type === 'CALLS')).toHaveLength(expectedCalls);
        expect(cold.filter((edge) => edge.type === 'USES')).toHaveLength(2);
        expect(await readEdges(repo)).toEqual(cold);
      }
    } finally {
      await closeLbug();
      vi.unstubAllEnvs();
      await temp.cleanup();
    }
  },
  180_000,
);
