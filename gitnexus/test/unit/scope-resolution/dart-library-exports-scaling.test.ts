/**
 * Size and work bounds of the Dart library-namespace pass, on hand-built
 * `ParsedFile`s (no parser, no pipeline) and counted, never timed:
 *
 *   - a plain import stays ONE `ParsedImport` per directive, whatever the
 *     imported library exports;
 *   - a library's names are stored once, in one shared table, however many
 *     files import it;
 *   - the export closure delivers each name along each `export` directive a
 *     bounded number of times, on a long chain and on a cycle;
 *   - the facts of a library follow a copy of its `ParsedFile`.
 */

import { describe, expect, it } from 'vitest';
import type {
  BindingRef,
  ParsedFile,
  ParsedImport,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import {
  dartModuleExports,
  populateDartImportNamespaces,
  populateDartLibraryExports,
  type DartExportClosureWork,
} from '../../../src/core/ingestion/languages/dart/library-exports.js';
import { dartIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/dart/name-fallback-visibility.js';
import { lookupBindingsAt } from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

type NameFilters = NonNullable<ParsedImport['nameFilters']>;

const topLevel = (filePath: string, name: string): SymbolDefinition => ({
  nodeId: `def:${filePath}:${name}`,
  filePath,
  type: 'Function',
  qualifiedName: name,
});

const moduleScopeOf = (filePath: string): ScopeId => `scope:${filePath}#module`;

/** One library file: its top-level names and its import / export directives. */
function library(
  filePath: string,
  names: readonly string[],
  directives: readonly ParsedImport[] = [],
): ParsedFile {
  const defs = names.map((name) => topLevel(filePath, name));
  const moduleScope = moduleScopeOf(filePath);
  const scope = {
    id: moduleScope,
    kind: 'Module',
    parent: null,
    filePath,
    bindings: new Map(
      defs.map((def): [string, BindingRef[]] => [
        def.qualifiedName ?? '',
        [{ def, origin: 'local' }],
      ]),
    ),
  } as unknown as Scope;
  return {
    filePath,
    moduleScope,
    scopes: [scope],
    parsedImports: directives,
    localDefs: defs,
    referenceSites: [],
  };
}

const plainImport = (targetRaw: string, nameFilters?: NameFilters): ParsedImport => ({
  kind: 'wildcard',
  targetRaw,
  reexportsName: false,
  ...(nameFilters === undefined ? {} : { nameFilters }),
});

const exportOf = (targetRaw: string, nameFilters?: NameFilters): ParsedImport => ({
  ...plainImport(targetRaw, nameFilters),
  exportsOnly: true,
});

/** The binding channels the import-namespace pass writes, empty. */
function emptyIndexes(): ScopeResolutionIndexes {
  return {
    bindings: new Map(),
    bindingAugmentations: new Map(),
    workspaceFqnBindings: new Map(),
    namespaceFqnBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
    namespaceLookupTiersByScope: new Map(),
  } as unknown as ScopeResolutionIndexes;
}

function fileAt(files: readonly ParsedFile[], filePath: string): ParsedFile {
  const file = files.find((candidate) => candidate.filePath === filePath);
  if (file === undefined) throw new Error(`no file ${filePath}`);
  return file;
}

const importCount = (files: readonly ParsedFile[]): number =>
  files.reduce((total, file) => total + file.parsedImports.length, 0);

const storedBindings = (indexes: ScopeResolutionIndexes): number =>
  [...indexes.namespaceFqnBindings.values()].reduce((total, table) => total + table.size, 0);

/** `leaves` files sharing `names` functions, one barrel exporting all of them,
 *  and `importers` files that each import the barrel. */
function barrelWorkspace(importers: number, names: number, leaves = 4): ParsedFile[] {
  const files: ParsedFile[] = [];
  const perLeaf = names / leaves;
  for (let leaf = 0; leaf < leaves; leaf++) {
    files.push(
      library(
        `leaf${leaf}.dart`,
        Array.from({ length: perLeaf }, (_, index) => `fn_${leaf}_${index}`),
      ),
    );
  }
  files.push(
    library(
      'barrel.dart',
      [],
      Array.from({ length: leaves }, (_, leaf) => exportOf(`leaf${leaf}.dart`)),
    ),
  );
  for (let importer = 0; importer < importers; importer++) {
    files.push(library(`user${importer}.dart`, [`use${importer}`], [plainImport('barrel.dart')]));
  }
  return files;
}

describe('Dart plain imports of a barrel', () => {
  it.each([
    { importers: 40, names: 160 },
    { importers: 40, names: 640 },
    { importers: 160, names: 160 },
  ])(
    'keeps one ParsedImport per directive for $importers importers of $names names',
    ({ importers, names }) => {
      const files = barrelWorkspace(importers, names);
      const before = importCount(files);
      populateDartLibraryExports(files, {});
      expect(before).toBe(4 + importers);
      expect(importCount(files)).toBe(before);
      expect(fileAt(files, 'user0.dart').parsedImports).toEqual([plainImport('barrel.dart')]);
    },
  );

  it.each([
    { importers: 40, names: 160 },
    { importers: 40, names: 640 },
    { importers: 160, names: 160 },
  ])('stores $names bindings for $importers importers of $names names', ({ importers, names }) => {
    const files = barrelWorkspace(importers, names);
    populateDartLibraryExports(files, {});
    const indexes = emptyIndexes();
    populateDartImportNamespaces(files, indexes);
    // One table, the barrel's namespace; its size is the export closure's.
    expect(indexes.namespaceFqnBindings.size).toBe(1);
    expect(storedBindings(indexes)).toBe(names);
    // Each importer lists that one namespace, and they all share the list.
    expect(indexes.accessibleNamespacesByScope.size).toBe(importers);
    expect(new Set(indexes.accessibleNamespacesByScope.values()).size).toBe(1);
  });

  it('turns an export directive into a side-effect import that binds no name', () => {
    const hideA: NameFilters = [{ kind: 'hide', names: ['a'] }];
    const files = [
      library('lib.dart', ['a', 'b']),
      library('facade.dart', ['own'], [exportOf('lib.dart', hideA), plainImport('lib.dart')]),
    ];
    populateDartLibraryExports(files, {});
    const facade = fileAt(files, 'facade.dart');
    expect(facade.parsedImports).toEqual([
      { ...exportOf('lib.dart', hideA), kind: 'side-effect' },
      plainImport('lib.dart'),
    ]);
    const indexes = emptyIndexes();
    populateDartImportNamespaces(files, indexes);
    // Only the plain import makes names visible inside the facade.
    expect(indexes.accessibleNamespacesByScope.get(facade.moduleScope)).toHaveLength(1);
    expect([...dartModuleExports(facade).keys()].sort()).toEqual(['b', 'own']);
  });

  it('stores one table per distinct combinator list of a library', () => {
    const files = [
      library('lib.dart', ['a', 'b', 'c', 'd']),
      library('plain1.dart', [], [plainImport('lib.dart')]),
      library('plain2.dart', [], [plainImport('lib.dart')]),
      library('show1.dart', [], [plainImport('lib.dart', [{ kind: 'show', names: ['a', 'b'] }])]),
      library('show2.dart', [], [plainImport('lib.dart', [{ kind: 'show', names: ['a', 'b'] }])]),
      library('hide.dart', [], [plainImport('lib.dart', [{ kind: 'hide', names: ['a'] }])]),
      library(
        'both.dart',
        [],
        [
          plainImport('lib.dart', [
            { kind: 'show', names: ['a', 'b', 'zzz'] },
            { kind: 'hide', names: ['b'] },
          ]),
        ],
      ),
    ];
    populateDartLibraryExports(files, {});
    const indexes = emptyIndexes();
    populateDartImportNamespaces(files, indexes);
    const namesSeenBy = (filePath: string): string[][] =>
      (indexes.accessibleNamespacesByScope.get(moduleScopeOf(filePath)) ?? []).map((namespace) =>
        [...(indexes.namespaceFqnBindings.get(namespace)?.keys() ?? [])].sort(),
      );
    expect(indexes.namespaceFqnBindings.size).toBe(4);
    expect(namesSeenBy('plain2.dart')).toEqual([['a', 'b', 'c', 'd']]);
    expect(namesSeenBy('show2.dart')).toEqual([['a', 'b']]);
    expect(namesSeenBy('hide.dart')).toEqual([['b', 'c', 'd']]);
    expect(namesSeenBy('both.dart')).toEqual([['a']]);
  });
});

describe('Dart names two imports of one file bring in', () => {
  const twoImports = (own: readonly string[]): { files: ParsedFile[]; importer: ScopeId } => {
    const files = [
      library('first.dart', ['shared', 'onlyFirst', 'clash']),
      library('second.dart', ['onlySecond', 'clash']),
      library('barrel.dart', [], [exportOf('first.dart', [{ kind: 'show', names: ['shared'] }])]),
      library(
        'app.dart',
        own,
        ['first.dart', 'second.dart', 'barrel.dart'].map((target) => plainImport(target)),
      ),
    ];
    populateDartLibraryExports(files, {});
    return { files, importer: moduleScopeOf('app.dart') };
  };
  const idsOf = (refs: readonly BindingRef[]): string[] => refs.map((ref) => ref.def.nodeId);

  it('binds one declaration once and two different declarations both', () => {
    const { files, importer } = twoImports([]);
    const indexes = emptyIndexes();
    populateDartImportNamespaces(files, indexes);
    // `shared` arrives from first.dart and again through the barrel.
    expect(idsOf(lookupBindingsAt(importer, 'shared', indexes))).toEqual(['def:first.dart:shared']);
    expect(idsOf(lookupBindingsAt(importer, 'onlySecond', indexes))).toEqual([
      'def:second.dart:onlySecond',
    ]);
    expect(idsOf(lookupBindingsAt(importer, 'clash', indexes))).toEqual([
      'def:first.dart:clash',
      'def:second.dart:clash',
    ]);
  });

  it("answers with the importing file's own declaration alone", () => {
    const { files, importer } = twoImports(['shared', 'clash']);
    const own = fileAt(files, 'app.dart').scopes[0].bindings;
    const indexes = {
      ...emptyIndexes(),
      // Finalize puts a file's own module-scope bindings in this channel.
      bindings: new Map([[importer, own]]),
    };
    populateDartImportNamespaces(files, indexes);
    expect(idsOf(lookupBindingsAt(importer, 'shared', indexes))).toEqual(['def:app.dart:shared']);
    expect(idsOf(lookupBindingsAt(importer, 'clash', indexes))).toEqual(['def:app.dart:clash']);
    expect(idsOf(lookupBindingsAt(importer, 'onlyFirst', indexes))).toEqual([
      'def:first.dart:onlyFirst',
    ]);
  });
});

/** `length` libraries where file i exports file i+1. */
function exportChain(length: number, namesOf: (index: number) => readonly string[]): ParsedFile[] {
  return Array.from({ length }, (_, index) =>
    library(
      `chain${index}.dart`,
      namesOf(index),
      index + 1 < length ? [exportOf(`chain${index + 1}.dart`)] : [],
    ),
  );
}

/** Only the last file of the chain declares names. */
const lastDeclares =
  (length: number, names: readonly string[]) =>
  (index: number): readonly string[] =>
    index === length - 1 ? names : [];

/** Every file of the chain declares one name of its own. */
const eachDeclaresOne = (index: number): readonly string[] => [`n${index}`];

function closureWork(files: ParsedFile[]): number {
  const work: DartExportClosureWork = { deliveries: 0 };
  populateDartLibraryExports(files, {}, work);
  return work.deliveries;
}

const exportedEntries = (files: readonly ParsedFile[]): number =>
  files.reduce((total, file) => total + dartModuleExports(file).size, 0);

describe('Dart export closure work', () => {
  it.each([250, 500, 1000])('delivers 3 names once per directive on a %i-file chain', (length) => {
    const files = exportChain(length, lastDeclares(length, ['a', 'b', 'c']));
    // Linear in the chain: 3 names x (length - 1) export directives.
    expect(closureWork(files)).toBe(3 * (length - 1));
    expect([...dartModuleExports(files[0]).keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it.each([250, 500, 1000])(
    'delivers each exported entry once when every file of a %i-file chain declares a name',
    (length) => {
      const files = exportChain(length, eachDeclaresOne);
      const deliveries = closureWork(files);
      // File i exports the names of files i..length-1: the output itself is
      // length x (length + 1) / 2 entries, and each entry a file did not
      // declare was delivered to it exactly once.
      expect(exportedEntries(files)).toBe((length * (length + 1)) / 2);
      expect(deliveries).toBe(exportedEntries(files) - length);
    },
  );

  it('does not depend on file order', () => {
    const forward = exportChain(60, eachDeclaresOne);
    const backward = exportChain(60, eachDeclaresOne).reverse();
    const forwardWork = closureWork(forward);
    const backwardWork = closureWork(backward);
    const closureOf = (files: readonly ParsedFile[]): string[] =>
      files
        .map((file) => `${file.filePath}: ${[...dartModuleExports(file).keys()].sort().join(',')}`)
        .sort();
    expect(closureOf(backward)).toEqual(closureOf(forward));
    expect(backwardWork).toBe(forwardWork);
  });

  it('settles a cycle within two deliveries per directive and name', () => {
    const size = 40;
    // A ring: file i exports file i+1, the last exports the first.
    const files = Array.from({ length: size }, (_, index) =>
      library(`ring${index}.dart`, [`n${index}`], [exportOf(`ring${(index + 1) % size}.dart`)]),
    );
    const deliveries = closureWork(files);
    expect(files.map((file) => dartModuleExports(file).size)).toEqual(
      Array.from({ length: size }, () => size),
    );
    expect(deliveries).toBeLessThanOrEqual(2 * size * size);
  });

  it('exports a name two different declarations reach from neither, through a later hop too', () => {
    const files = [
      library('one.dart', ['dup', 'fromOne']),
      library('two.dart', ['dup', 'fromTwo']),
      library('both.dart', [], [exportOf('one.dart'), exportOf('two.dart')]),
      library('outer.dart', [], [exportOf('both.dart')]),
      library(
        'picked.dart',
        [],
        [exportOf('one.dart'), exportOf('two.dart', [{ kind: 'hide', names: ['dup'] }])],
      ),
      // The same declaration through two directives is not a conflict.
      library('diamond.dart', [], [exportOf('one.dart'), exportOf('picked.dart')]),
    ];
    populateDartLibraryExports(files, {});
    const exportsOf = (filePath: string): string[] =>
      [...dartModuleExports(fileAt(files, filePath))]
        .map(([name, def]) => `${name}=${def.filePath}`)
        .sort();
    expect(exportsOf('both.dart')).toEqual(['fromOne=one.dart', 'fromTwo=two.dart']);
    expect(exportsOf('outer.dart')).toEqual(['fromOne=one.dart', 'fromTwo=two.dart']);
    expect(exportsOf('picked.dart')).toEqual([
      'dup=one.dart',
      'fromOne=one.dart',
      'fromTwo=two.dart',
    ]);
    expect(exportsOf('diamond.dart')).toEqual([
      'dup=one.dart',
      'fromOne=one.dart',
      'fromTwo=two.dart',
    ]);
  });
});

describe('Dart library facts on a copied ParsedFile', () => {
  it('answers the export closure and the export-only veto from a scope-stripped copy', () => {
    const files = [
      library('leaf.dart', ['make']),
      library('facade.dart', ['run'], [exportOf('leaf.dart')]),
      library('both.dart', ['go'], [exportOf('leaf.dart'), plainImport('leaf.dart')]),
    ];
    populateDartLibraryExports(files, {});
    const candidate = topLevel('leaf.dart', 'make');
    // Disk scope mode hands the name fallback copies like these.
    const [, facade, both] = files.map((file): ParsedFile => ({ ...file, scopes: [] }));
    expect([...dartModuleExports(facade).keys()].sort()).toEqual(['make', 'run']);
    expect(dartIsGlobalNameFallbackPlausible({ callerParsed: facade, candidate })).toBe(false);
    // A file that also imports the library does bind the name.
    expect(dartIsGlobalNameFallbackPlausible({ callerParsed: both, candidate })).toBe(true);
  });
});
