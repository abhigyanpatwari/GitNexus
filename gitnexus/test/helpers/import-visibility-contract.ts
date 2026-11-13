/**
 * The contract every `ImportVisibility` implementation must satisfy.
 *
 * A relation is written the way source writes it: per scope, an ordered list
 * of import statements, each with the files it resolves to. The reference
 * answers below are computed from that description alone, so they do not
 * depend on how any implementation stores it. To check an implementation, build
 * it from each relation in `namedRelations` and `generatedRelations` and compare
 * `observeVisibility` with `expectedVisibility`.
 */
import type { ImportEdge, ImportVisibility, ScopeId } from 'gitnexus-shared';
import { importTargetDirectory, isSelectableImport } from 'gitnexus-shared';

/** One import statement: how it is written, and the files it resolves to.
 *  `null` is a target that did not resolve to a file. */
export interface ImportStatement {
  readonly edge: Omit<ImportEdge, 'targetFile'>;
  readonly targets: readonly (string | null)[];
}

export interface ImportRelation {
  readonly name: string;
  readonly scopes: readonly {
    readonly id: ScopeId;
    readonly statements: readonly ImportStatement[];
  }[];
  /** Scopes and files to ask about, beyond those the relation mentions. */
  readonly probeScopes: readonly ScopeId[];
  readonly probeFiles: readonly string[];
}

/** What a consumer can observe about one visited target. */
export interface ObservedTarget {
  readonly targetFile: string;
  readonly kind: ImportEdge['kind'];
  readonly localName: string;
  readonly atRange: ImportEdge['atRange'];
  readonly typeOnly: ImportEdge['typeOnly'];
  readonly runsOnlyWhenCalled: ImportEdge['runsOnlyWhenCalled'];
}

export interface ObservedVisibility {
  readonly scopes: readonly ScopeId[];
  /** Whether finalize recorded the scope at all (`edgesAt` defined). */
  readonly recorded: Readonly<Record<string, boolean>>;
  /** Every import a reader can select by name, definition or kind, in order. */
  readonly selectable: Readonly<Record<string, readonly ImportEdge[]>>;
  readonly targets: Readonly<Record<string, readonly ObservedTarget[]>>;
  readonly reaches: Readonly<Record<string, readonly string[]>>;
  readonly membership: Readonly<Record<string, readonly string[]>>;
  readonly reachesDirectory: Readonly<Record<string, readonly string[]>>;
  readonly hasOtherThan: Readonly<Record<string, readonly string[]>>;
}

/** Every edge one statement stands for, one per target, in target order. */
export function edgesOfStatement(statement: ImportStatement): ImportEdge[] {
  return statement.targets.map((targetFile) => ({ ...statement.edge, targetFile }));
}

/** The relation as the per-scope edge lists finalize has always produced. */
export function edgeMapOf(relation: ImportRelation): Map<ScopeId, readonly ImportEdge[]> {
  return new Map(
    relation.scopes.map((scope) => [scope.id, scope.statements.flatMap(edgesOfStatement)]),
  );
}

/** The scopes, files and directories to ask an implementation about. */
export interface VisibilityQuestions {
  readonly scopes: readonly ScopeId[];
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

function questions(relation: ImportRelation): VisibilityQuestions {
  const files = new Set<string>(relation.probeFiles);
  for (const scope of relation.scopes)
    for (const statement of scope.statements)
      for (const target of statement.targets) if (target !== null) files.add(target);
  return {
    scopes: [...new Set([...relation.scopes.map((scope) => scope.id), ...relation.probeScopes])],
    files: [...files],
    directories: [...new Set([...files].map(importTargetDirectory))],
  };
}

/** The answers the description of the relation requires. */
export function expectedVisibility(relation: ImportRelation): ObservedVisibility {
  const asked = questions(relation);
  const targetsOf = (id: ScopeId): ObservedTarget[] =>
    (relation.scopes.find((scope) => scope.id === id)?.statements ?? []).flatMap((statement) =>
      statement.targets.flatMap((targetFile) =>
        targetFile === null
          ? []
          : [
              {
                targetFile,
                kind: statement.edge.kind,
                localName: statement.edge.localName,
                atRange: statement.edge.atRange,
                typeOnly: statement.edge.typeOnly,
                runsOnlyWhenCalled: statement.edge.runsOnlyWhenCalled,
              },
            ],
      ),
    );
  const reached = (id: ScopeId): readonly string[] =>
    asked.files.filter((file) => targetsOf(id).some((target) => target.targetFile === file));
  const statementsOf = (id: ScopeId): readonly ImportStatement[] | undefined =>
    relation.scopes.find((scope) => scope.id === id)?.statements;
  return {
    scopes: relation.scopes.map((scope) => scope.id),
    recorded: Object.fromEntries(asked.scopes.map((id) => [id, statementsOf(id) !== undefined])),
    selectable: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        (statementsOf(id) ?? []).flatMap(edgesOfStatement).filter(isSelectableImport),
      ]),
    ),
    targets: Object.fromEntries(asked.scopes.map((id) => [id, targetsOf(id)])),
    reaches: Object.fromEntries(asked.scopes.map((id) => [id, reached(id)])),
    membership: Object.fromEntries(asked.scopes.map((id) => [id, reached(id)])),
    reachesDirectory: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        asked.directories.filter((directory) =>
          targetsOf(id).some((target) => importTargetDirectory(target.targetFile) === directory),
        ),
      ]),
    ),
    hasOtherThan: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        asked.files.filter((file) => targetsOf(id).some((target) => target.targetFile !== file)),
      ]),
    ),
  };
}

/** The answers an implementation gives to the same questions. */
export function observeVisibility(
  relation: ImportRelation,
  visibility: ImportVisibility,
): ObservedVisibility {
  return observeAsked(questions(relation), visibility);
}

/** The answers an implementation gives to an explicit set of questions. */
export function observeAsked(
  asked: VisibilityQuestions,
  visibility: ImportVisibility,
): ObservedVisibility {
  const visit = (id: ScopeId): ObservedTarget[] => {
    const seen: ObservedTarget[] = [];
    visibility.forEachTarget(id, (targetFile, via) =>
      seen.push({
        targetFile,
        kind: via.kind,
        localName: via.localName,
        atRange: via.atRange,
        typeOnly: via.typeOnly,
        runsOnlyWhenCalled: via.runsOnlyWhenCalled,
      }),
    );
    return seen;
  };
  return {
    scopes: [...visibility.scopes()],
    recorded: Object.fromEntries(
      asked.scopes.map((id) => [id, visibility.edgesAt(id) !== undefined]),
    ),
    selectable: Object.fromEntries(
      asked.scopes.map((id) => [id, (visibility.edgesAt(id) ?? []).filter(isSelectableImport)]),
    ),
    targets: Object.fromEntries(asked.scopes.map((id) => [id, visit(id)])),
    reaches: Object.fromEntries(
      asked.scopes.map((id) => [id, asked.files.filter((file) => visibility.reaches(id, file))]),
    ),
    membership: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        asked.files.filter((file) => visibility.membership(id).has(file)),
      ]),
    ),
    reachesDirectory: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        asked.directories.filter((directory) => visibility.reachesDirectory(id, directory)),
      ]),
    ),
    hasOtherThan: Object.fromEntries(
      asked.scopes.map((id) => [
        id,
        asked.files.filter((file) => visibility.membership(id).hasOtherThan(file)),
      ]),
    ),
  };
}

const scopeId = (name: string): ScopeId => name as ScopeId;
const named = (localName: string, line: number): ImportStatement['edge'] => ({
  localName,
  targetExportedName: localName,
  kind: 'named',
  atRange: { startLine: line, startCol: 0, endLine: line, endCol: 20 },
});
const wildcard = (line: number, extra: Partial<ImportEdge> = {}): ImportStatement['edge'] => ({
  localName: '',
  targetExportedName: '',
  kind: 'wildcard-expanded',
  atRange: { startLine: line, startCol: 0, endLine: line, endCol: 20 },
  ...extra,
});

const PACKAGE_A = ['src/a/One.java', 'src/a/Two.java', 'src/a/Three.java'];
const PACKAGE_B = ['src/b/One.java', 'src/b/Four.java'];

/** Hand-written relations, one per property the pipeline relies on. */
export const namedRelations: readonly ImportRelation[] = [
  { name: 'no scopes at all', scopes: [], probeScopes: [scopeId('absent')], probeFiles: ['x'] },
  {
    name: 'a scope whose import list is empty',
    scopes: [{ id: scopeId('m'), statements: [] }],
    probeScopes: [],
    probeFiles: ['src/a/One.java'],
  },
  {
    name: 'explicit imports interleaved with wildcards',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: named('One', 1), targets: ['src/a/One.java'] },
          { edge: wildcard(2), targets: PACKAGE_B },
          { edge: named('Zed', 3), targets: ['src/z/Zed.java'] },
          { edge: wildcard(4), targets: PACKAGE_A },
        ],
      },
    ],
    probeScopes: [],
    probeFiles: ['src/a/Missing.java', 'Root.java'],
  },
  {
    name: 'the same wildcard written twice',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: wildcard(1), targets: PACKAGE_A },
          { edge: wildcard(2), targets: PACKAGE_A },
        ],
      },
    ],
    probeScopes: [],
    probeFiles: [],
  },
  {
    name: 'overlapping target sets and a file named both ways',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: wildcard(1), targets: PACKAGE_A },
          { edge: named('Two', 2), targets: ['src/a/Two.java'] },
          { edge: wildcard(3), targets: ['src/a/Three.java', 'src/c/Five.java'] },
        ],
      },
    ],
    probeScopes: [],
    probeFiles: [],
  },
  {
    name: 'a scope that imports its own file, alone and among others',
    scopes: [
      { id: scopeId('only-self'), statements: [{ edge: wildcard(1), targets: ['Self.java'] }] },
      {
        id: scopeId('self-and-more'),
        statements: [{ edge: wildcard(1), targets: ['Self.java', 'Other.java'] }],
      },
    ],
    probeScopes: [],
    probeFiles: ['Self.java', 'Other.java'],
  },
  {
    name: 'unresolved targets beside resolved ones',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: named('Gone', 1), targets: [null] },
          { edge: wildcard(2), targets: [null, 'src/a/One.java', null] },
          { edge: { ...named('Ext', 3), linkStatus: 'unresolved' }, targets: [null] },
        ],
      },
    ],
    probeScopes: [],
    probeFiles: [],
  },
  {
    name: 'a wildcard that resolves to no file',
    scopes: [{ id: scopeId('m'), statements: [{ edge: wildcard(1), targets: [] }] }],
    probeScopes: [],
    probeFiles: ['src/a/One.java'],
  },
  {
    name: 'presence flags travel with each target',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: wildcard(1, { runsOnlyWhenCalled: true }), targets: PACKAGE_A },
          { edge: { ...named('T', 2), typeOnly: true }, targets: ['src/t/T.ts'] },
        ],
      },
    ],
    probeScopes: [],
    probeFiles: [],
  },
  {
    name: 'imports selected by name, namespace, definition and exported name beside a wildcard',
    scopes: [
      {
        id: scopeId('m'),
        statements: [
          { edge: wildcard(1), targets: PACKAGE_A },
          {
            edge: { ...named('ns', 2), kind: 'namespace', targetExportedName: 'pkg.ns' },
            targets: ['src/ns/index.ts'],
          },
          {
            // A wildcard a language expands to names is selectable, never nameless.
            edge: {
              ...wildcard(3),
              localName: 'Expanded',
              targetExportedName: 'Expanded',
              targetDefId: 'def:Expanded',
            },
            targets: ['src/a/Two.java'],
          },
          {
            edge: { ...named('Alias', 4), kind: 'alias', targetDefId: 'def:Real' },
            targets: ['src/r/Real.ts'],
          },
          { edge: { ...named('Gone', 5), linkStatus: 'unresolved' }, targets: [null] },
          { edge: wildcard(6), targets: PACKAGE_B },
        ],
      },
    ],
    probeScopes: [scopeId('absent')],
    probeFiles: [],
  },
  {
    name: 'several scopes of one file and files at the root',
    scopes: [
      { id: scopeId('module'), statements: [{ edge: wildcard(1), targets: PACKAGE_A }] },
      { id: scopeId('function'), statements: [{ edge: named('R', 9), targets: ['Root.java'] }] },
      { id: scopeId('other'), statements: [{ edge: wildcard(1), targets: PACKAGE_B }] },
    ],
    probeScopes: [scopeId('absent')],
    probeFiles: ['src/a', 'src/a/One.java/x'],
  },
];

/** Deterministic generator (mulberry32): the same seed always gives the same relation. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A relation drawn from a small universe, so duplicates, overlaps, self-targets,
 * unresolved targets and empty lists all occur often. Packages are shared
 * arrays: every wildcard over one package holds the same array instance, as a
 * provider that resolves a package once would hand it out.
 */
export function generatedRelation(seed: number): ImportRelation {
  const next = prng(seed);
  const pick = (count: number): number => Math.floor(next() * count);
  const directories = ['', 'src', 'src/a', 'src/b', 'lib/deep/x'];
  const packages = Array.from({ length: 4 }, (_, p) =>
    Array.from({ length: pick(5) }, (_unused, f) => {
      const directory = directories[(p + pick(2)) % directories.length]!;
      return `${directory}${directory === '' ? '' : '/'}F${p}_${f}.java`;
    }),
  );
  const loose = ['Self0.java', 'Self1.java', 'src/a/F0_0.java', 'src/z/Lone.java'];
  const scopes = Array.from({ length: 1 + pick(4) }, (_, s) => ({
    id: scopeId(`scope${s}`),
    statements: Array.from({ length: pick(7) }, (_unused, line): ImportStatement => {
      const shape = pick(5);
      return shape < 2
        ? {
            edge: wildcard(line, pick(4) === 0 ? { runsOnlyWhenCalled: true } : {}),
            targets: packages[pick(4)]!,
          }
        : shape === 2
          ? { edge: wildcard(line), targets: [null, loose[pick(4)]!, `Self${s % 2}.java`] }
          : shape === 3
            ? { edge: named(`N${line}`, line), targets: [pick(3) === 0 ? null : loose[pick(4)]!] }
            : { edge: named(`D${line}`, line), targets: [packages[pick(4)]![0] ?? null] };
    }),
  }));
  return {
    name: `generated relation, seed ${seed}`,
    scopes,
    probeScopes: [scopeId('absent')],
    probeFiles: [...loose, 'src/never/Imported.java'],
  };
}

export const generatedRelations: readonly ImportRelation[] = Array.from({ length: 60 }, (_, i) =>
  generatedRelation(1000 + i),
);
