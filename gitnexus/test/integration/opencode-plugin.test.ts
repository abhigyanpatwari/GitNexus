import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

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
