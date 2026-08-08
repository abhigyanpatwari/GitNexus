/**
 * Production-path regression guard for the Dart import-resolution index (#2879).
 *
 * The basename index (`getDartFileIndex` in `languages/dart/import-target.ts`)
 * is memoized on the `allFilePaths` Set identity via a WeakMap. Resolution
 * reaches it through `dartScopeResolver.resolveImportTarget` — the orchestrator
 * adapter — not by calling `resolveDartImportTarget` directly the way the unit
 * parity test does. The adapter must therefore pass the Set THROUGH; a
 * defensive copy (`new Set(allFilePaths)`) would hand a fresh WeakMap key per
 * call and rebuild the index on every import, restoring the O(imports × files)
 * behaviour this replaced. Python hit exactly that (PR #1918 review P1), and
 * the parity test cannot see it: it never crosses the adapter.
 *
 * Dart is the language the benchmark's measured blind spot was quantified on
 * (`bench/import-target/baselines.json` `_blind_spot`), so its adapter is the
 * one with the least timing cover.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every Dart IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { dartScopeResolver } from '../../src/core/ingestion/languages/dart/scope-resolver.js';
import { CountingSet } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = dartScopeResolver;

const FROM_FILE = 'lib/main.dart';

/**
 * A synthetic Dart package: many library files under `lib/src/`, plus the two
 * targets the `package:` leg addresses — one reachable as `lib/<rel>` and one
 * only as bare `<rel>`, which is the second candidate and therefore the leg
 * that used to run a second full scan for every external import.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`lib/src/widget${String(i).padStart(5, '0')}.dart`);
  }
  files.push('lib/models.dart');
  files.push('lib/src/util.dart');
  files.push('tool/generate.dart');
  files.push('lib/main.dart');
  return new CountingSet(files);
}

describe('Dart import resolution — index reuse across imports (#2879)', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // Three shapes: an in-package hit through `lib/<rel>`, a bare-`<rel>` hit
      // that only the SECOND candidate answers, and an external package whose
      // two candidates both miss — the case that used to cost two full
      // workspace scans per import.
      resolved.push(resolveImportTarget('package:app/models.dart', FROM_FILE, files));
      resolved.push(resolveImportTarget('package:app/tool/generate.dart', FROM_FILE, files));
      resolved.push(resolveImportTarget(`package:vendor${i}/ghost${i}.dart`, FROM_FILE, files));
    }

    expect(files.scans).toBe(1);

    // Paired result assertion — a count of 1 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('lib/models.dart');
    expect(resolved[1]).toBe('tool/generate.dart');
    expect(resolved[2]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    const a = buildWorkspace(20);
    const b = buildWorkspace(20);

    for (let i = 0; i < 20; i++) {
      expect(resolveImportTarget('package:app/models.dart', FROM_FILE, a)).toBe('lib/models.dart');
      expect(resolveImportTarget('package:app/models.dart', FROM_FILE, b)).toBe('lib/models.dart');
    }

    expect(a.scans).toBe(1);
    expect(b.scans).toBe(1);
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // `package:` leg, first candidate: `lib/<rel>`.
    expect(resolveImportTarget('package:app/models.dart', FROM_FILE, files)).toBe(
      'lib/models.dart',
    );
    // `package:` leg, second candidate: bare `<rel>`, reached only after
    // `lib/<rel>` misses entirely.
    expect(resolveImportTarget('package:app/tool/generate.dart', FROM_FILE, files)).toBe(
      'tool/generate.dart',
    );
    // Relative import against the importer's directory.
    expect(resolveImportTarget('src/util.dart', FROM_FILE, files)).toBe('lib/src/util.dart');
    expect(resolveImportTarget('./src/util.dart', FROM_FILE, files)).toBe('lib/src/util.dart');
    expect(resolveImportTarget('../models.dart', 'lib/src/main.dart', files)).toBe(
      'lib/models.dart',
    );

    // SDK imports and external packages resolve to nothing in the workspace.
    expect(resolveImportTarget('dart:core', FROM_FILE, files)).toBeNull();
    expect(resolveImportTarget('package:collection/collection.dart', FROM_FILE, files)).toBeNull();
  });
});
