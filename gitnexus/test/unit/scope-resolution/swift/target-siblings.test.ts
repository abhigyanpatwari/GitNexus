import {
  buildDefIndex,
  type ParsedFile,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { populateSwiftTargetSiblings } from '../../../../src/core/ingestion/languages/swift/target-siblings.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';

const moduleId = (filePath: string) => `scope:${filePath}:module` as ScopeId;
const classId = (filePath: string) => `scope:${filePath}:class` as ScopeId;

function parsedFile(
  filePath: string,
  classOwnedDefs: readonly SymbolDefinition[],
  classBindings: ReadonlyMap<string, readonly { def: SymbolDefinition; origin: 'local' }[]>,
  localDefs: readonly SymbolDefinition[],
  classRange = { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
): ParsedFile {
  return {
    filePath,
    moduleScope: moduleId(filePath),
    scopes: [
      {
        id: moduleId(filePath),
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
        filePath,
        bindings: new Map(),
        ownedDefs: [],
        imports: [],
        typeBindings: new Map(),
      },
      {
        id: classId(filePath),
        parent: moduleId(filePath),
        kind: 'Class',
        range: classRange,
        filePath,
        bindings: classBindings,
        ownedDefs: classOwnedDefs,
        imports: [],
        typeBindings: new Map(),
      },
    ],
    parsedImports: [],
    localDefs,
    referenceSites: [],
  };
}

describe('Swift target sibling visibility', () => {
  it('binds a nested type into a same-target extension fragment', () => {
    const container: SymbolDefinition = {
      nodeId: 'def:Types.swift:Container',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Container',
    };
    const entry: SymbolDefinition = {
      nodeId: 'def:Types.swift:Container.Entry',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Container.Entry',
      ownerId: container.nodeId,
    };
    const makeEntry: SymbolDefinition = {
      nodeId: 'def:Builder.swift:Container.makeEntry',
      filePath: 'Builder.swift',
      type: 'Method',
      qualifiedName: 'Container.makeEntry',
    };
    const declaration = parsedFile(
      'Types.swift',
      [container],
      new Map([['Entry', [{ def: entry, origin: 'local' }]]]),
      [container, entry],
    );
    const extension = parsedFile(
      'Builder.swift',
      [],
      new Map([['makeEntry', [{ def: makeEntry, origin: 'local' }]]]),
      [makeEntry],
    );
    const bindingAugmentations = new Map();
    const indexes = {
      defs: buildDefIndex([container, entry, makeEntry]),
      moduleScopes: {
        byFilePath: new Map([
          ['Types.swift', moduleId('Types.swift')],
          ['Builder.swift', moduleId('Builder.swift')],
        ]),
      },
      bindingAugmentations,
    } as unknown as ScopeResolutionIndexes;

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map(),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toEqual([
      { def: entry, origin: 'namespace' },
    ]);
  });

  it('does not infer an extension owner from inconsistent qualified members', () => {
    const container: SymbolDefinition = {
      nodeId: 'def:Types.swift:Container',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Container',
    };
    const entry: SymbolDefinition = {
      nodeId: 'def:Types.swift:Container.Entry',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Container.Entry',
      ownerId: container.nodeId,
    };
    const containerMethod: SymbolDefinition = {
      nodeId: 'def:Builder.swift:Container.makeEntry',
      filePath: 'Builder.swift',
      type: 'Method',
      qualifiedName: 'Container.makeEntry',
    };
    const otherMethod: SymbolDefinition = {
      nodeId: 'def:Builder.swift:Other.makeEntry',
      filePath: 'Builder.swift',
      type: 'Method',
      qualifiedName: 'Other.makeEntry',
    };
    const declaration = parsedFile(
      'Types.swift',
      [container],
      new Map([['Entry', [{ def: entry, origin: 'local' }]]]),
      [container, entry],
    );
    const ambiguousExtension = parsedFile(
      'Builder.swift',
      [],
      new Map([
        ['containerMethod', [{ def: containerMethod, origin: 'local' }]],
        ['otherMethod', [{ def: otherMethod, origin: 'local' }]],
      ]),
      [containerMethod, otherMethod],
    );
    const bindingAugmentations = new Map();
    const indexes = {
      defs: buildDefIndex([container, entry, containerMethod, otherMethod]),
      moduleScopes: {
        byFilePath: new Map([
          ['Types.swift', moduleId('Types.swift')],
          ['Builder.swift', moduleId('Builder.swift')],
        ]),
      },
      bindingAugmentations,
    } as unknown as ScopeResolutionIndexes;

    populateSwiftTargetSiblings([declaration, ambiguousExtension], indexes, {
      fileContents: new Map(),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toBeUndefined();
  });

  it('preserves the qualified owner of a nested-type extension', () => {
    const inner: SymbolDefinition = {
      nodeId: 'def:Types.swift:Outer.Inner',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Outer.Inner',
    };
    const entry: SymbolDefinition = {
      nodeId: 'def:Types.swift:Outer.Inner.Entry',
      filePath: 'Types.swift',
      type: 'Class',
      qualifiedName: 'Outer.Inner.Entry',
      ownerId: inner.nodeId,
    };
    // Swift capture generation intentionally retains only the trailing owner
    // on extension members, so source text must recover `Outer.Inner`.
    const makeEntry: SymbolDefinition = {
      nodeId: 'def:Builder.swift:Inner.makeEntry',
      filePath: 'Builder.swift',
      type: 'Method',
      qualifiedName: 'Inner.makeEntry',
    };
    const declaration = parsedFile(
      'Types.swift',
      [inner],
      new Map([['Entry', [{ def: entry, origin: 'local' }]]]),
      [inner, entry],
    );
    const extensionSource = 'extension Outer.Inner {\n  static func makeEntry() {}\n}\n';
    const extension = parsedFile(
      'Builder.swift',
      [],
      new Map([['makeEntry', [{ def: makeEntry, origin: 'local' }]]]),
      [makeEntry],
      {
        startLine: 1,
        startCol: 0,
        endLine: 3,
        endCol: 1,
      },
    );
    const bindingAugmentations = new Map();
    const indexes = {
      defs: buildDefIndex([inner, entry, makeEntry]),
      moduleScopes: {
        byFilePath: new Map([
          ['Types.swift', moduleId('Types.swift')],
          ['Builder.swift', moduleId('Builder.swift')],
        ]),
      },
      bindingAugmentations,
    } as unknown as ScopeResolutionIndexes;

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toEqual([
      { def: entry, origin: 'namespace' },
    ]);
  });

  it.each([
    ['public extension Outer.Inner {\n  static func makeEntry() {}\n}\n'],
    ['@MainActor\nextension Outer.Inner {\n  static func makeEntry() {}\n}\n'],
    ['@available(iOS 15, *)\npublic extension Outer.Inner {\n  static func makeEntry() {}\n}\n'],
  ])('recovers a qualified owner through modifiers and attributes: %j', (extensionSource) => {
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource);

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toEqual([
      { def: entry, origin: 'namespace' },
    ]);
  });

  it('prefers Outer.Inner.Entry over a colliding top-level Inner.Entry', () => {
    const topInner: SymbolDefinition = {
      nodeId: 'def:TopInner.swift:Inner',
      filePath: 'TopInner.swift',
      type: 'Class',
      qualifiedName: 'Inner',
    };
    const wrongEntry: SymbolDefinition = {
      nodeId: 'def:TopInner.swift:Inner.Entry',
      filePath: 'TopInner.swift',
      type: 'Class',
      qualifiedName: 'Inner.Entry',
      ownerId: topInner.nodeId,
    };
    const extensionSource = 'public extension Outer.Inner {\n  static func makeEntry() {}\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, { extraDefs: [topInner, wrongEntry] });

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toEqual([
      { def: entry, origin: 'namespace' },
    ]);
  });

  it('does not last-dot-guess Inner when source is present but not an extension', () => {
    const topInner: SymbolDefinition = {
      nodeId: 'def:TopInner.swift:Inner',
      filePath: 'TopInner.swift',
      type: 'Class',
      qualifiedName: 'Inner',
    };
    const wrongEntry: SymbolDefinition = {
      nodeId: 'def:TopInner.swift:Inner.Entry',
      filePath: 'TopInner.swift',
      type: 'Class',
      qualifiedName: 'Inner.Entry',
      ownerId: topInner.nodeId,
    };
    const { declaration, extension, indexes, bindingAugmentations } = qualifiedExtensionFixture(
      'struct Unrelated {}\n',
      { extraDefs: [topInner, wrongEntry] },
    );

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', 'struct Unrelated {}\n']]),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toBeUndefined();
  });
});

function qualifiedExtensionFixture(
  extensionSource: string,
  options: { extraDefs?: readonly SymbolDefinition[] } = {},
) {
  const inner: SymbolDefinition = {
    nodeId: 'def:Types.swift:Outer.Inner',
    filePath: 'Types.swift',
    type: 'Class',
    qualifiedName: 'Outer.Inner',
  };
  const entry: SymbolDefinition = {
    nodeId: 'def:Types.swift:Outer.Inner.Entry',
    filePath: 'Types.swift',
    type: 'Class',
    qualifiedName: 'Outer.Inner.Entry',
    ownerId: inner.nodeId,
  };
  const makeEntry: SymbolDefinition = {
    nodeId: 'def:Builder.swift:Inner.makeEntry',
    filePath: 'Builder.swift',
    type: 'Method',
    qualifiedName: 'Inner.makeEntry',
  };
  const extraDefs = options.extraDefs ?? [];
  const declaration = parsedFile(
    'Types.swift',
    [inner],
    new Map([['Entry', [{ def: entry, origin: 'local' }]]]),
    [inner, entry],
  );
  const extension = parsedFile(
    'Builder.swift',
    [],
    new Map([['makeEntry', [{ def: makeEntry, origin: 'local' }]]]),
    [makeEntry],
    {
      startLine: 1,
      startCol: 0,
      endLine: 3,
      endCol: 1,
    },
  );
  const bindingAugmentations = new Map();
  const allDefs = [inner, entry, makeEntry, ...extraDefs];
  const indexes = {
    defs: buildDefIndex(allDefs),
    moduleScopes: {
      byFilePath: new Map([
        ['Types.swift', moduleId('Types.swift')],
        ['Builder.swift', moduleId('Builder.swift')],
      ]),
    },
    bindingAugmentations,
  } as unknown as ScopeResolutionIndexes;
  return { declaration, extension, entry, indexes, bindingAugmentations };
}
