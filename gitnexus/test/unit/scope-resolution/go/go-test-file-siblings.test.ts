import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { populateGoPackageSiblings } from '../../../../src/core/ingestion/languages/go/index.js';

/**
 * C1 — `_test.go` files get package-sibling bindings (they used to be dropped,
 * sending every same-package call from a test to the global fallback).
 */
function def(nodeId: string, filePath: string, name: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Function', qualifiedName: name };
}
function parsed(
  filePath: string,
  moduleScope: string,
  ...localDefs: SymbolDefinition[]
): ParsedFile {
  return { filePath, moduleScope, scopes: [], parsedImports: [], localDefs, referenceSites: [] };
}
function setup(files: { path: string; scope: string; pkg: string; defs: SymbolDefinition[] }[]) {
  const parsedFiles = files.map((f) => parsed(f.path, f.scope, ...f.defs));
  const indexes = {
    moduleScopes: { byFilePath: new Map(files.map((f) => [f.path, f.scope])) },
    imports: new Map(),
    bindings: new Map(),
    bindingAugmentations: new Map(),
  } as unknown as ScopeResolutionIndexes;
  const fileContents = new Map(files.map((f) => [f.path, `package ${f.pkg}\n`]));
  populateGoPackageSiblings(parsedFiles, indexes, { fileContents });
  const see = (scope: string, name: string) =>
    indexes.bindingAugmentations
      .get(scope)
      ?.get(name)
      ?.map((b) => b.def.nodeId) ?? [];
  return { see };
}

describe('Go _test.go package siblings', () => {
  const helper = def('helper', 'pkg/a/a.go', 'setUpHelper');
  const exported = def('exported', 'pkg/a/a.go', 'NewThing');
  const testOnly = def('test-only', 'pkg/a/a_test.go', 'fakeStore');
  const otherTest = def('other-test', 'pkg/a/b_test.go', 'scenario');

  it('an internal test file sees non-test siblings, exported and unexported', () => {
    const { see } = setup([
      { path: 'pkg/a/a.go', scope: 'm:a', pkg: 'a', defs: [helper, exported] },
      { path: 'pkg/a/a_test.go', scope: 'm:a-test', pkg: 'a', defs: [testOnly] },
    ]);
    expect(see('m:a-test', 'setUpHelper')).toEqual(['helper']);
    expect(see('m:a-test', 'NewThing')).toEqual(['exported']);
  });

  it('internal test files see each other', () => {
    const { see } = setup([
      { path: 'pkg/a/a_test.go', scope: 'm:a-test', pkg: 'a', defs: [testOnly] },
      { path: 'pkg/a/b_test.go', scope: 'm:b-test', pkg: 'a', defs: [otherTest] },
    ]);
    expect(see('m:a-test', 'scenario')).toEqual(['other-test']);
    expect(see('m:b-test', 'fakeStore')).toEqual(['test-only']);
  });

  it('a non-test file does NOT see a test-only helper', () => {
    const { see } = setup([
      { path: 'pkg/a/a.go', scope: 'm:a', pkg: 'a', defs: [helper] },
      { path: 'pkg/a/a_test.go', scope: 'm:a-test', pkg: 'a', defs: [testOnly] },
    ]);
    expect(see('m:a', 'fakeStore')).toEqual([]);
  });

  it('an external test package (`foo_test`) gets NO bare-name bindings from `foo` — it must qualify `foo.X`', () => {
    // Go requires `a.NewThing` inside `package a_test`; a bare `NewThing()`
    // there is a compile error, so publishing it bound a call Go rejects.
    // The qualified form resolves through the test's explicit import of the
    // package path, not through sibling augmentation.
    const { see } = setup([
      { path: 'pkg/a/a.go', scope: 'm:a', pkg: 'a', defs: [helper, exported] },
      { path: 'pkg/a/a_ext_test.go', scope: 'm:ext', pkg: 'a_test', defs: [testOnly] },
    ]);
    expect(see('m:ext', 'NewThing')).toEqual([]);
    expect(see('m:ext', 'setUpHelper')).toEqual([]);
    // and `a` does not see the external test's declarations
    expect(see('m:a', 'fakeStore')).toEqual([]);
  });

  it('tests in a different directory with the same package name stay isolated', () => {
    const far = def('far', 'pkg/b/x_test.go', 'farHelper');
    const { see } = setup([
      { path: 'pkg/a/a_test.go', scope: 'm:a-test', pkg: 'a', defs: [testOnly] },
      { path: 'pkg/b/x_test.go', scope: 'm:far', pkg: 'a', defs: [far] },
    ]);
    expect(see('m:a-test', 'farHelper')).toEqual([]);
  });

  // Gap: the existing external-test test only checked visibility FROM the
  // external test's own scope (`m:ext`) and confirmed the internal package's
  // NON-test file (`m:a`) doesn't see it. It never checked the internal
  // TEST's scope — `package foo`'s `a_test.go` is still package `foo`, not
  // `foo_test`, and must be just as blind to `foo_test`'s declarations,
  // exported or not, as the non-test file is. `target.external &&
  // !receiver.external` is the line this exercises; a receiver-side bug
  // there (e.g. checking `target.isTest` instead) would leak names across
  // the `foo` / `foo_test` package boundary through the internal test only.
  it('an internal test file (still package `foo`) does not see the external test package at all, exported or not', () => {
    const extExported = def('ext-exported', 'pkg/a/a_ext_test.go', 'ExtHelper');
    const { see } = setup([
      { path: 'pkg/a/a.go', scope: 'm:a', pkg: 'a', defs: [helper, exported] },
      { path: 'pkg/a/a_test.go', scope: 'm:a-test', pkg: 'a', defs: [testOnly] },
      { path: 'pkg/a/b_test.go', scope: 'm:b-test', pkg: 'a', defs: [otherTest] },
      { path: 'pkg/a/a_ext_test.go', scope: 'm:ext', pkg: 'a_test', defs: [extExported] },
    ]);
    expect(see('m:a-test', 'ExtHelper')).toEqual([]);
    // still sees its own package's OTHER internal-test sibling (a different
    // file than itself, so the self-reference guard does not apply)
    expect(see('m:a-test', 'scenario')).toEqual(['other-test']);
  });

  // Two `_test.go` files that are BOTH external (`package foo_test`) are, to
  // each other, the same package — full visibility, unexported names
  // included. Distinct from "internal tests see each other" above (that case
  // never touches the `exportedOnly` branch at all).
  it('two external test files in the same directory see each other fully, unexported included', () => {
    const extA = def('ext-a', 'pkg/a/a_ext_test.go', 'scaffold');
    const extB = def('ext-b', 'pkg/a/b_ext_test.go', 'teardown');
    const { see } = setup([
      { path: 'pkg/a/a_ext_test.go', scope: 'm:ext-a', pkg: 'a_test', defs: [extA] },
      { path: 'pkg/a/b_ext_test.go', scope: 'm:ext-b', pkg: 'a_test', defs: [extB] },
    ]);
    expect(see('m:ext-a', 'teardown')).toEqual(['ext-b']);
    expect(see('m:ext-b', 'scaffold')).toEqual(['ext-a']);
  });

  // Requirement: "two packages in one directory ... do not cross-bind
  // non-exported names". Two genuinely distinct NON-test packages sharing a
  // directory (e.g. a `main` package next to a `//go:build ignore` tool)
  // must stay in separate sibling groups — same directory, different
  // `dir\0pkgName` key.
  it('two distinct non-test packages in the same directory do not cross-bind', () => {
    const fooHelper = def('foo-helper', 'pkg/a/main.go', 'setup');
    const barHelper = def('bar-helper', 'pkg/a/tool.go', 'setup');
    const { see } = setup([
      { path: 'pkg/a/main.go', scope: 'm:foo', pkg: 'foo', defs: [fooHelper] },
      { path: 'pkg/a/tool.go', scope: 'm:bar', pkg: 'bar', defs: [barHelper] },
    ]);
    expect(see('m:foo', 'setup')).toEqual([]);
    expect(see('m:bar', 'setup')).toEqual([]);
  });

  it('a package genuinely NAMED `foo_test` keeps its internal tests in their declared package', () => {
    // `package foo_test` is the external-test convention only when the
    // directory's real package is `foo`. Here the non-test files themselves say
    // `foo_test`, so its `_test.go` files are INTERNAL tests of that package
    // and must see unexported siblings; stripping `_test` blindly keyed them
    // as external tests of a non-existent `foo` and published nothing.
    const impl = def('impl', 'pkg/foo_test/impl.go', 'unexportedHelper');
    const fixture = def('fixture', 'pkg/foo_test/impl_test.go', 'newFixture');
    const { see } = setup([
      { path: 'pkg/foo_test/impl.go', scope: 'm:impl', pkg: 'foo_test', defs: [impl] },
      { path: 'pkg/foo_test/impl_test.go', scope: 'm:impl-test', pkg: 'foo_test', defs: [fixture] },
    ]);
    expect(see('m:impl-test', 'unexportedHelper')).toEqual(['impl']);
    // Non-test files still never see test-only declarations.
    expect(see('m:impl', 'newFixture')).toEqual([]);
  });

  it('`package foo_test` beside `package foo` is still the external-test convention', () => {
    const { see } = setup([
      { path: 'pkg/a/a.go', scope: 'm:a', pkg: 'a', defs: [helper, exported] },
      { path: 'pkg/a/a_test.go', scope: 'm:a-ext', pkg: 'a_test', defs: [testOnly] },
    ]);
    expect(see('m:a-ext', 'setUpHelper')).toEqual([]);
    expect(see('m:a-ext', 'NewThing')).toEqual([]);
  });
});
