import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Coverage for the publish guard `scripts/assert-publish-grammar-coverage.cjs`.
 *
 * The guard refuses to pack/publish if a vendored grammar would ship with no
 * loadable binding — i.e. the lean-publish source exclusion was activated in
 * .npmignore while a grammar still lacks 6/6 prebuilds. We test the pure decision
 * core directly, and assert the real repo state is publish-safe (this catches a
 * premature .npmignore activation in CI, not just at publish time).
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL('../../scripts/assert-publish-grammar-coverage.cjs', import.meta.url),
);
const { findCoverageProblems, activeIgnorePatterns, SOURCE_EXCLUSION_TOGGLE } = requireCjs(SCRIPT);

describe('findCoverageProblems (pure decision core)', () => {
  it('passes when source ships, even with incomplete prebuilds (transitional state)', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 0, hasSource: true }];
    expect(findCoverageProblems({ grammars, sourceExcluded: false })).toEqual([]);
  });

  it('fails when source is excluded but a grammar lacks 6/6 prebuilds', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 4, hasSource: true }];
    const problems = findCoverageProblems({ grammars, sourceExcluded: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('tree-sitter-kotlin');
    expect(problems[0]).toContain('EXCLUDED');
    expect(problems[0]).toContain('2 platform-arch tuple(s)');
  });

  it('passes when source is excluded but every grammar has all 6 prebuilds', () => {
    const grammars = [
      { name: 'tree-sitter-swift', prebuilt: 6, hasSource: true },
      { name: 'tree-sitter-c', prebuilt: 6, hasSource: false },
    ];
    expect(findCoverageProblems({ grammars, sourceExcluded: true })).toEqual([]);
  });

  it('fails when a grammar has neither prebuilds nor source', () => {
    const grammars = [{ name: 'tree-sitter-x', prebuilt: 0, hasSource: false }];
    const problems = findCoverageProblems({ grammars, sourceExcluded: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('absent');
  });
});

describe('activeIgnorePatterns', () => {
  it('ignores comments/blank lines and trims', () => {
    const txt = ['# a comment', '', '  vendor/**/build  ', '# vendor/**/src/parser.c'].join('\n');
    const active = activeIgnorePatterns(txt);
    expect(active).toContain('vendor/**/build');
    expect(active).not.toContain(SOURCE_EXCLUSION_TOGGLE); // commented out → inert
  });
});

describe('real repo publish-safety (guards against premature .npmignore activation)', () => {
  it('the script exits 0 against the committed repo state', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[publish-guard] OK');
  });
});
