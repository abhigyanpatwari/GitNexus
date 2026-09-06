/**
 * Go — external test packages (`package foo_test`) through the REAL pipeline
 * (tree-sitter extraction + import resolution + `populateGoPackageSiblings`),
 * not just the isolated `populateGoPackageSiblings` unit in
 * `test/unit/scope-resolution/go/go-test-file-siblings.test.ts`.
 *
 * The fix (`gitnexus/src/core/ingestion/languages/go/package-siblings.ts`):
 * an external test package (`package foo_test`, e.g. `a_ext_test.go`) no
 * longer gets BARE-name sibling bindings from `foo` at all — Go itself
 * requires `foo.NewThing`, not `NewThing()`, inside `package foo_test`. The
 * QUALIFIED form still resolves — it was never routed through
 * `populateGoPackageSiblings` in the first place, it goes through the
 * ordinary import resolver (`import "…/pkg"` + a member call), which this
 * fix does not touch.
 *
 * Also pins: an INTERNAL test file (`package foo`, e.g. `a_test.go`) keeps
 * its bare-name sibling bindings (unchanged).
 *
 * The same boundary is enforced on the heuristic channel too: the Go
 * name-fallback hook classifies files by package (internal test / external
 * `foo_test` / non-test), not by directory, so neither binding gets even a
 * 0.5-confidence `global-name-fallback` edge (asserted at the bottom).
 * `populateGoPackageSiblings` (touched by this diff) correctly refuses it on
 * its own channel, but Go's separate `global-name-fallback` heuristic
 * (`goIsGlobalNameFallbackPlausible`, untouched by either commit under test)
 * treats "same directory" as always plausible, independent of the Go
 * package/test boundary, and reopens both this case and the external-test
 * bare-call case at 0.5 confidence.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, writeFixtureRepo, type PipelineResult } from './helpers.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

describe('Go external vs internal test packages — qualified vs bare NewThing (real pipeline)', () => {
  let result: PipelineResult;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-go-exttest-'));
    writeFixtureRepo(dir, {
      'go.mod': 'module example.com/extpkg\n\ngo 1.21\n',
      'pkg/a.go': [
        'package a',
        '',
        'func NewThing() int {',
        '\treturn 1',
        '}',
        '',
        'func UsesTestHelper() int {',
        '\treturn onlyInInternalTest()',
        '}',
        '',
      ].join('\n'),
      // Internal test: same package (`a`). Bare `NewThing()` and a
      // test-only declaration other internal-test files can see.
      'pkg/a_test.go': [
        'package a',
        '',
        'func onlyInInternalTest() int {',
        '\treturn 2',
        '}',
        '',
        'func CallBareFromInternalTest() int {',
        '\treturn NewThing()',
        '}',
        '',
      ].join('\n'),
      // External test: `package a_test`, a DIFFERENT package that must
      // import `pkg` explicitly to reach it — exactly like any other
      // consumer of the package.
      'pkg/a_ext_test.go': [
        'package a_test',
        '',
        'import "example.com/extpkg/pkg"',
        '',
        'func CallQualifiedFromExternalTest() int {',
        '\treturn pkg.NewThing()',
        '}',
        '',
        'func CallBareFromExternalTest() int {',
        '\treturn NewThing()',
        '}',
        '',
      ].join('\n'),
    });
    result = await runPipelineFromRepo(dir, () => {});
  }, 60000);

  it('an internal test file (still package `a`) resolves the bare call — unchanged behavior', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'CallBareFromInternalTest',
    );
    expect(edges.map((e) => e.target)).toEqual(['NewThing']);
    // Confident — no heuristic-fallback reason on this edge.
    expect(edges[0]!.rel.reason).not.toBe('global-name-fallback');
  });

  it('an external test package resolves the QUALIFIED call (pkg.NewThing) through the ordinary import resolver', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'CallQualifiedFromExternalTest',
    );
    expect(edges.map((e) => e.target)).toEqual(['NewThing']);
    expect(edges[0]!.rel.reason).not.toBe('global-name-fallback');
  });

  it("an external test package does NOT get a CONFIDENT bare-name edge from `foo`'s package-sibling channel", () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'CallBareFromExternalTest',
    );
    const toNewThing = edges.filter((e) => e.target === 'NewThing');
    // No binding at all: the confident package-sibling channel refuses the
    // cross-package bare name, and the name-fallback hook refuses it too.
    expect(toNewThing).toEqual([]);
  });

  it('a non-test file gets NO edge to a test-only declaration — confident or heuristic', () => {
    const edges = getRelationships(result, 'CALLS').filter((e) => e.source === 'UsesTestHelper');
    const toHelper = edges.filter((e) => e.target === 'onlyInInternalTest');
    expect(toHelper).toEqual([]);
  });

  /**
   * Regression guard for the name-fallback channel. `goIsGlobalNameFallbackPlausible`
   * once treated "same directory" as "same package"; a directory can hold three Go
   * packages at once (`foo`, external `foo_test`, and `foo`'s own `_test.go` files),
   * so both bindings below used to come back as 0.5-confidence `global-name-fallback`
   * edges. The hook now classifies caller and candidate by package (via the package
   * clause when sources are available) and refuses non-test → test-only and bare
   * cross-package names outright. The two tests below pin "no edge at all".
   */
  it('a non-test file calling a test-only helper by bare name should get NO edge at all, not even a heuristic one', () => {
    const edges = getRelationships(result, 'CALLS').filter((e) => e.source === 'UsesTestHelper');
    expect(edges.map((e) => e.target)).not.toContain('onlyInInternalTest');
  });

  it("an external test package's bare NewThing() should get NO edge at all — Go rejects the call outright, so no confidence tier should bind it", () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'CallBareFromExternalTest',
    );
    expect(edges.map((e) => e.target)).not.toContain('NewThing');
  });
});
