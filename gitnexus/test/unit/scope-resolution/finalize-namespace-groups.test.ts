import { describe, expect, it } from 'vitest';
import {
  finalize,
  type FinalizeFile,
  type FinalizeHooks,
  type FinalizeOutput,
  type ImportEdge,
  type ImportEntry,
  type ParsedImport,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { prng } from '../../helpers/import-visibility-contract.js';

/**
 * `FinalizeHooks.groupedImportKinds` lets a namespace import (`import X` of a
 * multi-file module) be stored as groups over its list of files: the files
 * through which the statement binds nothing are grouped, and a file whose
 * export the name binds keeps its own edge. Like a grouped wildcard, it changes
 * how the statement is stored, never what finalize answers: every case runs
 * the same input with grouping on and off, and the groups, written out one
 * edge per file, must be exactly the edges finalize produced without them.
 */

interface Workspace {
  readonly name: string;
  readonly files: readonly FinalizeFile[];
  /** module name → the one array every importer of that module receives. */
  readonly modules: ReadonlyMap<string, readonly string[]>;
}

const NAMESPACE = new Set<ParsedImport['kind']>(['namespace']);
const moduleScope = (filePath: string): ScopeId => `scope:${filePath}#module` as ScopeId;
const type = (filePath: string, name: string): SymbolDefinition => ({
  nodeId: `def:${filePath}:${name}`,
  filePath,
  type: 'Class',
  qualifiedName: name,
});
const member = (filePath: string, owner: string, name: string): SymbolDefinition => ({
  nodeId: `def:${filePath}:${owner}.${name}`,
  filePath,
  type: 'Method',
  qualifiedName: `${owner}.${name}`,
});
const at = (line: number) => ({ startLine: line, startCol: 0, endLine: line, endCol: 30 });
const namespace = (module: string, line: number, extra: object = {}): ParsedImport =>
  ({
    kind: 'namespace',
    localName: module,
    importedName: module,
    targetRaw: `mod:${module}`,
    atRange: at(line),
    ...extra,
  }) as ParsedImport;
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

/** A provider whose `import X` names a module: every importer gets the same list. */
const hooks = (workspace: Workspace, overrides: Partial<FinalizeHooks> = {}): FinalizeHooks => ({
  resolveImportTarget: (targetRaw) =>
    targetRaw.startsWith('mod:')
      ? (workspace.modules.get(targetRaw.slice(4)) ?? null)
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
    hooks(workspace, {
      groupedImportKinds: NAMESPACE,
      ...overrides,
      groupsWildcardTargets: grouped,
    }),
  );
  return { output, phases };
}

const isGroup = (entry: ImportEntry): entry is Extract<ImportEntry, { targetFiles: unknown }> =>
  'targetFiles' in entry;

/** A group's statement edge as one of its per-file edges: without the marker. */
function perFile(edge: ImportEdge): ImportEdge {
  const { groupsFiles: _marker, ...rest } = edge;
  return rest;
}

/** Each scope's imports with every group written out as the per-file edges it
 *  stands for: what finalize stores without grouping. */
function writtenOut(workspace: Workspace, output: FinalizeOutput): Map<ScopeId, ImportEdge[]> {
  const known = new Set(workspace.files.map((file) => file.filePath));
  const entries = output.importEntries ?? output.imports;
  return new Map(
    [...entries].map(([scope, list]) => [
      scope,
      list.flatMap((entry): ImportEdge[] =>
        isGroup(entry)
          ? entry.targetFiles.map((targetFile) => ({
              ...perFile(entry.via),
              targetFile,
              ...(known.has(targetFile) ? { targetModuleScope: moduleScope(targetFile) } : {}),
            }))
          : [entry],
      ),
    ]),
  );
}

/** Everything finalize answers, with imports in their written-out form. */
function observed(workspace: Workspace, result: ReturnType<typeof run>) {
  return {
    phases: result.phases,
    sccs: result.output.sccs,
    stats: result.output.stats,
    bindings: [...result.output.bindings].map(([scope, byName]) => [scope, [...byName]]),
    imports: [...writtenOut(workspace, result.output)],
  };
}

const groupsIn = (output: FinalizeOutput): number =>
  [...(output.importEntries?.values() ?? [])].flat().filter(isGroup).length;
const edgesIn = (output: FinalizeOutput): number => [...output.imports.values()].flat().length;

const DTO = ['DTO/One.swift', 'DTO/Two.swift', 'DTO/Three.swift'];
const NET = ['Net/Client.swift', 'Net/Session.swift'];
const lexical = (scope: string) => ({
  bindsAtLexicalScope: true,
  declaredAtScope: scope as ScopeId,
});
const files = (paths: readonly string[]) =>
  paths.map((path) => source(path, [path.slice(path.indexOf('/') + 1, -6)], []));

const workspaces: readonly Workspace[] = [
  {
    name: 'one importer of one module',
    modules: new Map([['DTO', DTO]]),
    files: [...files(DTO), source('App/View.swift', ['View'], [namespace('DTO', 1)])],
  },
  {
    name: 'explicit imports interleaved with two module imports, one written twice',
    modules: new Map([
      ['DTO', DTO],
      ['Net', NET],
    ]),
    files: [
      ...files(DTO),
      ...files(NET),
      source(
        'App/View.swift',
        ['View'],
        [
          named('One', 'DTO/One.swift', 1),
          namespace('Net', 2),
          named('Gone', 'missing/Gone.swift', 3),
          namespace('DTO', 4),
          namespace('Net', 5),
          named('Two', 'DTO/Two.swift', 6),
        ],
      ),
    ],
  },
  {
    name: 'a file whose module list contains the file itself',
    modules: new Map([['App', ['App/View.swift', 'App/Other.swift']]]),
    files: [
      source('App/View.swift', ['View'], [namespace('App', 1)]),
      source('App/Other.swift', ['Other'], []),
    ],
  },
  {
    name: 'two modules that import each other form one cycle',
    modules: new Map([
      ['A', ['A/A.swift', 'A/A2.swift']],
      ['B', ['B/B.swift']],
    ]),
    files: [
      source('A/A.swift', ['A1'], [namespace('B', 1)]),
      source('A/A2.swift', ['A2'], []),
      source('B/B.swift', ['B1'], [namespace('A', 1), named('A1', 'A/A.swift', 2)]),
    ],
  },
  {
    name: 'a module list that names a file outside the workspace',
    modules: new Map([['DTO', ['DTO/One.swift', 'external/Ghost.swift']]]),
    files: [
      source('DTO/One.swift', ['One'], []),
      source('App/View.swift', ['View'], [namespace('DTO', 1)]),
    ],
  },
  {
    name: 'a module import bound at a lexical scope, alone and beside a module-scope one',
    modules: new Map([
      ['DTO', DTO],
      ['Net', NET],
    ]),
    files: [
      ...files(DTO),
      ...files(NET),
      source(
        'App/View.swift',
        ['View'],
        [namespace('DTO', 1), namespace('Net', 9, lexical('scope:App/View.swift#fn'))],
      ),
      source(
        'App/Other.swift',
        ['Other'],
        [namespace('DTO', 4, lexical('scope:App/Other.swift#fn'))],
      ),
    ],
  },
  {
    name: 'presence flags, an explicit alias and name filters on a module import',
    modules: new Map([['DTO', DTO]]),
    files: [
      ...files(DTO),
      source(
        'App/View.swift',
        ['View'],
        [
          namespace('DTO', 1, { runsOnlyWhenCalled: true }),
          namespace('DTO', 2, { localName: 'D', explicitAlias: true }),
          namespace('DTO', 3, { nameFilters: { kind: 'show', names: ['One'] } }),
        ],
      ),
    ],
  },
  {
    name: 'a module with no files and an import that resolves to nothing',
    modules: new Map([['Empty', []]]),
    files: [source('App/View.swift', ['View'], [namespace('Empty', 1), namespace('Unknown', 2)])],
  },
];

/** Same seed, same workspace. Small universe, so every shape above recurs. */
function generated(seed: number): Workspace {
  const next = prng(seed);
  const pick = (count: number): number => Math.floor(next() * count);
  const moduleNames = ['M0', 'M1', 'M2', 'M3'];
  const paths = Array.from(
    { length: 4 + pick(8) },
    (_, i) => `${moduleNames[pick(4)]}/F${i}.swift`,
  );
  const modules = new Map(
    moduleNames.map((module) => [
      module,
      [
        ...paths.filter((path) => path.startsWith(`${module}/`)),
        ...(pick(5) === 0 ? ['external/X.swift'] : []),
      ],
    ]),
  );
  const workspaceFiles = paths.map((path, i) => {
    const file = source(
      path,
      // A file declaring a type named after a module makes that module's import bind.
      [`T${i}`, ...(pick(4) === 0 ? [moduleNames[pick(4)]!] : [])],
      Array.from({ length: pick(6) }, (_, line): ParsedImport => {
        const shape = pick(5);
        return shape < 3
          ? namespace(moduleNames[pick(4)]!, line, pick(4) === 0 ? lexical(`scope:${path}#fn`) : {})
          : shape === 3
            ? named(`T${pick(paths.length)}`, paths[pick(paths.length)]!, line)
            : named('Gone', 'missing/Gone.swift', line);
      }),
    );
    // A member named after a module binds its import only for a language
    // whose imports also bind members (`namedImportsBindTopLevelOnly` unset).
    return pick(5) === 0
      ? { ...file, localDefs: [...file.localDefs, member(path, `T${i}`, moduleNames[pick(4)]!)] }
      : file;
  });
  return { name: `generated workspace, seed ${seed}`, files: workspaceFiles, modules };
}

const generatedWorkspaces = Array.from({ length: 80 }, (_, i) => generated(7000 + i));

describe('finalize: grouped namespace imports change storage, not answers', () => {
  it.each([...workspaces, ...generatedWorkspaces])('$name', (workspace) => {
    expect(observed(workspace, run(workspace, true))).toEqual(
      observed(workspace, run(workspace, false)),
    );
  });

  it('stores one group per statement and no edge per module file', () => {
    const workspace = workspaces[0]!;
    const off = run(workspace, false).output;
    const on = run(workspace, true).output;
    expect([edgesIn(off), groupsIn(off)]).toEqual([DTO.length, 0]);
    expect([edgesIn(on), groupsIn(on)]).toEqual([0, 1]);
  });

  it('keeps the list the resolver returned, by reference, with the statement as `via`', () => {
    const entries = [...(run(workspaces[0]!, true).output.importEntries?.values() ?? [])].flat();
    expect(entries).toHaveLength(1);
    const group = entries[0] as Extract<ImportEntry, { targetFiles: unknown }>;
    expect(group.targetFiles).toBe(DTO);
    expect(group.via).toMatchObject({ kind: 'namespace', localName: 'DTO', targetFile: null });
  });

  it('keeps statement order next to per-file edges', () => {
    const output = run(workspaces[1]!, true).output;
    const entries = output.importEntries?.get(moduleScope('App/View.swift')) ?? [];
    expect(
      entries.map((entry) => (isGroup(entry) ? `group ${entry.via.localName}` : entry.localName)),
    ).toEqual(['One', 'group Net', 'Gone', 'group DTO', 'group Net', 'Two']);
  });

  it('leaves namespace imports ungrouped under the default kinds', () => {
    const workspace = workspaces[0]!;
    const output = run(workspace, true, { groupedImportKinds: undefined }).output;
    expect(output.importEntries).toBeUndefined();
    expect(edgesIn(output)).toBe(DTO.length);
  });

  it('exercises groups, bound imports and cycles in the generated workspaces', () => {
    const results = generatedWorkspaces.map((workspace) => run(workspace, true));
    expect(results.filter((result) => groupsIn(result.output) > 0).length).toBeGreaterThan(50);
    // Some module imports must stay per-file edges because a target binds them.
    expect(
      generatedWorkspaces.filter((workspace) =>
        [...run(workspace, true).output.imports.values()]
          .flat()
          .some((edge) => edge.kind === 'namespace' && edge.targetDefId !== undefined),
      ).length,
    ).toBeGreaterThan(5);
    expect(
      results.filter((result) => result.output.sccs.some((scc) => scc.isCycle)).length,
    ).toBeGreaterThan(10);
  });

  it.each([
    ['first', 0, ['edge DTO/One.swift', 'group DTO/Two.swift,DTO/Three.swift']],
    ['middle', 1, ['group DTO/One.swift', 'edge DTO/Two.swift', 'group DTO/Three.swift']],
    ['last', 2, ['group DTO/One.swift,DTO/Two.swift', 'edge DTO/Three.swift']],
  ] as const)(
    'keeps a per-file edge only for the file that exports the module name (%s file)',
    (_where, at, expected) => {
      const workspace: Workspace = {
        name: 'module type named after the module',
        modules: new Map([['DTO', DTO]]),
        files: [
          ...DTO.map((path, i) =>
            source(path, [path.slice(4, -6), ...(i === at ? ['DTO'] : [])], []),
          ),
          source('App/View.swift', ['View'], [namespace('DTO', 1)]),
          source('App/Other.swift', ['Other'], [namespace('DTO', 1)]),
        ],
      };
      const on = run(workspace, true);
      expect(observed(workspace, on)).toEqual(observed(workspace, run(workspace, false)));
      const entriesOf = (file: string) =>
        (on.output.importEntries?.get(moduleScope(file)) ?? []).map((entry) =>
          isGroup(entry) ? `group ${entry.targetFiles.join(',')}` : `edge ${entry.targetFile}`,
        );
      expect(entriesOf('App/View.swift')).toEqual(expected);
      // The runs are shared by every importer of the module, not copied.
      const runs = (file: string) =>
        (on.output.importEntries?.get(moduleScope(file)) ?? []).filter(isGroup);
      runs('App/View.swift').forEach((group, i) =>
        expect(group.targetFiles).toBe(runs('App/Other.swift')[i]!.targetFiles),
      );
      // The binding the exporting file's edge creates is still there.
      expect(
        [...(on.output.bindings.get(moduleScope('App/View.swift'))?.get('DTO') ?? [])].map(
          (ref) => ref.origin,
        ),
      ).toEqual(['namespace']);
    },
  );

  it('stores at most 2k + 1 entries for a statement whose name k files export', () => {
    let split = 0;
    for (const workspace of [...workspaces, ...generatedWorkspaces]) {
      const output = run(workspace, true).output;
      const byPath = new Map(workspace.files.map((file) => [file.filePath, file]));
      for (const file of workspace.files) {
        for (const parsed of file.parsedImports) {
          if (parsed.kind !== 'namespace') continue;
          const scope = (parsed.declaredAtScope ?? file.moduleScope) as ScopeId;
          const entries = (output.importEntries ?? output.imports).get(scope) ?? [];
          const mine = entries.filter((entry) =>
            isGroup(entry)
              ? entry.via.atRange?.startLine === parsed.atRange?.startLine &&
                entry.via.localName === parsed.localName
              : entry.atRange?.startLine === parsed.atRange?.startLine &&
                entry.localName === parsed.localName,
          );
          const list = workspace.modules.get(parsed.importedName) ?? [];
          const exporting = list.filter((path) =>
            byPath
              .get(path)
              ?.localDefs.some(
                (def) => (def.qualifiedName ?? '').split('.').pop() === parsed.importedName,
              ),
          ).length;
          if (!mine.some(isGroup)) continue;
          if (exporting > 0) split++;
          expect(mine.length).toBeLessThanOrEqual(2 * exporting + 1);
          expect(mine.filter((entry) => !isGroup(entry))).toHaveLength(exporting);
        }
      }
    }
    // The generator must exercise statements that are part group, part edge.
    expect(split).toBeGreaterThan(20);
  });
});
