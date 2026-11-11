import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LOADER_SOURCE = 'gitnexus-claude-plugin/hooks/gitnexus-hook.js';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, contents: string | Buffer): void {
  const destination = path.join(root, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-build-'));
  roots.push(root);
  write(root, 'gitnexus/package.json', '{"name":"gitnexus","type":"module"}\n');
  for (const name of ['build.js', 'build-web.js']) {
    write(
      root,
      `gitnexus/scripts/${name}`,
      readFileSync(path.join(REPO_ROOT, 'gitnexus/scripts', name)),
    );
  }
  return root;
}

function build(root: string) {
  return spawnSync(process.execPath, [path.join(root, 'gitnexus/scripts/build.js')], {
    cwd: path.join(root, 'gitnexus'),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, GITNEXUS_BUILD_WEB: '0' },
  });
}

describe('Claude hook launcher packaging', () => {
  it('ordinary builds package only the authored launcher and pick up its next edit automatically', () => {
    const root = fixture();
    mkdirSync(path.join(root, 'gitnexus-shared'));
    const loader = readFileSync(path.join(REPO_ROOT, LOADER_SOURCE));
    write(root, LOADER_SOURCE, loader);
    // These are decoys, not package inputs: the build must select the loader,
    // never copy a plugin tree or introduce another hook implementation.
    write(root, 'gitnexus-claude-plugin/hooks/claude-hook-runtime.cjs', 'decoy runtime');
    write(root, 'gitnexus-claude-plugin/hooks/hook-lock.cjs', 'decoy helper');
    write(
      root,
      'gitnexus/node_modules/typescript/lib/tsc.js',
      `const fs = require('node:fs');
const path = require('node:path');
const relative = path.basename(process.cwd()) === 'gitnexus' ? 'cli/index.js' : 'index.js';
const output = path.join(process.cwd(), 'dist', relative);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, 'export {};\\n');
`,
    );

    const result = build(root);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const dist = path.join(root, 'gitnexus/dist');
    const packaged = path.join(dist, 'cli/claude-hook-launcher.cjs');
    expect(readFileSync(packaged)).toEqual(loader);
    expect(readdirSync(dist).sort()).toEqual(['_shared', 'cli']);
    expect(readdirSync(path.join(dist, 'cli')).sort()).toEqual([
      'claude-hook-launcher.cjs',
      'index.js',
    ]);
    expect(readdirSync(path.join(dist, '_shared'))).toEqual(['index.js']);
    expect(existsSync(path.join(root, 'gitnexus/hooks'))).toBe(false);

    const revised = Buffer.concat([loader, Buffer.from('\n// next launcher revision\n')]);
    write(root, LOADER_SOURCE, revised);
    const rebuilt = build(root);
    expect(rebuilt.error).toBeUndefined();
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(readFileSync(packaged)).toEqual(revised);
  });

  it('installed npm packages skip compilation without a plugin or shared-package sibling', () => {
    const root = fixture();
    const loader = readFileSync(path.join(REPO_ROOT, LOADER_SOURCE));
    const destination = 'gitnexus/dist/cli/claude-hook-launcher.cjs';
    write(root, destination, loader);

    const result = build(root);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('dist/ already present (published package)');
    expect(readFileSync(path.join(root, destination))).toEqual(loader);
    expect(existsSync(path.join(root, 'gitnexus-claude-plugin'))).toBe(false);
    expect(existsSync(path.join(root, 'gitnexus-shared'))).toBe(false);
  });

  it('stages the launcher in the Docker builder before npm ci runs prepare', () => {
    const instructions = readFileSync(path.join(REPO_ROOT, 'Dockerfile.cli'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const copy = instructions.indexOf(`COPY ${LOADER_SOURCE} ./${LOADER_SOURCE}`);
    const install = instructions.indexOf('RUN npm ci --prefix gitnexus');
    const runtimeStage = instructions.findIndex((line) => /^FROM .+ AS runtime$/.test(line));

    expect(copy).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(copy);
    expect(runtimeStage).toBeGreaterThan(install);
  });
});
