import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { populateGoPackageSiblings } from '../../../../src/core/ingestion/languages/go/index.js';

describe('Go package siblings', () => {
  it('augments bindings only for files in the same package directory', () => {
    const fooDef = def('foo', 'cmd/foo/a.go', 'OnlyFoo');
    const fooHelperDef = def('foo-helper', 'cmd/foo/b.go', 'OnlyFooHelper');
    const barDef = def('bar', 'cmd/bar/a.go', 'OnlyBar');

    const parsedFiles: ParsedFile[] = [
      parsed('cmd/foo/a.go', 'module:foo-a', fooDef),
      parsed('cmd/foo/b.go', 'module:foo-b', fooHelperDef),
      parsed('cmd/bar/a.go', 'module:bar-a', barDef),
    ];
    const indexes = {
      moduleScopes: {
        byFilePath: new Map([
          ['cmd/foo/a.go', 'module:foo-a'],
          ['cmd/foo/b.go', 'module:foo-b'],
          ['cmd/bar/a.go', 'module:bar-a'],
        ]),
      },
      imports: new Map(),
      bindings: new Map(),
      bindingAugmentations: new Map(),
    } as unknown as ScopeResolutionIndexes;
    const fileContents = new Map([
      ['cmd/foo/a.go', 'package main\n'],
      ['cmd/foo/b.go', 'package main\n'],
      ['cmd/bar/a.go', 'package main\n'],
    ]);

    populateGoPackageSiblings(parsedFiles, indexes, { fileContents });

    const augmentations = indexes.bindingAugmentations;
    expect(augmentations.get('module:foo-a')?.get('OnlyFooHelper')?.[0]?.def.nodeId).toBe(
      'foo-helper',
    );
    expect(augmentations.get('module:foo-a')?.get('OnlyBar')).toBeUndefined();
    expect(augmentations.get('module:bar-a')?.get('OnlyFoo')).toBeUndefined();
  });

  it("publishes same-name sibling defs in file order and never includes a file's own defs", () => {
    const aFoo = def('a-foo', 'pkg/a/a.go', 'Foo');
    const bFoo = def('b-foo', 'pkg/a/b.go', 'Foo');
    const bBar = def('b-bar', 'pkg/a/b.go', 'Bar');
    const cBaz = def('c-baz', 'pkg/a/c.go', 'Baz');

    const parsedFiles: ParsedFile[] = [
      parsed('pkg/a/a.go', 'module:a', aFoo),
      parsed('pkg/a/b.go', 'module:b', bFoo, bBar),
      parsed('pkg/a/c.go', 'module:c', cBaz),
    ];
    const indexes = {
      moduleScopes: {
        byFilePath: new Map([
          ['pkg/a/a.go', 'module:a'],
          ['pkg/a/b.go', 'module:b'],
          ['pkg/a/c.go', 'module:c'],
        ]),
      },
      imports: new Map(),
      bindings: new Map(),
      bindingAugmentations: new Map(),
    } as unknown as ScopeResolutionIndexes;
    const fileContents = new Map([
      ['pkg/a/a.go', 'package a\n'],
      ['pkg/a/b.go', 'package a\n'],
      ['pkg/a/c.go', 'package a\n'],
    ]);

    populateGoPackageSiblings(parsedFiles, indexes, { fileContents });

    const augmentations = indexes.bindingAugmentations;
    expect(
      augmentations
        .get('module:c')
        ?.get('Foo')
        ?.map((b) => b.def.nodeId),
    ).toEqual(['a-foo', 'b-foo']);
    expect(
      augmentations
        .get('module:a')
        ?.get('Foo')
        ?.map((b) => b.def.nodeId),
    ).toEqual(['b-foo']);
    expect(
      augmentations
        .get('module:a')
        ?.get('Bar')
        ?.map((b) => b.def.nodeId),
    ).toEqual(['b-bar']);
    expect(
      augmentations
        .get('module:a')
        ?.get('Baz')
        ?.map((b) => b.def.nodeId),
    ).toEqual(['c-baz']);
    expect(
      augmentations
        .get('module:b')
        ?.get('Foo')
        ?.map((b) => b.def.nodeId),
    ).toEqual(['a-foo']);
  });
});

function def(nodeId: string, filePath: string, name: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Function', qualifiedName: name };
}

function parsed(
  filePath: string,
  moduleScope: string,
  ...localDefs: SymbolDefinition[]
): ParsedFile {
  return {
    filePath,
    moduleScope,
    scopes: [],
    parsedImports: [],
    localDefs,
    referenceSites: [],
  };
}
