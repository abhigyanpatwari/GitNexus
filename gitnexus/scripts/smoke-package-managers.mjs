import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run from gitnexus/ after npm pack. Each manager installs the actual PR tarball
// without lifecycle scripts, reproducing bunx's missing native install copy.
const tarballs = (await readdir('.')).filter((name) => /^gitnexus-.*\.tgz$/.test(name));
assert.equal(tarballs.length, 1, 'Expected one freshly packed gitnexus tarball');
const tarball = path.resolve(tarballs[0]);

function run(program, args, cwd, env) {
  // All shell arguments are fixed literals; the tarball is copied through fs.
  // Windows package-manager entrypoints are .cmd shims.
  const result = spawnSync(program, args, {
    cwd,
    env,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${program} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? ''}\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

for (const manager of ['npm', 'pnpm', 'bun']) {
  const root = await mkdtemp(path.join(os.tmpdir(), `gitnexus-${manager}-smoke-`));
  const env = {
    ...process.env,
    GITNEXUS_HOME: path.join(root, 'home'),
    GITNEXUS_STORAGE_PATH: path.join(root, 'repo', '.gitnexus'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_MEMORY: 'off',
    SCARF_ANALYTICS: 'false',
  };
  try {
    const version = run(manager, ['--version'], root, env).trim();
    await copyFile(tarball, path.join(root, 'gitnexus.tgz'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'gitnexus-manager-smoke',
        version: '1.0.0',
        private: true,
        dependencies: { gitnexus: 'file:./gitnexus.tgz' },
      }),
    );
    run(
      manager,
      ['install', '--ignore-scripts', ...(manager === 'pnpm' ? ['--store-dir=store'] : [])],
      root,
      env,
    );

    const installed = await realpath(path.join(root, 'node_modules', 'gitnexus'));
    const requireInstalled = createRequire(path.join(installed, 'package.json'));
    const binaryPath = path.join(
      path.dirname(requireInstalled.resolve('@ladybugdb/core')),
      'lbugjs.node',
    );
    assert.equal(existsSync(binaryPath), false, `${manager}: fixture must skip native preparation`);
    await mkdir(path.join(root, 'repo'));
    await writeFile(
      path.join(root, 'repo', 'index.ts'),
      'export function greet(name: string) { return `Hello ${name}`; }\n' +
        'export function main() { return greet("GitNexus"); }\n',
    );
    run('git', ['init', '-q', 'repo'], root, env);
    const args = ['gitnexus', 'analyze', 'repo', '--index-only', '--workers', '1'];
    const [program, prefix] =
      manager === 'npm'
        ? ['npx', ['--no-install']]
        : manager === 'pnpm'
          ? ['pnpm', ['exec']]
          : ['bunx', ['--no-install']];
    run(program, [...prefix, ...args], root, env);
    assert.equal(existsSync(binaryPath), true, `${manager}: native binary was not prepared`);
    const metadata = JSON.parse(
      await readFile(path.join(root, 'repo', '.gitnexus', 'gitnexus.json'), 'utf8'),
    );
    assert.equal(metadata.stats.files, 1);
    assert.ok(metadata.stats.nodes >= 4, `${manager}: missing indexed symbols`);
    assert.ok(metadata.stats.edges >= 5, `${manager}: missing graph relationships`);
    assert.ok(
      metadata.runnerIdentity?.dependencyRuntime?.artifactCount > 0,
      `${manager}: missing identity receipt`,
    );
    console.log(
      `PASS ${process.platform}/${process.arch}: ${manager} ${version} installed and indexed the PR tarball`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
