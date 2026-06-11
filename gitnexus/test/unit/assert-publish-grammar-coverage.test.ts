import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Coverage for the publish guard `scripts/assert-publish-grammar-coverage.cjs`.
 *
 * The guard refuses to pack/publish if a vendored grammar would ship with no
 * loadable binding — i.e. the package.json `files` field was narrowed to drop the
 * vendored source while a grammar still lacks 6/6 prebuilds. (`.npmignore` can't
 * exclude the vendored subtree — `files` overrides it — so `files` is the only
 * lever, and the guard reads it directly rather than shelling out to `npm pack`.)
 * We test the pure decision core + the `files` check directly, and assert the real
 * repo state is publish-safe (catching a premature narrowing in CI).
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL('../../scripts/assert-publish-grammar-coverage.cjs', import.meta.url),
);
const { findCoverageProblems, filesShipsVendorSource, findStrayBuildArtifacts } =
  requireCjs(SCRIPT);

describe('findCoverageProblems (pure decision core)', () => {
  it('passes when source ships, even with incomplete prebuilds (transitional state)', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 0, shipsSource: true }];
    expect(findCoverageProblems({ grammars })).toEqual([]);
  });

  it('fails when source is not shipped and a grammar lacks 6/6 prebuilds', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 4, shipsSource: false }];
    const problems = findCoverageProblems({ grammars });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('tree-sitter-kotlin');
    expect(problems[0]).toContain('not shipped');
    expect(problems[0]).toContain('2 platform-arch tuple(s)');
  });

  it('passes when source is not shipped but every grammar has all 6 prebuilds', () => {
    const grammars = [
      { name: 'tree-sitter-swift', prebuilt: 6, shipsSource: false },
      { name: 'tree-sitter-c', prebuilt: 6, shipsSource: false },
    ];
    expect(findCoverageProblems({ grammars })).toEqual([]);
  });

  it('fails when a grammar has neither prebuilds nor shipped source', () => {
    const grammars = [{ name: 'tree-sitter-x', prebuilt: 0, shipsSource: false }];
    const problems = findCoverageProblems({ grammars });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no loadable binding');
  });
});

describe('filesShipsVendorSource', () => {
  it('ships when a broad vendor entry is present', () => {
    expect(filesShipsVendorSource(['dist', 'vendor', 'web'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/**'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/*'])).toBe(true);
  });

  it('does NOT ship when files is narrowed to non-source subpaths (lean publish)', () => {
    expect(
      filesShipsVendorSource([
        'dist',
        'vendor/**/prebuilds/**',
        'vendor/**/package.json',
        'vendor/**/bindings/node/index.js',
      ]),
    ).toBe(false);
    expect(filesShipsVendorSource([])).toBe(false);
    expect(filesShipsVendorSource(undefined)).toBe(false);
  });
});

describe('findStrayBuildArtifacts (stray vendor build dirs that would ship + shadow prebuilds)', () => {
  const mkVendor = (): string => mkdtempSync(path.join(tmpdir(), 'vguard-'));

  it('returns [] when no grammar has a build/ dir', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'tree-sitter-y', 'prebuilds', 'linux-x64'), { recursive: true });
      writeFileSync(path.join(dir, 'tree-sitter-y', 'prebuilds', 'linux-x64', 'y.node'), '');
      expect(findStrayBuildArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a grammar that carries a stray build/ output (would shadow the prebuild)', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'tree-sitter-x', 'build', 'Release'), { recursive: true });
      mkdirSync(path.join(dir, 'tree-sitter-y', 'prebuilds'), { recursive: true });
      expect(findStrayBuildArtifacts(dir)).toEqual(['vendor/tree-sitter-x/build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-grammar dirs and a missing vendor dir', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'leiden', 'build'), { recursive: true }); // not tree-sitter-*
      expect(findStrayBuildArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(findStrayBuildArtifacts(path.join(tmpdir(), 'vguard-does-not-exist'))).toEqual([]);
  });
});

describe('real repo publish-safety (guards against premature files narrowing)', () => {
  it('the script exits 0 against the committed repo state', () => {
    // Deterministic: reads package.json + walks vendor/ — no npm pack, fast.
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[publish-guard] OK');
  });
});
