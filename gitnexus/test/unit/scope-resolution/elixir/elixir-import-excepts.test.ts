import { describe, expect, it } from 'vitest';
import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { elixirScopeResolver } from '../../../../src/core/ingestion/languages/elixir/scope-resolver.js';

const importerScope = 'scope:importer#0:0-9:0:Module' as ScopeId;
const targetScope = 'scope:target#0:0-9:0:Module' as ScopeId;
const callable = (name: string, arity: number, exported = true): SymbolDefinition => ({
  nodeId: `${name}/${arity}`,
  type: 'Function',
  name,
  qualifiedName: `Filtered.${name}`,
  parameterCount: arity,
  requiredParameterCount: arity,
  isExported: exported,
  filePath: 'filtered.ex',
  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
});

describe('Elixir import except augmentation', () => {
  it('adds only the exact public name and arity from worker-safe only facts', () => {
    const importer = {
      filePath: 'importer.ex',
      moduleScope: importerScope,
      parsedImports: [],
      localDefs: [],
      referenceSites: [],
      scopes: [{ id: importerScope, range: { startLine: 1, startCol: 0, endLine: 9, endCol: 0 } }],
      captureSideChannel: {
        kind: 'elixir',
        importExcepts: [],
        importOnly: [
          { target: 'Filtered', allowed: [{ name: 'f', arity: 1 }], startLine: 1, startCol: 0 },
        ],
      },
    } as unknown as ParsedFile;
    const target = {
      filePath: 'filtered.ex',
      moduleScope: targetScope,
      parsedImports: [],
      referenceSites: [],
      scopes: [],
      localDefs: [
        { ...callable('Filtered', 0), type: 'Class', qualifiedName: 'Filtered' },
        callable('f', 1),
        callable('f', 2),
        callable('private', 1, false),
      ],
    } as unknown as ParsedFile;
    const augmentations = new Map();
    elixirScopeResolver.populateNamespaceSiblings!(
      [importer, target],
      { bindingAugmentations: augmentations } as never,
      { fileContents: new Map() },
    );
    expect(
      augmentations
        .get(importerScope)!
        .get('f')
        .map((binding: { def: SymbolDefinition }) => binding.def.parameterCount),
    ).toEqual([1]);
    expect(augmentations.get(importerScope)!.has('private')).toBe(false);
  });

  it('adds only public non-excluded callable overloads at the lexical import scope', () => {
    const importer = {
      filePath: 'importer.ex',
      moduleScope: importerScope,
      parsedImports: [{ kind: 'wildcard', targetRaw: 'Filtered', declaredAtScope: importerScope }],
      localDefs: [],
      referenceSites: [],
      scopes: [],
      captureSideChannel: {
        kind: 'elixir',
        importExcepts: [
          {
            target: 'Filtered',
            excluded: [{ name: 'hidden', arity: 1 }],
            startLine: 2,
            startCol: 0,
          },
        ],
      },
    } as unknown as ParsedFile;
    const target = {
      filePath: 'filtered.ex',
      moduleScope: targetScope,
      parsedImports: [],
      referenceSites: [],
      scopes: [],
      localDefs: [
        { ...callable('Filtered', 0), type: 'Class', qualifiedName: 'Filtered' },
        callable('visible', 1),
        callable('hidden', 1),
        callable('hidden', 2),
        callable('private', 0, false),
      ],
    } as unknown as ParsedFile;
    const augmentations = new Map();
    elixirScopeResolver.populateNamespaceSiblings!(
      [importer, target],
      {
        bindingAugmentations: augmentations,
      } as never,
      { fileContents: new Map() },
    );
    expect([...augmentations.get(importerScope)!.keys()].sort()).toEqual(['hidden', 'visible']);
    expect(
      augmentations
        .get(importerScope)!
        .get('hidden')
        .map((binding: { def: SymbolDefinition }) => binding.def.parameterCount),
    ).toEqual([2]);
  });

  it('leaves an ambiguous module target unresolved', () => {
    const importer = {
      filePath: 'importer.ex',
      moduleScope: importerScope,
      parsedImports: [],
      localDefs: [],
      referenceSites: [],
      scopes: [],
      captureSideChannel: {
        kind: 'elixir',
        importExcepts: [{ target: 'Filtered', excluded: [], startLine: 1, startCol: 0 }],
      },
    } as unknown as ParsedFile;
    const module = (filePath: string) =>
      ({
        filePath,
        moduleScope: targetScope,
        parsedImports: [],
        referenceSites: [],
        scopes: [],
        localDefs: [
          { ...callable('Filtered', 0), type: 'Class', qualifiedName: 'Filtered' },
          callable('visible', 0),
        ],
      }) as unknown as ParsedFile;
    const augmentations = new Map();
    elixirScopeResolver.populateNamespaceSiblings!(
      [importer, module('one.ex'), module('two.ex')],
      { bindingAugmentations: augmentations } as never,
      { fileContents: new Map() },
    );
    expect(augmentations).toEqual(new Map());
  });
});
