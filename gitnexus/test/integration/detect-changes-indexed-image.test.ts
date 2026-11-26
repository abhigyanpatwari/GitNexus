/**
 * `detect_changes` maps hunks in the line space of the bytes the index holds.
 *
 * Graph `startLine`/`endLine` come from the bytes `analyze` read. In the
 * documented flow (analyze, edit, detect_changes before commit) those are the
 * PRE-image, but hunks used to be read from the `+` side only. Once an edit
 * added or removed lines, later hunks landed on the wrong symbols: an edit
 * below inserted lines reported the functions above it, and a deleted function
 * was never reported — the hunk anchored on its neighbour, so the pre-commit
 * gate ranked a deletion with callers as low risk.
 *
 * `meta.fileHashes` records the SHA-256 of the exact indexed bytes, so each
 * file's side is picked by hash. Runs against a real engine because the
 * engine-side `[lo, hi]` bound must admit the pre-image rows too.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
  // The real reader: these tests write the metadata file `fileHashes` lives in.
  loadMeta: (await importOriginal<typeof import('../../src/storage/repo-manager.js')>()).loadMeta,
}));

const tempDirs = createTempDirPool('gnx-indexed-image-');

/** The issue's file, one function per line. */
const UTIL = [
  'export function first() { return 0; }',
  'export function helper() { return 1; }',
  'export function second() { return 2; }',
  'export function third() { return helper(3); }',
  'export function fourth() { return 4; }',
  '',
].join('\n');

/** A multi-line function, for insertions that land inside or beside it. */
const BODY = [
  'export function outer() {',
  '  const a = 1;',
  '  return a;',
  '}',
  'export function after() { return 0; }',
  '',
].join('\n');

const fn = (file: string, name: string, start: number, end: number) =>
  `CREATE (fn:Function {id: 'Function:${file}:${name}', name: '${name}', filePath: '${file}', startLine: ${start}, endLine: ${end}, isExported: true})`;

/** Graph rows for the committed (pre-image) files, 0-based like the pipeline. */
const SEED = [
  fn('util.ts', 'first', 0, 0),
  fn('util.ts', 'helper', 1, 1),
  fn('util.ts', 'second', 2, 2),
  fn('util.ts', 'third', 3, 3),
  fn('util.ts', 'fourth', 4, 4),
  fn('body.ts', 'outer', 0, 3),
  fn('body.ts', 'after', 4, 4),
];

type DetectChangesResult = {
  error?: unknown;
  summary: { changed_count: number; risk_level: string };
  changed_symbols: { name: string; filePath: string }[];
  partial?: boolean;
  unmapped_files?: string[];
  unverified_line_files?: string[];
};

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

withTestLbugDB(
  'detect-changes-indexed-image',
  (handle) => {
    let backend: LocalBackend;
    let repoDir: string;
    let storagePath: string;
    let indexedHashes: Record<string, string>;

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
    const write = (file: string, text: string) => writeFileSync(path.join(repoDir, file), text);
    const writeMeta = (fileHashes?: Record<string, string>) =>
      writeFileSync(
        path.join(storagePath, INDEX_METADATA_FILE),
        JSON.stringify({
          repoPath: repoDir,
          lastCommit: git('rev-parse', 'HEAD').trim(),
          indexedAt: new Date().toISOString(),
          ...(fileHashes && { fileHashes }),
        }),
      );
    const detect = async (scope = 'unstaged') => {
      const result = (await backend.callTool('detect_changes', { scope })) as DetectChangesResult;
      expect(result.error).toBeUndefined();
      return result;
    };
    const names = (result: DetectChangesResult) => result.changed_symbols.map((s) => s.name);

    beforeAll(() => {
      const ext = handle as typeof handle & {
        _backend?: LocalBackend;
        _repoDir?: string;
      };
      if (!ext._backend || !ext._repoDir) throw new Error('afterSetup did not run');
      backend = ext._backend;
      repoDir = ext._repoDir;
      storagePath = handle.tmpHandle.dbPath;
      // What `analyze` recorded: the committed bytes it read.
      indexedHashes = {
        'util.ts': sha256(readFileSync(path.join(repoDir, 'util.ts'))),
        'body.ts': sha256(readFileSync(path.join(repoDir, 'body.ts'))),
      };
    });

    afterEach(() => {
      git('reset', '-q', '--hard', 'HEAD');
      writeMeta(indexedHashes);
    });

    it('reports the edited function below inserted lines, not the ones above it', async () => {
      writeMeta(indexedHashes);
      write('util.ts', `// a\n// b\n// c\n${UTIL.replace('helper(3)', 'helper(33)')}`);
      const result = await detect();
      expect(names(result)).toEqual(['third']);
      expect(result.partial).toBeUndefined();
    });

    it('reports a deleted function instead of its neighbour', async () => {
      writeMeta(indexedHashes);
      write('util.ts', UTIL.replace(/^.*helper\(\) .*\n/m, ''));
      expect(names(await detect())).toEqual(['helper']);
    });

    it('reports a deleted last function', async () => {
      writeMeta(indexedHashes);
      write('util.ts', UTIL.replace(/^.*fourth.*\n/m, ''));
      expect(names(await detect())).toEqual(['fourth']);
    });

    it.each(['staged', 'all'])('uses the pre-image for scope %s too', async (scope) => {
      writeMeta(indexedHashes);
      write('util.ts', UTIL.replace(/^.*helper\(\) .*\n/m, ''));
      git('add', 'util.ts');
      expect(names(await detect(scope))).toEqual(['helper']);
    });

    it('touches a function only when lines are inserted inside it', async () => {
      writeMeta(indexedHashes);
      write('body.ts', BODY.replace('  return a;', '  const b = 2;\n  return a;'));
      expect(names(await detect())).toEqual(['outer']);

      git('checkout', '--', 'body.ts');
      // Right after `outer`'s closing brace: neither function changed.
      write('body.ts', BODY.replace('}\n', '}\n// note\n'));
      const between = await detect();
      expect(names(between)).toEqual([]);
      expect(between.unmapped_files).toEqual(['body.ts']);
    });

    it('keeps the post-image mapping when the index was rebuilt after the edit', async () => {
      const edited = `// a\n// b\n// c\n${UTIL.replace('helper(3)', 'helper(33)')}`;
      write('util.ts', edited);
      writeMeta({ ...indexedHashes, 'util.ts': sha256(edited) });
      // The seeded rows stay pre-image on purpose: the point is which side was
      // read. The `+` side is lines 1-3 and 7, which land on rows 0-2 here; the
      // `-` side (line 4) would have reported `third`.
      const result = await detect();
      expect(names(result)).toEqual(['first', 'helper', 'second']);
      expect(result.unverified_line_files).toBeUndefined();
    });

    it('fails closed when the indexed bytes match neither side', async () => {
      writeMeta({ ...indexedHashes, 'util.ts': sha256('some other content') });
      write('util.ts', UTIL.replace(/^.*helper\(\) .*\n/m, ''));
      const result = await detect();
      expect(result.unverified_line_files).toEqual(['util.ts']);
      expect(result.partial).toBe(true);
      expect(result.summary.risk_level).toBe('unknown');
    });

    it('keeps the legacy post-image mapping for an index without fileHashes', async () => {
      writeMeta(undefined);
      write('util.ts', UTIL.replace(/^.*helper\(\) .*\n/m, ''));
      const result = await detect();
      // Legacy behaviour: the deletion anchors on the post-image line before it.
      expect(names(result)).toEqual(['first']);
      expect(result.unverified_line_files).toBeUndefined();
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = tempDirs.dir();
      initGitRepo(repoDir);
      // The working tree is written by the test; keep git from rewriting it.
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoDir });
      writeFileSync(path.join(repoDir, 'util.ts'), UTIL);
      writeFileSync(path.join(repoDir, 'body.ts'), BODY);
      commitAll(repoDir, 'init');
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'indexed-image-repo',
          path: repoDir,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc1234',
          stats: { files: 2, nodes: SEED.length, edges: 0, communities: 0, processes: 0 },
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
