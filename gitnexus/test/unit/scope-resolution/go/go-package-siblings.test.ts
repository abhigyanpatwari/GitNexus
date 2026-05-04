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
});

function def(nodeId: string, filePath: string, name: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Function', qualifiedName: name };
}

function parsed(filePath: string, moduleScope: string, localDef: SymbolDefinition): ParsedFile {
  return {
    filePath,
    moduleScope,
    scopes: [],
    parsedImports: [],
    localDefs: [localDef],
    referenceSites: [],
  };
}
