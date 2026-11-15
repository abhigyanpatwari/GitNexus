import { describe, expect, it } from 'vitest';
import {
  createEagerImportVisibility,
  createGroupedImportVisibility,
  finalize,
  importTargetDirectory,
  type FinalizeFile,
  type FinalizeHooks,
  type FinalizeOutput,
  type ImportEntry,
  type ParsedImport,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { observeAsked, prng } from '../../helpers/import-visibility-contract.js';

/**
 * `FinalizeHooks.groupsWildcardTargets` changes how a wildcard import is
 * stored, never what finalize answers. Every case below runs the same input
 * twice, hook off and hook on, and compares everything a consumer can observe.
 */

interface Workspace {
  readonly name: string;
  readonly files: readonly FinalizeFile[];
  /** package name → the one array every importer of that package receives. */
  readonly packages: ReadonlyMap<string, readonly string[]>;
}

const moduleScope = (filePath: string): ScopeId => `scope:${filePath}#module` as ScopeId;
const type = (filePath: string, name: string): SymbolDefinition => ({
  nodeId: `def:${filePath}:${name}`,
  filePath,
  type: 'Class',
  qualifiedName: name,
});
const at = (line: number) => ({ startLine: line, startCol: 0, endLine: line, endCol: 30 });
const wildcard = (pkg: string, line: number, extra: object = {}): ParsedImport =>
  ({ kind: 'wildcard', targetRaw: `pkg:${pkg}`, atRange: at(line), ...extra }) as ParsedImport;
const named = (name: string, targetRaw: string, line: number): ParsedImport =>
  ({
    kind: 'named',
    localName: name,
    importedName: name,
    targetRaw,
    atRange: at(line),
  }) as ParsedImport;
const source = (
  filePath: string,
  names: readonly string[],
  imports: readonly ParsedImport[],
): FinalizeFile => ({
  filePath,
  moduleScope: moduleScope(filePath),
  localDefs: names.map((name) => type(filePath, name)),
  parsedImports: imports,
});

/** A provider whose wildcard names a package: every importer gets the same list. */
const hooks = (workspace: Workspace, overrides: Partial<FinalizeHooks> = {}): FinalizeHooks => ({
  resolveImportTarget: (targetRaw) =>
    targetRaw.startsWith('pkg:')
      ? (workspace.packages.get(targetRaw.slice(4)) ?? null)
      : workspace.files.some((file) => file.filePath === targetRaw)
        ? targetRaw
        : null,
  expandsWildcardTo: () => [],
  mergeBindings: (existing, incoming) => [...existing, ...incoming],
  ...overrides,
});

function run(workspace: Workspace, grouped: boolean, overrides: Partial<FinalizeHooks> = {}) {
  const phases: string[] = [];
  const output = finalize(
    {
      files: workspace.files,
      workspaceIndex: undefined as never,
      onProgress: (phase) => phases.push(phase),
    },
    hooks(workspace, { ...overrides, groupsWildcardTargets: grouped }),
  );
  return { output, phases };
}

const visibilityOf = (output: FinalizeOutput) =>
  output.importEntries === undefined
    ? createEagerImportVisibility(output.imports)
    : createGroupedImportVisibility(output.importEntries, output.imports);

/** Everything a consumer can observe about one finalize result. */
function observed(workspace: Workspace, result: ReturnType<typeof run>) {
  const files = [
    ...new Set([
      ...workspace.files.map((file) => file.filePath),
      ...[...workspace.packages.values()].flat(),
      'never/Imported.java',
    ]),
  ];
  const scopes = [...new Set([...result.output.imports.keys(), 'scope:absent' as ScopeId])];
  return {
    phases: result.phases,
    sccs: result.output.sccs,
    stats: result.output.stats,
    bindings: [...result.output.bindings].map(([scope, byName]) => [scope, [...byName]]),
    visibility: observeAsked(
      { scopes, files, directories: [...new Set(files.map(importTargetDirectory))] },
      visibilityOf(result.output),
    ),
  };
}

const groupsIn = (output: FinalizeOutput): number =>
  [...(output.importEntries?.values() ?? [])]
    .flat()
    .filter((entry: ImportEntry) => 'targetFiles' in entry).length;
const edgesIn = (output: FinalizeOutput): number => [...output.imports.values()].flat().length;

const PKG_A = ['a/One.java', 'a/Two.java', 'a/Three.java'];
const PKG_B = ['b/One.java', 'b/Four.java'];
const lexical = (scope: string) => ({
  bindsAtLexicalScope: true,
  declaredAtScope: scope as ScopeId,
});

const workspaces: readonly Workspace[] = [
  {
    name: 'one importer of one package',
    packages: new Map([['a', PKG_A]]),
    files: [
      ...PKG_A.map((path) => source(path, [path.slice(2, -5)], [])),
      source('app/U.java', ['U'], [wildcard('a', 1)]),
    ],
  },
  {
    name: 'explicit imports interleaved with two wildcards, one written twice',
    packages: new Map([
      ['a', PKG_A],
      ['b', PKG_B],
    ]),
    files: [
      ...PKG_A.map((path) => source(path, [path.slice(2, -5)], [])),
      ...PKG_B.map((path) => source(path, [path.slice(2, -5)], [])),
      source(
        'app/U.java',
        ['U'],
        [
          named('One', 'a/One.java', 1),
          wildcard('b', 2),
          named('Gone', 'missing/Gone.java', 3),
          wildcard('a', 4),
          wildcard('b', 5),
          named('Two', 'a/Two.java', 6),
        ],
      ),
    ],
  },
  {
    name: 'a file that imports its own package is a self-cycle',
    packages: new Map([['app', ['app/U.java', 'app/V.java']]]),
    files: [source('app/U.java', ['U'], [wildcard('app', 1)]), source('app/V.java', ['V'], [])],
  },
  {
    name: 'two packages that import each other form one cycle',
    packages: new Map([
      ['a', ['a/A.java', 'a/A2.java']],
      ['b', ['b/B.java']],
    ]),
    files: [
      source('a/A.java', ['A'], [wildcard('b', 1)]),
      source('a/A2.java', ['A2'], []),
      source('b/B.java', ['B'], [wildcard('a', 1), named('A', 'a/A.java', 2)]),
    ],
  },
  {
    name: 'a package list that names a file outside the workspace',
    packages: new Map([['a', ['a/One.java', 'external/Ghost.java']]]),
    files: [source('a/One.java', ['One'], []), source('app/U.java', ['U'], [wildcard('a', 1)])],
  },
  {
    name: 'a wildcard bound at a lexical scope, alone and beside a module wildcard',
    packages: new Map([
      ['a', PKG_A],
      ['b', PKG_B],
    ]),
    files: [
      ...PKG_A.map((path) => source(path, [path.slice(2, -5)], [])),
      ...PKG_B.map((path) => source(path, [path.slice(2, -5)], [])),
      source(
        'app/U.java',
        ['U'],
        [wildcard('a', 1), wildcard('b', 9, lexical('scope:app/U.java#fn'))],
      ),
      source('app/V.java', ['V'], [wildcard('a', 4, lexical('scope:app/V.java#fn'))]),
    ],
  },
  {
    name: 'a named import that only resolves through its target wildcard (re-export closure)',
    packages: new Map([['a', PKG_A]]),
    files: [
      ...PKG_A.map((path) => source(path, [path.slice(2, -5)], [])),
      source('hub/Hub.java', ['Hub'], [wildcard('a', 1)]),
      source(
        'app/U.java',
        ['U'],
        [named('Two', 'hub/Hub.java', 1), named('Nope', 'hub/Hub.java', 2)],
      ),
    ],
  },
  {
    name: 'presence flags on a wildcard',
    packages: new Map([['a', PKG_A]]),
    files: [
      ...PKG_A.map((path) => source(path, [path.slice(2, -5)], [])),
      source('app/U.java', ['U'], [wildcard('a', 1, { runsOnlyWhenCalled: true })]),
    ],
  },
  {
    name: 'a package with no files and an import that resolves to nothing',
    packages: new Map([['empty', []]]),
    files: [source('app/U.java', ['U'], [wildcard('empty', 1), wildcard('unknown', 2)])],
  },
];

/** Same seed, same workspace. Small universe, so every shape above recurs. */
function generated(seed: number): Workspace {
  const next = prng(seed);
  const pick = (count: number): number => Math.floor(next() * count);
  const packageNames = ['p0', 'p1', 'p2', 'p3'];
  const paths = Array.from(
    { length: 4 + pick(8) },
    (_, i) => `${packageNames[pick(4)]}/F${i}.java`,
  );
  const packages = new Map(
    packageNames.map((pkg) => [
      pkg,
      [
        ...paths.filter((path) => path.startsWith(`${pkg}/`)),
        ...(pick(5) === 0 ? ['external/X.java'] : []),
      ],
    ]),
  );
  const files = paths.map((path, i) =>
    source(
      path,
      [`T${i}`, ...(pick(3) === 0 ? ['Shared'] : [])],
      Array.from({ length: pick(6) }, (_, line): ParsedImport => {
        const shape = pick(6);
        return shape < 3
          ? wildcard(packageNames[pick(4)]!, line, pick(4) === 0 ? lexical(`scope:${path}#fn`) : {})
          : shape === 3
            ? named(`T${pick(paths.length)}`, paths[pick(paths.length)]!, line)
            : shape === 4
              ? named('Shared', paths[pick(paths.length)]!, line)
              : named('Gone', 'missing/Gone.java', line);
      }),
    ),
  );
  return { name: `generated workspace, seed ${seed}`, files, packages };
}

const generatedWorkspaces = Array.from({ length: 80 }, (_, i) => generated(5000 + i));

describe('finalize: grouped wildcard imports change storage, not answers', () => {
  it.each([...workspaces, ...generatedWorkspaces])('$name', (workspace) => {
    expect(observed(workspace, run(workspace, true))).toEqual(
      observed(workspace, run(workspace, false)),
    );
  });

  it('stores one group per statement and no edge per package file', () => {
    const workspace = workspaces[0]!;
    const off = run(workspace, false).output;
    const on = run(workspace, true).output;
    expect([edgesIn(off), groupsIn(off)]).toEqual([PKG_A.length, 0]);
    expect([edgesIn(on), groupsIn(on)]).toEqual([0, 1]);
  });

  it('keeps the list the resolver returned, by reference', () => {
    const workspace = workspaces[0]!;
    const entries = [...(run(workspace, true).output.importEntries?.values() ?? [])].flat();
    expect(entries).toHaveLength(1);
    expect((entries[0] as { targetFiles: readonly string[] }).targetFiles).toBe(PKG_A);
  });

  it('reports no entries at all when nothing was grouped', () => {
    expect(run(workspaces[8]!, true).output.importEntries).toBeUndefined();
    expect(run(workspaces[0]!, false).output.importEntries).toBeUndefined();
  });

  it('builds re-export closures in the same case with the hook on and off', () => {
    const workspace = workspaces[6]!;
    expect(run(workspace, true).phases).toContain('reexports-start');
    expect(run(workspace, false).phases).toContain('reexports-start');
  });

  it('exercises groups, cycles and closures in the generated workspaces', () => {
    const results = generatedWorkspaces.map((workspace) => run(workspace, true));
    expect(results.filter((result) => groupsIn(result.output) > 0).length).toBeGreaterThan(60);
    expect(
      results.filter((result) => result.output.sccs.some((scc) => scc.isCycle)).length,
    ).toBeGreaterThan(10);
    expect(
      results.filter((result) => result.phases.includes('reexports-start')).length,
    ).toBeGreaterThan(5);
  });

  describe('a statement that could be told apart keeps one edge per file', () => {
    const workspace = workspaces[1]!;
    const cases: readonly { readonly name: string; readonly overrides: Partial<FinalizeHooks> }[] =
      [
        {
          name: 'a target whose wildcard binds a name',
          overrides: { expandsWildcardTo: () => ['One'] },
        },
        {
          name: 'a provider that filters wildcard names',
          overrides: { filterWildcardNames: (_scope, names) => names },
        },
        {
          name: 'a provider whose wildcard collisions are ambiguous',
          overrides: { wildcardCollisionIsAmbiguous: true },
        },
        {
          name: 'a target reclassified as a namespace import',
          overrides: { isNamespaceImport: () => true },
        },
      ];
    it.each(cases)('$name', ({ overrides }) => {
      const on = run(workspace, true, overrides);
      const off = run(workspace, false, overrides);
      expect(on.output.importEntries).toBeUndefined();
      expect(on.output.imports).toEqual(off.output.imports);
      expect(observed(workspace, on)).toEqual(observed(workspace, off));
    });
  });
});
