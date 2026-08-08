/**
 * Production-path regression guard for the Ruby import-resolution index (#2880).
 *
 * Ruby's bare `require` leg reads the shared `getWorkspaceFileIndex`
 * (`import-resolvers/workspace-file-index.ts`), memoized on the `allFilePaths`
 * Set identity via a WeakMap. Before #2880 every single `require` materialized
 * two arrays AND built a whole `buildSuffixIndex` over the repo, then threw it
 * away — the most expensive of the four resolvers hoisted.
 *
 * Resolution reaches that index through `rubyScopeResolver.resolveImportTarget`
 * — the orchestrator adapter — not by calling `resolveRubyImportTarget`
 * directly the way the unit parity test does. The adapter must therefore pass
 * the Set THROUGH; a defensive copy (`new Set(allFilePaths)`) would hand a
 * fresh WeakMap key per call and restore the per-require rebuild. Python hit
 * exactly that (PR #1918 review P1), and the parity test cannot see it: it
 * never crosses the adapter.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every Ruby IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { rubyScopeResolver } from '../../src/core/ingestion/languages/ruby/scope-resolver.js';
import { CountingSet } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = rubyScopeResolver;

const FROM_FILE = 'lib/main.rb';

/**
 * A synthetic Ruby app: many service files plus the two requires below —
 * `app/models/user` (a multi-segment suffix hit) and `util` (a single-segment
 * one). `index.rb` covers the `require_relative` directory form.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`lib/app/services/service${String(i).padStart(5, '0')}.rb`);
  }
  files.push('lib/app/models/user.rb');
  files.push('lib/util.rb');
  files.push('lib/support/index.rb');
  files.push('lib/main.rb');
  return new CountingSet(files);
}

describe('Ruby import resolution — index reuse across requires (#2880)', () => {
  it('builds the workspace index once for many requires over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A resolvable bare require, and a gem-shaped one that misses. The miss
      // is the expensive case: it walks every suffix × every extension before
      // returning null, and used to rebuild the suffix index first.
      resolved.push(resolveImportTarget('app/models/user', FROM_FILE, files));
      resolved.push(resolveImportTarget(`gem${i}/missing`, FROM_FILE, files));
    }

    expect(files.scans).toBe(1);

    // Paired result assertion — a count of 1 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('lib/app/models/user.rb');
    expect(resolved[1]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    const a = buildWorkspace(20);
    const b = buildWorkspace(20);

    for (let i = 0; i < 20; i++) {
      expect(resolveImportTarget('app/models/user', FROM_FILE, a)).toBe('lib/app/models/user.rb');
      expect(resolveImportTarget('app/models/user', FROM_FILE, b)).toBe('lib/app/models/user.rb');
    }

    expect(a.scans).toBe(1);
    expect(b.scans).toBe(1);
  });

  it('still resolves real requires correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // Bare `require`: multi-segment and single-segment suffix matches.
    expect(resolveImportTarget('app/models/user', FROM_FILE, files)).toBe('lib/app/models/user.rb');
    expect(resolveImportTarget('util', FROM_FILE, files)).toBe('lib/util.rb');

    // `require_relative`: resolved against the importer's directory, `.rb`
    // first and then `<dir>/index.rb`. This leg answers from `Set.has` and
    // never touches the index, which is why the counting arm drives bare
    // requires instead.
    expect(resolveImportTarget('./util', FROM_FILE, files)).toBe('lib/util.rb');
    expect(resolveImportTarget('./support', FROM_FILE, files)).toBe('lib/support/index.rb');
    expect(resolveImportTarget('../models/user', 'lib/app/services/service00000.rb', files)).toBe(
      'lib/app/models/user.rb',
    );

    // Gems with no matching file in the repo resolve to nothing.
    expect(resolveImportTarget('net/http', FROM_FILE, files)).toBeNull();
  });
});
