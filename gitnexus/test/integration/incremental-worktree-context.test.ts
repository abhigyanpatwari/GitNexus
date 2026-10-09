/**
 * Characterize #3423's public workflow against the current analyzer. The
 * original private database is unavailable; this fixture does not reproduce
 * or establish the cause of that historical incident.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { CLI_SPAWN_PREFIX, tsxLoaderUrl } from '../helpers/cli-entry.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const SWIFT_PATH = 'Sources/Numbers.swift';
const TEST_PATH = 'checks/test_numbers.py';
const IMPORTER_PATH = 'checks/runner.py';
const TARGET_NAME = 'extractLeadingNumber';
const PROPERTY_NAME = 'preservedSearchNeedle';
const CALLER_NAMES = ['parsePrimaryNumber', 'parseSecondaryNumber'];
const options = { skipAgentsMd: true, skipSkills: true };
const callbacks = { onProgress: () => {} };

const SWIFT_SOURCE = `func extractLeadingNumber(_ raw: String) -> Int {
    return 7
}

func parsePrimaryNumber() -> Int {
    return extractLeadingNumber("17")
}

func parseSecondaryNumber() -> Int {
    return extractLeadingNumber("23")
}

class NumberSettings {
    var preservedSearchNeedle: String = "retained property"
}
`;

type SymbolRef = { uid: string; name: string; filePath: string };
type ContextResult = {
  status: string;
  symbol: SymbolRef;
  incoming: { calls?: SymbolRef[] };
};
type StatusResult = {
  repository: string;
  status: string;
  contentDrift: { status: string; coveredFiles?: number };
  index: { incompleteReasons: string[]; runnerIdentityStatus: string };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function runCli<T>(cwd: string, args: string[], prefix = CLI_SPAWN_PREFIX): T {
  const stdout = execFileSync(process.execPath, [...prefix, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  // Context prints a human-readable banner before its JSON response.
  const start = stdout.indexOf('{');
  expect(start, stdout).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as T;
}

function expectContext(result: ContextResult, target: SymbolRef, callers: SymbolRef[]): void {
  expect(result).not.toHaveProperty('error');
  expect(result.status).toBe('found');
  expect(result.symbol).toMatchObject(target);
  const actual = (result.incoming.calls ?? []).map(({ uid, name, filePath }) => ({
    uid,
    name,
    filePath,
  }));
  expect(actual.sort((a, b) => a.uid.localeCompare(b.uid))).toEqual(
    [...callers].sort((a, b) => a.uid.localeCompare(b.uid)),
  );
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
  'unchanged Swift context across a selective linked-worktree refresh (#3423)',
  () => {
    it('retains CLI/MCP name and UID context, both callers, and native Property FTS', async (ctx) => {
      const temp = await createTempDir();
      let backend: LocalBackend | undefined;
      try {
        const root = await fs.realpath(temp.dbPath);
        const main = path.join(root, 'main');
        const worktree = path.join(root, 'linked');
        const nativeHome = path.join(root, 'user-home');
        await fs.mkdir(nativeHome);
        vi.stubEnv('HOME', nativeHome);
        vi.stubEnv('USERPROFILE', nativeHome);
        vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
        vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
        vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
        // Keep a real linked checkout, but avoid the shared-store seed/full
        // rebuild path: the behavior under test is selective row replacement.
        vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
        vi.stubEnv('GITNEXUS_CONTENT_RETENTION', 'full');
        vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
        vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');

        await adapter.initLbug(path.join(root, 'fts-probe'));
        // Require an existing extension; a network install would make this
        // isolated fixture depend on the developer's machine or connectivity.
        if (!(await adapter.loadFTSExtension(undefined, { policy: 'load-only' }))) {
          if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
            throw new Error(
              'FTS is required (GITNEXUS_REQUIRE_FTS=1) but could not load in the isolated fixture.',
            );
          }
          ctx.skip('FTS extension unavailable under the load-only policy');
        }
        await adapter.closeLbug();

        await fs.mkdir(path.join(main, 'Sources'), { recursive: true });
        await fs.mkdir(path.join(main, 'checks'), { recursive: true });
        await fs.mkdir(path.join(main, 'retained'), { recursive: true });
        await fs.writeFile(path.join(main, '.gitignore'), '.gitnexus/\n');
        await fs.writeFile(path.join(main, SWIFT_PATH), SWIFT_SOURCE);
        await fs.writeFile(path.join(main, 'checks/__init__.py'), '');
        await fs.writeFile(path.join(main, TEST_PATH), 'def fixture_number():\n    return 7\n');
        await fs.writeFile(
          path.join(main, IMPORTER_PATH),
          'from checks.test_numbers import fixture_number\n\ndef run_checks():\n    return fixture_number()\n',
        );
        // Keep the two-file write set below the 50-file / 50% escalation gate.
        for (let i = 0; i < 55; i++) {
          await fs.writeFile(
            path.join(main, `retained/value_${i}.py`),
            `def retained_value_${i}():\n    return ${i}\n`,
          );
        }
        initGitRepo(main);
        git(main, 'config', 'commit.gpgsign', 'false');
        commitAll(main, 'baseline mixed-language fixture');
        git(main, 'worktree', 'add', '-q', '-b', 'lookup-refresh', worktree);
        expect((await fs.stat(path.join(worktree, '.git'))).isFile()).toBe(true);
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'HEAD'));

        const { storagePath, lbugPath } = getStoragePaths(worktree);
        expect(storagePath).toBe(path.join(worktree, '.gitnexus'));
        const baseline = await runFullAnalysis(worktree, options, callbacks);
        const baselineMeta = await loadMeta(storagePath);
        expect(baselineMeta?.runnerIdentity).toBeDefined();
        const swiftFunctions = [...baseline.pipelineResult.graph.iterNodes()].filter(
          (node) => node.label === 'Function' && node.properties.filePath === SWIFT_PATH,
        );
        function symbol(name: string): SymbolRef {
          const matches = swiftFunctions.filter((node) => node.properties.name === name);
          expect(matches, name).toHaveLength(1);
          return { uid: matches[0].id, name, filePath: SWIFT_PATH };
        }
        const target = symbol(TARGET_NAME);
        const callers = CALLER_NAMES.map(symbol);
        expect(new Set(callers.map(({ uid }) => uid)).size).toBe(2);

        // runFullAnalysis is imported from source. Use the same source build
        // for status so it actually measures content drift instead of stopping
        // at a source/dist runner-identity mismatch. Context may use either.
        const statusPrefix = [
          '--import',
          tsxLoaderUrl(),
          fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url)),
        ];
        const readStatus = (): StatusResult =>
          runCli<StatusResult>(worktree, ['status', '--json'], statusPrefix);
        const expectCurrentStatus = (): void => {
          const status = readStatus();
          expect(status.repository).toBe(worktree);
          expect(status.index.runnerIdentityStatus).toBe('current');
          expect(status.contentDrift.status).toBe('current');
          expect(status.contentDrift.coveredFiles).toBeGreaterThan(50);
          expect(status.index.incompleteReasons).toEqual([]);
          expect(status.status).toBe('up-to-date');
        };
        const readPublicContexts = async (): Promise<void> => {
          // CLI and MCP own separate native readers, released before writes.
          expectContext(runCli(worktree, ['context', TARGET_NAME]), target, callers);
          expectContext(runCli(worktree, ['context', '--uid', target.uid]), target, callers);
          backend = new LocalBackend();
          try {
            expect(await backend.init()).toBe(true);
            for (let repeat = 0; repeat < 2; repeat++) {
              expectContext(
                await backend.callTool('context', { name: TARGET_NAME }),
                target,
                callers,
              );
              expectContext(
                await backend.callTool('context', { uid: target.uid }),
                target,
                callers,
              );
            }
          } finally {
            await backend.dispose();
            backend = undefined;
          }
        };
        const readPropertyFts = async (): Promise<unknown[]> => {
          await adapter.initLbug(lbugPath);
          try {
            const rows = await adapter.executeQuery(
              `CALL QUERY_FTS_INDEX('Property', 'property_fts', '${PROPERTY_NAME}')
               RETURN node.id AS uid, node.name AS name, node.filePath AS filePath`,
            );
            expect(rows).toEqual([
              { uid: expect.any(String), name: PROPERTY_NAME, filePath: SWIFT_PATH },
            ]);
            return rows;
          } finally {
            await adapter.closeLbug();
          }
        };

        await readPublicContexts();
        expectCurrentStatus();
        const propertyBefore = await readPropertyFts();

        await fs.writeFile(path.join(worktree, TEST_PATH), 'def fixture_number():\n    return 8\n');
        expect(git(worktree, 'diff', '--name-only')).toBe(TEST_PATH);
        const dirtyStatus = readStatus();
        expect(dirtyStatus.contentDrift.status).toBe('drifted');
        expect(dirtyStatus.index.incompleteReasons).toEqual([]);

        // A call-through spy observes the exact native deletion boundary; it
        // neither supplies graph rows nor substitutes for the incremental write.
        const deleteNodes = vi.spyOn(adapter, 'deleteNodesForFiles');
        const refreshed = await runFullAnalysis(worktree, options, callbacks);
        expect(refreshed.incrementalStats).toMatchObject({
          changedFiles: 1,
          writeMode: 'incremental',
        });
        expect(refreshed.incrementalStats?.affectedDependents).toBeGreaterThan(0);
        expect(deleteNodes).toHaveBeenCalledTimes(1);
        const writePaths = [...deleteNodes.mock.calls[0][0]].sort();
        // Effective write-set expansion also refreshes the containing Folder
        // row through graph edges; no other source file enters the write set.
        expect(writePaths).toEqual(['checks', TEST_PATH, IMPORTER_PATH].sort());
        expect(writePaths.filter((filePath) => filePath.endsWith('.py'))).toEqual(
          [TEST_PATH, IMPORTER_PATH].sort(),
        );
        expect(writePaths).not.toContain(SWIFT_PATH);
        expect((await loadMeta(storagePath))?.runnerIdentity).toEqual(baselineMeta?.runnerIdentity);
        expect(await fs.readFile(path.join(worktree, SWIFT_PATH), 'utf8')).toBe(SWIFT_SOURCE);
        await readPublicContexts();
        expectCurrentStatus();
        expect(await readPropertyFts()).toEqual(propertyBefore);

        deleteNodes.mockClear();
        const noop = await runFullAnalysis(worktree, options, callbacks);
        // The edit remains uncommitted, so clean-porcelain early return is
        // unavailable. Identical content instead takes a zero-file refresh.
        expect(noop.incrementalStats).toMatchObject({
          changedFiles: 0,
          affectedDependents: 0,
          deletedFiles: 0,
          writeMode: 'incremental',
        });
        expect(deleteNodes.mock.calls.flatMap(([filePaths]) => filePaths)).toEqual([]);
        expect((await loadMeta(storagePath))?.runnerIdentity).toEqual(baselineMeta?.runnerIdentity);
        await readPublicContexts();
        expectCurrentStatus();
        expect(await readPropertyFts()).toEqual(propertyBefore);
      } finally {
        await backend?.dispose();
        await adapter.closeLbug();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await temp.cleanup();
      }
    }, 180_000);
  },
);
