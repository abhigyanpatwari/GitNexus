import { describe, it, expect } from 'vitest';
import { resolveGitNamespace, buildNamespaceHint } from '../../src/core/ingestion/git-namespace-detector.js';
import type { GitNamespaceMap } from '../../src/core/ingestion/git-namespace-detector.js';

/**
 * Mock namespace map simulating:
 *   root-repo/           ← .git (root)
 *   ├── src/
 *   ├── DOCS/
 *   │   └── RESEARCH/
 *   │       └── poc/
 *   │           └── reference/
 *   │               ├── browser-use/   ← .git (nested)
 *   │               └── GitNexus/      ← .git (nested)
 */
const createMockMap = (): GitNamespaceMap => ({
  boundaries: [
    'DOCS/RESEARCH/poc/reference/GitNexus',
    'DOCS/RESEARCH/poc/reference/browser-use',
    '',  // root fallback
  ],
  namespaces: new Map([
    ['', 'root-repo'],
    ['DOCS/RESEARCH/poc/reference/GitNexus', 'root-repo/DOCS/RESEARCH/poc/reference/GitNexus'],
    ['DOCS/RESEARCH/poc/reference/browser-use', 'root-repo/DOCS/RESEARCH/poc/reference/browser-use'],
  ]),
});

describe('resolveGitNamespace', () => {
  const mockMap = createMockMap();

  it('should resolve file in nested repo to deepest boundary', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/reference/GitNexus/src/core/pipeline.ts', mockMap
    )).toBe('root-repo/DOCS/RESEARCH/poc/reference/GitNexus');
  });

  it('should resolve root file to root namespace', () => {
    expect(resolveGitNamespace('src/main.ts', mockMap)).toBe('root-repo');
  });

  it('should not cross-match sibling boundaries', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/reference/browser-use/agent.py', mockMap
    )).toBe('root-repo/DOCS/RESEARCH/poc/reference/browser-use');
  });

  it('should handle Windows backslash paths', () => {
    expect(resolveGitNamespace(
      'DOCS\\RESEARCH\\poc\\reference\\GitNexus\\src\\main.ts', mockMap
    )).toBe('root-repo/DOCS/RESEARCH/poc/reference/GitNexus');
  });

  it('should resolve file in DOCS but outside nested repos to root', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/readme.md', mockMap
    )).toBe('root-repo');
  });

  it('should resolve boundary directory itself', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/reference/GitNexus', mockMap
    )).toBe('root-repo/DOCS/RESEARCH/poc/reference/GitNexus');
  });

  it('should not match partial boundary names (e.g. "browser-used" vs "browser-use")', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/reference/browser-used/file.ts', mockMap
    )).toBe('root-repo'); // "browser-used" ≠ "browser-use", falls to root
  });

  it('should handle deeply nested file inside nested repo', () => {
    expect(resolveGitNamespace(
      'DOCS/RESEARCH/poc/reference/GitNexus/src/core/lbug/schema.ts', mockMap
    )).toBe('root-repo/DOCS/RESEARCH/poc/reference/GitNexus');
  });

  it('should handle root-level files without any directory', () => {
    expect(resolveGitNamespace('README.md', mockMap)).toBe('root-repo');
  });

  it('should handle single-boundary map (root only)', () => {
    const rootOnlyMap: GitNamespaceMap = {
      boundaries: [''],
      namespaces: new Map([['', 'myrepo']]),
    };
    expect(resolveGitNamespace('src/index.ts', rootOnlyMap)).toBe('myrepo');
  });
});

describe('resolveGitNamespace — triple nesting', () => {
  it('should pick the deepest boundary in 3-level nesting', () => {
    const tripleMap: GitNamespaceMap = {
      boundaries: [
        'repos/outer/inner',   // deepest
        'repos/outer',         // middle
        '',                    // root
      ],
      namespaces: new Map([
        ['', 'root'],
        ['repos/outer', 'root/repos/outer'],
        ['repos/outer/inner', 'root/repos/outer/inner'],
      ]),
    };

    expect(resolveGitNamespace('repos/outer/inner/lib/util.ts', tripleMap))
      .toBe('root/repos/outer/inner');

    expect(resolveGitNamespace('repos/outer/main.ts', tripleMap))
      .toBe('root/repos/outer');

    expect(resolveGitNamespace('repos/other.ts', tripleMap))
      .toBe('root');
  });
});

describe('buildNamespaceHint', () => {
  const mockMap = createMockMap();

  it('should return null when all results from same namespace', () => {
    const results = [
      { git_namespace: 'root-repo' },
      { git_namespace: 'root-repo' },
      { git_namespace: 'root-repo' },
    ];
    expect(buildNamespaceHint(results, mockMap)).toBeNull();
  });

  it('should return hint when results span multiple namespaces', () => {
    const results = [
      { git_namespace: 'root-repo' },
      { git_namespace: 'root-repo/DOCS/RESEARCH/poc/reference/GitNexus' },
      { git_namespace: 'root-repo' },
    ];
    const hint = buildNamespaceHint(results, mockMap);
    expect(hint).not.toBeNull();
    expect(hint!.warning).toContain('2 git-namespaces');
    expect(hint!.results_by_namespace['root-repo']).toBe(2);
    expect(hint!.results_by_namespace['root-repo/DOCS/RESEARCH/poc/reference/GitNexus']).toBe(1);
  });

  it('should list all available namespaces with correct types', () => {
    const results = [
      { git_namespace: 'root-repo' },
      { git_namespace: 'root-repo/DOCS/RESEARCH/poc/reference/browser-use' },
    ];
    const hint = buildNamespaceHint(results, mockMap)!;
    expect(hint.available_namespaces).toHaveLength(3); // root + 2 nested
    const root = hint.available_namespaces.find(ns => ns.name === 'root-repo');
    expect(root!.type).toBe('root');
    const nested = hint.available_namespaces.find(ns => ns.name.includes('GitNexus'));
    expect(nested!.type).toBe('nested');
  });

  it('should return null for empty results', () => {
    expect(buildNamespaceHint([], mockMap)).toBeNull();
  });

  it('should return null for single result', () => {
    const results = [{ git_namespace: 'root-repo' }];
    expect(buildNamespaceHint(results, mockMap)).toBeNull();
  });

  it('should count results correctly across 3 namespaces', () => {
    const results = [
      { git_namespace: 'root-repo' },
      { git_namespace: 'root-repo/DOCS/RESEARCH/poc/reference/GitNexus' },
      { git_namespace: 'root-repo/DOCS/RESEARCH/poc/reference/browser-use' },
      { git_namespace: 'root-repo/DOCS/RESEARCH/poc/reference/GitNexus' },
    ];
    const hint = buildNamespaceHint(results, mockMap)!;
    expect(hint.warning).toContain('3 git-namespaces');
    expect(hint.results_by_namespace['root-repo']).toBe(1);
    expect(hint.results_by_namespace['root-repo/DOCS/RESEARCH/poc/reference/GitNexus']).toBe(2);
    expect(hint.results_by_namespace['root-repo/DOCS/RESEARCH/poc/reference/browser-use']).toBe(1);
  });
});
