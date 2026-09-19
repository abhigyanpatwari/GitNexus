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
    const indexes = makeIndexes([container, entry, makeEntry], bindingAugmentations);

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map(),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
  });

  it('recovers Outer.Container from public extension source when members are trailing-only', () => {
    const extensionSource = 'public extension Outer.Container {\n  static func makeEntry() {}\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, { ownerQualifiedName: 'Outer.Container' });

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
  });

  it('recovers a qualified owner when the extension Class scope has no bindings', () => {
    const extensionSource = 'public extension Outer.Inner {\n  subscript(i: Int) -> Int { i }\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, { classBindings: new Map() });

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
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
    const indexes = makeIndexes(
      [container, entry, containerMethod, otherMethod],
      bindingAugmentations,
    );

    populateSwiftTargetSiblings([declaration, ambiguousExtension], indexes, {
      fileContents: new Map(),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toBeUndefined();
  });

  it('preserves the qualified owner of a nested-type extension', () => {
    // Capture generation keeps only the trailing owner on members (`Inner.f`),
    // so source text must recover `Outer.Inner`.
    const extensionSource = 'extension Outer.Inner {\n  static func makeEntry() {}\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource);

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
  });

  it.each([
    ['public extension Outer.Inner {\n  static func makeEntry() {}\n}\n', 0],
    ['@MainActor\nextension Outer.Inner {\n  static func makeEntry() {}\n}\n', 0],
    ['@available(iOS 15, *)\npublic extension Outer.Inner {\n  static func makeEntry() {}\n}\n', 0],
    [
      '@available(*, deprecated, message: "Use extension Other.Inner")\npublic extension Outer.Inner {\n  static func makeEntry() {}\n}\n',
      0,
    ],
    ['  public extension Outer.Inner {\n  static func makeEntry() {}\n}\n', 2],
    [
      '/* outer /* inner */ extension Wrong */ extension Outer.Inner {\n  static func makeEntry() {}\n}\n',
      0,
    ],
    [
      '@available(*, deprecated, message: #"Use extension Wrong"#)\npublic extension Outer.Inner {\n  static func makeEntry() {}\n}\n',
      0,
    ],
  ])(
    'recovers a qualified owner through modifiers and attributes: %j',
    (extensionSource, startCol = 0) => {
      const { declaration, extension, entry, indexes, bindingAugmentations } =
        qualifiedExtensionFixture(extensionSource, { startCol });

      populateSwiftTargetSiblings([declaration, extension], indexes, {
        fileContents: new Map([['Builder.swift', extensionSource]]),
      });

      expectAugmentedEntry(bindingAugmentations, entry);
    },
  );

  it('converts Tree-sitter UTF-8 columns before slicing JS source', () => {
    const prefix = 'struct Café {}; ';
    const extensionSource = `${prefix}extension Outer.Inner {\n  static func makeEntry() {}\n}\n`;
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, {
        startCol: Buffer.byteLength(prefix, 'utf8'),
      });

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
  });

  it('recovers a Unicode qualified extension owner', () => {
    const extensionSource = 'public extension Café.Container {\n  static func makeEntry() {}\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, { ownerQualifiedName: 'Café.Container' });

    populateSwiftTargetSiblings([declaration, extension], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
  });

  it('prefers Outer.Inner.Entry over a colliding top-level Inner.Entry', () => {
    const { collision, topInner, wrongEntry } = collidingTopLevelInner();
    const extensionSource = 'public extension Outer.Inner {\n  static func makeEntry() {}\n}\n';
    const { declaration, extension, entry, indexes, bindingAugmentations } =
      qualifiedExtensionFixture(extensionSource, { extraDefs: [topInner, wrongEntry] });

    populateSwiftTargetSiblings([declaration, extension, collision], indexes, {
      fileContents: new Map([['Builder.swift', extensionSource]]),
    });

    expectAugmentedEntry(bindingAugmentations, entry);
    expect(bindingAugmentations.get(classId('TopInner.swift'))?.get('Entry')).toEqual([
      { def: wrongEntry, origin: 'namespace' },
    ]);
  });

  it('does not last-dot-guess Inner when source is present but not an extension', () => {
    const { collision, topInner, wrongEntry } = collidingTopLevelInner();
    const { declaration, extension, indexes, bindingAugmentations } = qualifiedExtensionFixture(
      'struct Unrelated {}\n',
      { extraDefs: [topInner, wrongEntry] },
    );

    populateSwiftTargetSiblings([declaration, extension, collision], indexes, {
      fileContents: new Map([['Builder.swift', 'struct Unrelated {}\n']]),
    });

    expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toBeUndefined();
    expect(bindingAugmentations.get(classId('TopInner.swift'))?.get('Entry')).toEqual([
      { def: wrongEntry, origin: 'namespace' },
    ]);
  });
});

function collidingTopLevelInner() {
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
  const collision = parsedFile(
    'TopInner.swift',
    [topInner],
    new Map([['Entry', [{ def: wrongEntry, origin: 'local' }]]]),
    [topInner, wrongEntry],
  );
  return { collision, topInner, wrongEntry };
}

function expectAugmentedEntry(
  bindingAugmentations: Map<ScopeId, Map<string, unknown>>,
  entry: SymbolDefinition,
) {
  expect(bindingAugmentations.get(classId('Builder.swift'))?.get('Entry')).toEqual([
    { def: entry, origin: 'namespace' },
  ]);
}

function makeIndexes(
  defs: readonly SymbolDefinition[],
  bindingAugmentations: Map<unknown, unknown>,
): ScopeResolutionIndexes {
  return {
    defs: buildDefIndex(defs),
    moduleScopes: {
      byFilePath: new Map([
        ['Types.swift', moduleId('Types.swift')],
        ['Builder.swift', moduleId('Builder.swift')],
      ]),
    },
    bindingAugmentations,
  } as unknown as ScopeResolutionIndexes;
}

function rangeForSource(source: string, startCol = 0) {
  const lines = source.split('\n');
  const last = source.endsWith('\n') ? lines.length - 2 : lines.length - 1;
  const lastLine = Math.max(last, 0);
  return {
    startLine: 1,
    startCol,
    endLine: lastLine + 1,
    endCol: (lines[lastLine] ?? '').length,
  };
}

function qualifiedExtensionFixture(
  extensionSource: string,
  options: {
    extraDefs?: readonly SymbolDefinition[];
    classBindings?: ReadonlyMap<string, readonly { def: SymbolDefinition; origin: 'local' }[]>;
    startCol?: number;
    ownerQualifiedName?: string;
  } = {},
) {
  const ownerQualifiedName = options.ownerQualifiedName ?? 'Outer.Inner';
  const ownerSimple = ownerQualifiedName.split('.').pop() ?? ownerQualifiedName;
  const owner: SymbolDefinition = {
    nodeId: `def:Types.swift:${ownerQualifiedName}`,
    filePath: 'Types.swift',
    type: 'Class',
    qualifiedName: ownerQualifiedName,
  };
  const entry: SymbolDefinition = {
    nodeId: `def:Types.swift:${ownerQualifiedName}.Entry`,
    filePath: 'Types.swift',
    type: 'Class',
    qualifiedName: `${ownerQualifiedName}.Entry`,
    ownerId: owner.nodeId,
  };
  const makeEntry: SymbolDefinition = {
    nodeId: `def:Builder.swift:${ownerSimple}.makeEntry`,
    filePath: 'Builder.swift',
    type: 'Method',
    qualifiedName: `${ownerSimple}.makeEntry`,
  };
  const extraDefs = options.extraDefs ?? [];
  const classBindings =
    options.classBindings ??
    new Map([['makeEntry', [{ def: makeEntry, origin: 'local' as const }]]]);
  const declaration = parsedFile(
    'Types.swift',
    [owner],
    new Map([['Entry', [{ def: entry, origin: 'local' }]]]),
    [owner, entry],
  );
  const extension = parsedFile(
    'Builder.swift',
    [],
    classBindings,
    [makeEntry],
    rangeForSource(extensionSource, options.startCol ?? 0),
  );
  const bindingAugmentations = new Map();
  const indexes = makeIndexes([owner, entry, makeEntry, ...extraDefs], bindingAugmentations);
  return { declaration, extension, entry, indexes, bindingAugmentations };
}
