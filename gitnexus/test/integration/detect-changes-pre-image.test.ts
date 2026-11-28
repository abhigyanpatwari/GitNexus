/**
 * `detect_changes` when the index holds the PRE-image of a modified file (#4136).
 *
 * The documented flow is analyze, edit, then `detect_changes` before commit, so
 * the graph's line ranges come from the bytes `analyze` read, not from the edited
 * file. Mapping the diff's post-image (`+`) ranges onto those symbols lands every
 * hunk after an inserted or removed line on the wrong symbol, and a deleted
 * function is never reported. `meta.fileHashes` records the SHA-256 of the exact
 * bytes analyzed, so the backend can tell which image the graph holds and map
 * the matching side of each hunk.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'fs';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const tempDirs = createTempDirPool('gnx-preimage-');

/** The minimal case from #4136, one function per line. */
const UTIL = [
  'export function first() { return 0; }',
  'export function helper() { return 1; }',
  'export function second() { return 2; }',
  'export function third() { return helper(3); }',
  'export function fourth() { return 4; }',
  '',
].join('\n');

const NAMES = ['first', 'helper', 'second', 'third', 'fourth'];

/** The graph `analyze` would hold for UTIL: 0-based, one line per function. */
const SEED = NAMES.map(
  (name, line) =>
    `CREATE (fn:Function {id: 'Function:util.ts:${name}', name: '${name}', filePath: 'util.ts', startLine: ${line}, endLine: ${line}, isExported: true})`,
);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type DetectChangesResult = {
  error?: unknown;
  summary: { changed_count: number; risk_level: string };
  changed_symbols: { name: string }[];
  partial?: boolean;
};

withTestLbugDB(
  'detect-changes-pre-image',
  (handle) => {
    let backend: LocalBackend;
    let repoDir: string;

    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend; _repoDir?: string };
      if (!ext._backend || !ext._repoDir) throw new Error('afterSetup did not run');
      backend = ext._backend;
      repoDir = ext._repoDir;
    });

    /** Reset util.ts to the analyzed bytes, apply `edit`, and run the gate. */
    async function changedNames(edit: (lines: string[]) => string[], scope = 'unstaged') {
      execFileSync('git', ['checkout', '-q', 'HEAD', '--', 'util.ts'], { cwd: repoDir });
      writeFileSync(path.join(repoDir, 'util.ts'), edit(UTIL.split('\n')).join('\n'));
      if (scope === 'staged') execFileSync('git', ['add', 'util.ts'], { cwd: repoDir });
      const result = (await backend.callTool('detect_changes', { scope })) as DetectChangesResult;
      if (scope === 'staged') execFileSync('git', ['reset', '-q'], { cwd: repoDir });
      expect(result.error).toBeUndefined();
      return result.changed_symbols.map((s) => s.name).sort();
    }

    it('maps an edit below inserted lines onto the edited symbol', async () => {
      const names = await changedNames((lines) => [
        '// a',
        '// b',
        '// c',
        ...lines.map((l) => l.replace('helper(3)', 'helper(33)')),
      ]);
      expect(names).toEqual(['third']);
    });

    it('reports a deleted function, not its neighbour', async () => {
      expect(await changedNames((lines) => lines.filter((l) => !l.includes('helper()')))).toEqual([
        'helper',
      ]);
    });

    it('reports a deleted last function, not the one above it', async () => {
      expect(await changedNames((lines) => lines.filter((l) => !l.includes('fourth')))).toEqual([
        'fourth',
      ]);
    });

    it('maps staged changes the same way', async () => {
      expect(
        await changedNames((lines) => lines.filter((l) => !l.includes('helper()')), 'staged'),
      ).toEqual(['helper']);
    });

    it('does not claim either neighbour of a line inserted between two symbols', async () => {
      // In the pre-image the insertion is a gap between `second` and `third`:
      // it changes neither symbol's text.
      expect(
        await changedNames((lines) => [...lines.slice(0, 3), '// new', ...lines.slice(3)]),
      ).toEqual([]);
    });

    // Last: it commits, so HEAD no longer holds the analyzed bytes afterwards.
    it('withholds a ranked verdict when the index holds neither side', async () => {
      // analyze, commit an edit, edit again and stage: the staged diff's old
      // side is the commit, its new side the index, and the graph neither.
      // Dropping `first` shifts `third` onto the line the graph has for
      // `second`, so either side's ranges would name a wrong, real symbol.
      const committed = UTIL.split('\n').filter((l) => !l.includes('first'));
      writeFileSync(path.join(repoDir, 'util.ts'), committed.join('\n'));
      execFileSync('git', ['commit', '-qam', 'drop first'], { cwd: repoDir });
      writeFileSync(
        path.join(repoDir, 'util.ts'),
        committed.map((l) => l.replace('helper(3)', 'helper(33)')).join('\n'),
      );
      execFileSync('git', ['add', 'util.ts'], { cwd: repoDir });
      const result = (await backend.callTool('detect_changes', {
        scope: 'staged',
      })) as DetectChangesResult;
      expect(result.error).toBeUndefined();
      expect(result.partial).toBe(true);
      expect(result.summary.risk_level).toBe('unknown');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = tempDirs.dir();
      writeFileSync(path.join(repoDir, 'util.ts'), UTIL);
      initGitRepo(repoDir);
      // The recorded hash is of LF UTIL; keep checkouts LF on autocrlf hosts.
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoDir });
      commitAll(repoDir, 'init');
      // What `analyze` records: the SHA-256 of the exact bytes it indexed.
      writeFileSync(
        path.join(handle.tmpHandle.dbPath, INDEX_METADATA_FILE),
        JSON.stringify({ fileHashes: { 'util.ts': sha256(UTIL) } }),
      );
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'preimage-repo',
          path: repoDir,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc1234',
          stats: { files: 1, nodes: NAMES.length, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      const ext = handle as typeof handle & { _backend?: LocalBackend; _repoDir?: string };
      ext._backend = backend;
      ext._repoDir = repoDir;
    },
  },
);
