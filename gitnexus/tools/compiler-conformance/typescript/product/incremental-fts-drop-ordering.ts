/**
 * #2589: the incremental writeback must drop every FTS index BEFORE
 * `deleteNodesForFiles` runs its batched DETACH DELETE — not only in
 * Phase 3, after the delete already ran against a table still carrying the
 * PREVIOUS run's index. This drives the real `runFullAnalysis` incremental
 * path (real git repo, real LadybugDB, real FTS extension) and asserts,
 * at the moment `deleteNodesForFiles` is invoked, that `SHOW_INDEXES()`
 * already reports FTS indexes for tables that will be DML'd as absent
 * (#2589 drop-before-delete). #3016: empty-language FTS tables may remain.
 */
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from 'expect';
import { extensionAvailable, incrementalExtensions } from '../support/incremental-extensions.js';
import { setupMiniRepo } from '../../../../test/helpers/mini-repo.js';
import { getStoragePaths } from '../../../../dist/storage/repo-manager.js';
import { FTS_INDEXES } from '../../../../dist/core/search/fts-schema.js';

const observe = await incrementalExtensions();
const available = await extensionAvailable('FTS');

describe(
  'runFullAnalysis incremental writeback — FTS drop-before-delete ordering (#2589)',
  { skip: !available && 'FTS unavailable' },
  () => {
    it(
      'SHOW_INDEXES() reports the FTS indexes of every table being written as absent by the time deleteNodesForFiles runs',
      { timeout: 300_000 },
      async () => {
        const lbugAdapter = await import('../../../../dist/core/lbug/lbug-adapter.js');
        const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');

        const repo = await setupMiniRepo('gitnexus-2589-fts-order-');
        try {
          // First run: full rebuild, builds FTS indexes for populated tables.
          await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

          // runFullAnalysis closes its own connection on return — open a fresh
          // one just to probe SHOW_INDEXES(), then close it before the second
          // run opens its own (LadybugDB is single-writer/single-connection).
          const { lbugPath } = getStoragePaths(repo.dbPath);
          await lbugAdapter.initLbug(lbugPath);
          const showIndexNames = async (): Promise<string[]> => {
            const rows = (await lbugAdapter.executeQuery('CALL SHOW_INDEXES() RETURN *')) as Array<
              Record<string, unknown>
            >;
            return rows.map((r) => r.index_name).filter((n): n is string => typeof n === 'string');
          };
          const beforeChange = await showIndexNames();
          const populated: string[] = [];
          for (const { table, indexName } of FTS_INDEXES) {
            const [row] = await lbugAdapter.executeQuery(
              `MATCH (n:\`${table}\`) RETURN count(n) AS count`,
            );
            if (Number(row.count) > 0) populated.push(indexName);
          }
          await lbugAdapter.closeLbug();

          // Hard assertion, not a soft skip: the extension probe already proved
          // the extension loads, so a populated table's index failing to build is a real
          // bug in the full-rebuild FTS phase, not an environment gap.
          expect(populated.length).toBeGreaterThan(0);
          const configured = FTS_INDEXES.map((i) => i.indexName);
          expect(beforeChange.filter((name) => configured.includes(name)).sort()).toEqual(
            populated.sort(),
          );

          // Spy on the real deleteNodesForFiles, recording the FTS index list at
          // the exact moment it's invoked (before it does anything), then
          // delegating to the real implementation so the run completes normally.
          let indexNamesAtDeleteTime: string[] | undefined;
          observe.beforeDelete = async () => {
            indexNamesAtDeleteTime = await showIndexNames();
          };

          // Small change to a single file — stays well under the escalation
          // threshold (50 files) on this 7-file mini-repo, so it takes the
          // non-escalated (surgical) incremental branch this test targets.
          const handlerPath = path.join(repo.dbPath, 'src', 'handler.ts');
          await writeFile(
            handlerPath,
            (await readFile(handlerPath, 'utf-8')) + '\n// #2589 ordering-test touch\n',
            'utf-8',
          );
          execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
            cwd: repo.dbPath,
            stdio: 'pipe',
          });
          execSync(
            'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "#2589 ordering touch"',
            { cwd: repo.dbPath, stdio: 'pipe' },
          );

          await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

          assert.ok(indexNamesAtDeleteTime, 'deleteNodesForFiles must run for the changed file');
          // handler.ts writes File/Function/Class/Method. The incremental write set
          // also pulls importer-expanded mini-repo files (index.ts re-exports
          // handler; validator.ts holds Interface + Property), so those FTS
          // indexes must be down before DETACH DELETE (#2589). Every other
          // populated FTS index must still be live (#3016 narrowing).
          const down = new Set([
            'file_fts',
            'function_fts',
            'class_fts',
            'method_fts',
            'interface_fts',
            'property_fts',
          ]);
          const ftsAtDelete = indexNamesAtDeleteTime.filter((name) => configured.includes(name));
          expect([...ftsAtDelete].sort()).toEqual(
            populated.filter((name) => !down.has(name)).sort(),
          );
          for (const name of down) {
            expect(ftsAtDelete).not.toContain(name);
          }
        } finally {
          await repo.cleanup();
        }
      },
    );
  },
);
