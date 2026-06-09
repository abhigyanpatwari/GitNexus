import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Coverage for the publish guard `scripts/assert-publish-grammar-coverage.cjs`.
 *
 * The guard refuses to pack/publish if a vendored grammar would ship with no
 * loadable binding — i.e. a lean-publish `.npmignore` edit dropped a source-build
 * input while a grammar still lacks 6/6 prebuilds. It decides "ships source" by
 * inspecting the EFFECTIVE `npm pack` file list, so a partial exclusion can't slip
 * past. We test the pure decision core directly, and assert the real repo state is
 * publish-safe (catching a premature .npmignore activation in CI, not just at
 * publish time).
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL('../../scripts/assert-publish-grammar-coverage.cjs', import.meta.url),
);
const { findCoverageProblems, prebuiltTuplesInPack } = requireCjs(SCRIPT);

describe('findCoverageProblems (pure decision core)', () => {
  it('passes when source ships, even with incomplete prebuilds (transitional state)', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 0, shipsSource: true }];
    expect(findCoverageProblems({ grammars })).toEqual([]);
  });

  it('fails when source is NOT fully shipped and a grammar lacks 6/6 prebuilds', () => {
    // e.g. a partial .npmignore edit excluded binding.gyp → shipsSource false.
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 4, shipsSource: false }];
    const problems = findCoverageProblems({ grammars });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('tree-sitter-kotlin');
    expect(problems[0]).toContain('source NOT fully shipped');
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

describe('prebuiltTuplesInPack', () => {
  it('counts only tuples whose .node is in the packed set (ignores non-.node / other grammars)', () => {
    const packed = new Set([
      'vendor/tree-sitter-swift/prebuilds/linux-x64/tree-sitter-swift.node',
      'vendor/tree-sitter-swift/prebuilds/darwin-arm64/tree-sitter-swift.node',
      'vendor/tree-sitter-swift/prebuilds/win32-x64/README.md', // not a .node
      'vendor/tree-sitter-c/prebuilds/linux-x64/tree-sitter-c.node', // other grammar
    ]);
    expect(prebuiltTuplesInPack('tree-sitter-swift', packed)).toBe(2);
    expect(prebuiltTuplesInPack('tree-sitter-c', packed)).toBe(1);
  });
});

describe('real repo publish-safety (guards against premature .npmignore activation)', () => {
  it('the script exits 0 against the committed repo state', () => {
    // The guard shells out to `npm pack --dry-run` — allow time for it.
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[publish-guard] OK');
  });
});
