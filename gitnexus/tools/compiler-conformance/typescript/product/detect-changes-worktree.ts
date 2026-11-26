import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { expect } from 'expect';
import { LocalBackend, resolveWorktreeCwd } from '../../../../src/mcp/local/local-backend.js';
import { getCanonicalRepoRoot } from '../../../../src/storage/git.js';
import { registerRepo, saveMeta } from '../../../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../../../../test/helpers/temp-git-repo.js';
import { isolateAnalysisHome } from '../support/analysis-home.js';
import { withTestLbugDB } from '../support/indexed-db.js';

await isolateAnalysisHome();

function checkout(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-worktree-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  mkdirSync(main);
  initGitRepo(main);
  writeFileSync(path.join(main, 'main.ts'), 'export const value = 1;\n');
  commitAll(main, 'initial');
  function linked(name: string) {
    const directory = path.join(root, name);
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', directory], { cwd: main });
    return directory;
  }
  return { root, main, linked };
}

withTestLbugDB(
  'detect-changes-worktree',
  (handle) => {
    async function registeredCheckout(t: TestContext, name: string) {
      const repo = checkout(t);
      const storagePath = handle.tmpHandle.dbPath;
      const lastCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo.main,
        encoding: 'utf8',
      }).trim();
      const meta = {
        repoPath: repo.main,
        storagePath,
        lastCommit,
        indexedAt: new Date().toISOString(),
      };
      await saveMeta(storagePath, meta);
      await registerRepo(repo.main, meta, { name, storagePath });
      const backend = new LocalBackend();
      t.after(() => backend.dispose());
      await backend.init();
      return {
        ...repo,
        detect: (worktree?: string) =>
          backend.callTool('detect_changes', { scope: 'unstaged', repo: name, worktree }),
      };
    }

    it('reports edits from an explicit or automatically selected linked worktree', async (t) => {
      const repo = await registeredCheckout(t, 'selection');
      const linked = repo.linked('working');
      writeFileSync(path.join(linked, 'main.ts'), 'export const value = 2;\n');
      const originalCwd = process.cwd();
      try {
        process.chdir(repo.main);
        expect(await repo.detect()).toMatchObject({
          summary: { changed_count: 0, risk_level: 'none' },
        });
        const expected = { summary: { changed_files: 1 }, unmapped_files: ['main.ts'] };
        expect(await repo.detect(linked)).toMatchObject(expected);
        process.chdir(linked);
        expect(await repo.detect()).toMatchObject(expected);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('rejects relative and foreign worktrees and reports an unavailable registered root', async (t) => {
      const repo = await registeredCheckout(t, 'validation');
      const foreign = path.join(repo.root, 'foreign');
      execFileSync('git', ['init', '-q', foreign]);
      expect(await repo.detect('relative')).toMatchObject({
        error: expect.stringContaining('worktree must be an absolute path'),
      });
      expect(await repo.detect(foreign)).toMatchObject({
        error: expect.stringContaining('is not a worktree of repo'),
      });
      renameSync(path.join(repo.main, '.git'), path.join(repo.main, 'saved-git'));
      expect(await repo.detect(foreign)).toMatchObject({
        error: expect.stringContaining('Could not determine canonical root for repo'),
      });
    });
  },
  { poolAdapter: true },
);

it('selects the linked worktree when launched from it', (t) => {
  const repo = checkout(t);
  const linked = repo.linked('working');
  expect(realpathSync.native(resolveWorktreeCwd(repo.main, linked))).toBe(
    realpathSync.native(linked),
  );
});

it('keeps a separately indexed worktree when launched from the main checkout', (t) => {
  const repo = checkout(t);
  const linked = repo.linked('indexed');
  const selected = realpathSync.native(resolveWorktreeCwd(linked, repo.main));
  expect(selected).toBe(realpathSync.native(linked));
  expect(selected).not.toBe(realpathSync.native(repo.main));
});

it('keeps the indexed worktree when launched from a sibling worktree', (t) => {
  const repo = checkout(t);
  const indexed = repo.linked('indexed');
  expect(realpathSync.native(resolveWorktreeCwd(indexed, repo.linked('working')))).toBe(
    realpathSync.native(indexed),
  );
});

it('finds the same canonical root for the main checkout and linked worktree', (t) => {
  const repo = checkout(t);
  const canonical = getCanonicalRepoRoot(repo.main);
  expect(canonical).not.toBeNull();
  expect(getCanonicalRepoRoot(repo.linked('working'))).toBe(canonical);
});

for (const staged of [false, true]) {
  it('finds ' + (staged ? 'staged' : 'unstaged') + ' edits only in the linked checkout', (t) => {
    const repo = checkout(t);
    const linked = repo.linked('working');
    writeFileSync(path.join(linked, 'main.ts'), 'export const value = 2;\n');
    if (staged) execFileSync('git', ['add', 'main.ts'], { cwd: linked });
    const args = staged ? ['diff', '--staged', '-U0'] : ['diff', '-U0'];
    expect(execFileSync('git', args, { cwd: repo.main, encoding: 'utf8' }).trim()).toBe('');
    const diff = execFileSync('git', args, { cwd: linked, encoding: 'utf8' });
    expect(diff).toContain('main.ts');
    expect(diff).toContain('+export const value = 2;');
    expect(getCanonicalRepoRoot(linked)).toBe(getCanonicalRepoRoot(repo.main));
  });
}
