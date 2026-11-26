import { createTestEnvironment } from '../support/environment.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitNexusPlugin } from '../../../../hooks/opencode/gitnexus-plugin.js';
const environment = createTestEnvironment();

const exec = promisify(execFile);
it('checks commits, index and working tree from a nested OpenCode directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-opencode-stale-'));
  const repo = path.join(temp, 'repo');
  const nested = path.join(repo, 'nested', 'deep');
  const git = (...args: string[]) => exec('git', args, { cwd: repo });
  const source = '[old] source.ts';
  try {
    await fs.mkdir(nested, { recursive: true });
    await git('init', '--quiet');
    await git('config', 'user.name', 'fixture');
    await git('config', 'user.email', 'test@example.org');
    await git('config', 'diff.relative', 'true');
    await fs.writeFile(path.join(repo, source), 'export const x = 1;\n');
    await fs.writeFile(path.join(repo, 'README.md'), '# Original\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    const base = (await git('rev-parse', 'HEAD')).stdout.trim();
    const fakeCli = path.join(temp, 'status.cjs');
    const statusPath = path.join(temp, 'status.json');
    await fs.writeFile(
      fakeCli,
      `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(statusPath)}));`,
    );
    environment.set('GITNEXUS_HOOK_CLI_PATH', fakeCli);
    const hooks = await GitNexusPlugin({ directory: nested });
    async function showsHint() {
      const head = (await git('rev-parse', 'HEAD')).stdout.trim();
      await fs.writeFile(
        statusPath,
        JSON.stringify({
          status: 'stale',
          index: { commit: base, runnerIdentityStatus: 'current', incompleteReasons: [] },
          current: { commit: head },
        }),
      );
      const result = { output: 'committed' };
      await hooks['tool.execute.after']({ tool: 'bash', args: { command: 'git commit' } }, result);
      return result.output.includes('index is stale');
    }

    await git('commit', '--allow-empty', '-qm', 'empty');
    assert.equal(await showsHint(), false, 'empty commit');
    await fs.writeFile(path.join(repo, 'README.md'), '# New heading\n');
    await git('commit', '-qam', 'documentation');
    assert.equal(await showsHint(), false, 'committed Markdown');

    await fs.writeFile(path.join(repo, 'notes.MDX'), '# New staged doc\n');
    await git('add', 'notes.MDX');
    await fs.writeFile(path.join(repo, 'README.md'), '# Unstaged doc\n');
    await fs.writeFile(path.join(nested, 'new.MARKDOWN'), '# Untracked doc\n');
    assert.equal(await showsHint(), false, 'only staged, unstaged and untracked docs');

    await fs.writeFile(path.join(repo, source), 'export const x = 2;\n');
    assert.equal(await showsHint(), true, 'unstaged code outside cwd');
    await git('--literal-pathspecs', 'add', '--', source);
    assert.equal(await showsHint(), true, 'staged code outside cwd');
    await git('--literal-pathspecs', 'restore', '--staged', '--worktree', '--', source);

    environment.set('GIT_LITERAL_PATHSPECS', '1');
    const newSource = path.join(
      repo,
      process.platform === 'win32' ? 'new [file].ts' : 'new\n[file].ts',
    );
    await fs.writeFile(newSource, 'export const y = 1;\n');
    assert.equal(await showsHint(), true, 'untracked code outside cwd');
    await fs.unlink(newSource);
    await git('--literal-pathspecs', 'mv', '--', source, 'renamed.md');
    assert.equal(await showsHint(), true, 'code renamed to Markdown');
    await git('commit', '-qm', 'rename code');
    assert.equal(await showsHint(), true, 'committed code deletion outside cwd');
  } finally {
    environment.restore();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
