import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GitNexusPlugin } from '../../hooks/opencode/gitnexus-plugin.js';

const exec = promisify(execFile);
const cli = path.resolve('dist/cli/index.js');

describe('installed OpenCode plugin', () => {
  let home: string;
  let plugin: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-opencode ')));
    plugin = path.join(home, '.config', 'opencode', 'plugins', 'gitnexus.js');
    await fs.mkdir(path.dirname(plugin), { recursive: true });
    await fs.writeFile(path.join(path.dirname(plugin), 'mine.js'), '// user plugin');
    const skills = path.join(home, 'skills');
    await fs.mkdir(skills);
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GITNEXUS_HOME: path.join(home, 'registry'),
      GITNEXUS_TEST_SKILLS_ROOT: skills,
    };
    // Uninstall visits every editor; an inherited override would escape this fixture.
    delete env.CODEX_HOME;
    await exec(process.execPath, [cli, 'setup', '-c', 'opencode'], { env, cwd: home });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("exposes only a plugin initializer to OpenCode's module loader", async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const mod = await import(${JSON.stringify(pathToFileURL(plugin).href)});
      const hooks = [];
      // OpenCode v1's legacy loader invokes every exported function.
      for (const init of new Set(Object.values(mod))) hooks.push(await init({ directory: process.cwd() }));
      console.log(JSON.stringify({ exports: Object.keys(mod), hooks: hooks.map(Object.keys) }));
    `,
      ],
      { env, cwd: home },
    );
    expect(JSON.parse(stdout)).toEqual({
      exports: ['GitNexusPlugin'],
      hooks: [['tool.execute.after']],
    });
  });

  it('runs the CLI outside the host executable, yields to the event loop, and uninstalls surgically', async () => {
    const fakeCli = path.join(home, 'fake cli.cjs');
    const calls = path.join(home, 'calls.jsonl');
    await fs.writeFile(
      fakeCli,
      `
      require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
      setTimeout(() => {
        if (process.argv[2] === 'augment') process.stderr.write('[GitNexus] callers: A');
        else process.stdout.write(JSON.stringify({ status: 'stale', index: { commit: 'abc1234567' } }));
      }, 30);
    `,
    );
    const { stdout } = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const { GitNexusPlugin } = await import(${JSON.stringify(pathToFileURL(plugin).href)});
      // Compiled OpenCode reports its own binary here, not Node or Bun.
      Object.defineProperty(process, 'execPath', { value: '/missing/opencode' });
      const hooks = await GitNexusPlugin({ directory: process.cwd() });
      let responsive = false;
      const timer = setTimeout(() => { responsive = true; }, 0);
      const search = { output: 'hits' };
      await hooks['tool.execute.after']({ tool: 'grep', args: { pattern: 'User Service' } }, search);
      clearTimeout(timer);
      const mutation = { output: 'committed' };
      await hooks['tool.execute.after']({ tool: 'bash', args: { command: 'git commit -m test' } }, mutation);
      console.log(JSON.stringify({ search, mutation, responsive }));
    `,
      ],
      { env: { ...env, GITNEXUS_HOOK_CLI_PATH: fakeCli }, cwd: home },
    );
    expect(JSON.parse(stdout)).toEqual({
      search: { output: 'hits\n\n[GitNexus] callers: A' },
      mutation: {
        output:
          'committed\n\n[GitNexus] GitNexus index is stale (last indexed: abc1234). Run `gitnexus analyze` to update the knowledge graph.',
      },
      responsive: true,
    });
    expect(
      (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { argv: ['augment', '--', 'User Service'], cwd: home },
      { argv: ['status', '--json'], cwd: home },
    ]);
    await exec(process.execPath, [cli, 'uninstall', '--force'], { env, cwd: home });
    await expect(fs.access(plugin)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(path.dirname(plugin), 'mine.js'), 'utf8')).toBe(
      '// user plugin',
    );
  });
});

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
    vi.stubEnv('GITNEXUS_HOOK_CLI_PATH', fakeCli);
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
    expect(await showsHint(), 'empty commit').toBe(false);
    await fs.writeFile(path.join(repo, 'README.md'), '# New heading\n');
    await git('commit', '-qam', 'documentation');
    expect(await showsHint(), 'committed Markdown').toBe(false);

    await fs.writeFile(path.join(repo, 'notes.MDX'), '# New staged doc\n');
    await git('add', 'notes.MDX');
    await fs.writeFile(path.join(repo, 'README.md'), '# Unstaged doc\n');
    await fs.writeFile(path.join(nested, 'new.MARKDOWN'), '# Untracked doc\n');
    expect(await showsHint(), 'only staged, unstaged and untracked docs').toBe(false);

    await fs.writeFile(path.join(repo, source), 'export const x = 2;\n');
    expect(await showsHint(), 'unstaged code outside cwd').toBe(true);
    await git('--literal-pathspecs', 'add', '--', source);
    expect(await showsHint(), 'staged code outside cwd').toBe(true);
    await git('--literal-pathspecs', 'restore', '--staged', '--worktree', '--', source);

    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');
    const newSource = path.join(
      repo,
      process.platform === 'win32' ? 'new [file].ts' : 'new\n[file].ts',
    );
    await fs.writeFile(newSource, 'export const y = 1;\n');
    expect(await showsHint(), 'untracked code outside cwd').toBe(true);
    await fs.unlink(newSource);
    await git('--literal-pathspecs', 'mv', '--', source, 'renamed.md');
    expect(await showsHint(), 'code renamed to Markdown').toBe(true);
    await git('commit', '-qm', 'rename code');
    expect(await showsHint(), 'committed code deletion outside cwd').toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
