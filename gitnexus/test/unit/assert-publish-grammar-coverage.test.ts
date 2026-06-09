import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
const { findCoverageProblems, filesShipsVendorSource } = requireCjs(SCRIPT);

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

describe('real repo publish-safety (guards against premature files narrowing)', () => {
  it('the script exits 0 against the committed repo state', () => {
    // Deterministic: reads package.json + walks vendor/ — no npm pack, fast.
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[publish-guard] OK');
  });
});
