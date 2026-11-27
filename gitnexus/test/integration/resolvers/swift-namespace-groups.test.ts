/**
 * Swift stores `import X` as groups over the module's shared file list
 * (`ScopeResolver.groupsImportTargetKinds`) instead of one finalized edge per
 * file of X; only a file declaring a definition named after the module keeps
 * an edge of its own. Grouping changes storage, never answers: every fixture
 * here is analyzed with groups and with `GITNEXUS_DISABLE_IMPORT_GROUPS=1`,
 * and the two graphs must be identical node for node and edge for edge. The
 * answers of each `ImportVisibility` reader are compared in
 * `import-reader-parity.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportVisibility, ScopeId } from 'gitnexus-shared';
import { FIXTURES, getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import { graphIdentity } from '../../helpers/graph-identity.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { emitReferencesToGraph } from '../../../src/core/ingestion/emit-references.js';
import { swiftScopeResolver } from '../../../src/core/ingestion/languages/swift/scope-resolver.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

/** Three directory-named modules of four files; importers use one type of each. */
function moduleFixture(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let m = 0; m < 3; m++)
    for (let f = 0; f < 4; f++)
      files[`Mod${m}/Model${m}_${f}.swift`] = [
        `public struct Model${m}_${f} {`,
        '    public let id: Int',
        '    public init(id: Int) { self.id = id }',
        '    public func describe() -> String { return "model" }',
        '}',
        '',
      ].join('\n');
  for (let i = 0; i < 6; i++)
    files[`App/View${i}.swift`] = [
      'import Mod0',
      'import Mod1',
      'import Mod2',
      '',
      `func render${i}(_ a: Model0_${i % 4}, _ b: Model1_${i % 4}, _ c: Model2_${i % 4}) -> Int {`,
      '    _ = a.describe()',
      '    _ = b.describe()',
      '    let x = c.id',
      '    return x',
      '}',
      '',
    ].join('\n');
  return files;
}

/** `import X` used through the module name itself. */
const QUALIFIED: Record<string, string> = {
  'DTO/Model.swift': [
    'public struct Model {',
    '    public let id: Int',
    '    public init(id: Int) { self.id = id }',
    '}',
    '',
    'public func makeModel() -> Model {',
    '    return Model(id: 1)',
    '}',
    '',
  ].join('\n'),
  'DTO/Other.swift': 'public struct Other {}\n',
  'App/Use.swift': [
    'import DTO',
    '',
    'func use() -> Int {',
    '    let model: DTO.Model = DTO.makeModel()',
    '    return model.id',
    '}',
    '',
  ].join('\n'),
};

/** The importer is itself a file of the module it imports. */
const SELF_IMPORT: Record<string, string> = {
  'Core/Core.swift': 'import Core\n\npublic struct Engine {}\n\nfunc start(_ c: Client) {}\n',
  'Core/Client.swift': 'public struct Client {}\n',
  'App/Use.swift': 'import Core\n\nfunc run(_ e: Engine) {}\n',
};

const inMemory: readonly { readonly name: string; readonly files: Record<string, string> }[] = [
  { name: 'directory-named modules', files: moduleFixture() },
  { name: 'a module-qualified type and call', files: QUALIFIED },
  { name: 'an importer inside the module it imports', files: SELF_IMPORT },
  {
    name: 'a module with a type named after itself',
    files: {
      ...QUALIFIED,
      'DTO/DTO.swift': 'public enum DTO {\n    public static let version = 1\n}\n',
      'App/Version.swift': 'import DTO\n\nfunc version() -> Int {\n    return DTO.version\n}\n',
    },
  },
];
const onDisk = ['swift-nested-packages', 'swift-xcode-targets', 'swift-multifolder-nopackage'];

async function analyze(root: string) {
  return graphIdentity((await runPipelineFromRepo(root, () => {})).graph);
}

// Whatever the shell exports, each test starts with groups enabled.
beforeEach(() => vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', ''));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!swiftAvailable)('Swift module imports: grouped and per-file forms agree', () => {
  it.each(inMemory)(
    '$name',
    async ({ files }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-groups-'));
      try {
        writeFixtureRepo(root, files);
        const grouped = await analyze(root);
        vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
        expect(await analyze(root)).toEqual(grouped);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.each(onDisk)(
    'fixture %s',
    async (fixture) => {
      const grouped = await analyze(path.join(FIXTURES, fixture));
      vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
      expect(await analyze(path.join(FIXTURES, fixture))).toEqual(grouped);
    },
    60_000,
  );

  it('resolves module-qualified uses to the declaring file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-groups-'));
    try {
      writeFixtureRepo(root, QUALIFIED);
      const result = await runPipelineFromRepo(root, () => {});
      const fromUse = (type: string) =>
        getRelationships(result, type)
          .filter((edge) => edge.sourceFilePath === 'App/Use.swift')
          .map((edge) => `${edge.target}@${edge.targetFilePath}`)
          .sort();
      expect(fromUse('CALLS')).toContain('makeModel@DTO/Model.swift');
      expect(fromUse('ACCESSES')).toContain('id@DTO/Model.swift');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!swiftAvailable)('Swift module imports are stored as groups', () => {
  function resolve(files: Record<string, string>, emitScopes = false) {
    const graph = createKnowledgeGraph();
    let imports: ImportVisibility | undefined;
    let moduleScopes: ReadonlyMap<string, ScopeId> = new Map();
    runScopeResolution(
      {
        graph,
        files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })),
        model: createSemanticModel(),
        onResolved: (result) => {
          imports = result.indexes.imports;
          moduleScopes = new Map(
            result.parsedFiles.map((parsed) => [parsed.filePath, parsed.moduleScope]),
          );
          if (emitScopes)
            emitReferencesToGraph({
              graph,
              scopes: result.indexes,
              referenceIndex: { bySourceScope: new Map(), byTargetDef: new Map() },
            });
        },
      },
      swiftScopeResolver,
    );
    return { graph, imports: imports!, scope: (filePath: string) => moduleScopes.get(filePath)! };
  }

  it('emits the same scope-level IMPORTS with groups and without', () => {
    vi.stubEnv('INGESTION_EMIT_SCOPES', '1');
    const grouped = resolve(moduleFixture(), true);
    const scopeImports = [...grouped.graph.iterRelationshipsByType('IMPORTS')].filter(
      (rel) => rel.id.startsWith('rel:imports:') && rel.reason === 'import namespace Mod0',
    );
    // Six importers, four files of Mod0 each.
    expect(scopeImports).toHaveLength(24);
    vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
    expect(graphIdentity(resolve(moduleFixture(), true).graph)).toEqual(
      graphIdentity(grouped.graph),
    );
  });

  it('keeps no namespace edge per module file, one statement per import', () => {
    const { imports, scope } = resolve(moduleFixture());
    const view = scope('App/View0.swift');
    expect((imports.edgesAt(view) ?? []).filter((edge) => edge.kind === 'namespace')).toEqual([]);
    const statements = imports.statementsAt(view) ?? [];
    expect(statements.map((edge) => edge.localName)).toEqual(['Mod0', 'Mod1', 'Mod2']);
    expect(statements.map((edge) => imports.groupTargets(edge)?.length)).toEqual([4, 4, 4]);
    // Every importer shares the module's one list.
    expect(imports.groupTargets(statements[0]!)).toBe(
      imports.groupTargets((imports.statementsAt(scope('App/View1.swift')) ?? [])[0]!),
    );
  });

  it('answers an importer inside the module it imports without itself', () => {
    const { imports, scope } = resolve(SELF_IMPORT);
    // Its own list, not the module's shared one: the importer is left out.
    expect(
      (imports.statementsAt(scope('Core/Core.swift')) ?? []).map((edge) =>
        imports.groupTargets(edge),
      ),
    ).toEqual([['Core/Client.swift']]);
    expect(
      (imports.statementsAt(scope('App/Use.swift')) ?? []).map((edge) =>
        imports.groupTargets(edge),
      ),
    ).toEqual([['Core/Core.swift', 'Core/Client.swift']]);
  });

  it('stores a module with a type named after it as at most three entries per statement', () => {
    // `DTO/DTO.swift` declares `DTO`: `import DTO` binds through that file
    // only, which keeps a per-file edge; the other files stay grouped around
    // it, in runs shared by every importer.
    const files: Record<string, string> = {
      'DTO/DTO.swift': 'public enum DTO {\n    public static let version = 1\n}\n',
    };
    for (let d = 0; d < 20; d++)
      files[`DTO/Model${d}.swift`] = `public struct Model${d} {\n    public var id = 0\n}\n`;
    for (let k = 0; k < 30; k++)
      files[`App/Use${k}.swift`] =
        `import DTO\n\nfunc use${k}() -> Int {\n    return DTO.version + Model${k % 20}().id\n}\n`;
    const { imports, scope } = resolve(files);
    const lists = new Set<readonly string[]>();
    for (let k = 0; k < 30; k++) {
      const statements = (imports.statementsAt(scope(`App/Use${k}.swift`)) ?? []).filter(
        (edge) => edge.localName === 'DTO',
      );
      expect(statements.length).toBeLessThanOrEqual(3);
      expect(statements.filter((edge) => edge.targetFile !== null)).toEqual([
        expect.objectContaining({ targetFile: 'DTO/DTO.swift' }),
      ]);
      for (const edge of statements) {
        const grouped = imports.groupTargets(edge);
        if (grouped !== undefined) lists.add(grouped);
      }
    }
    expect([...lists].flat().sort()).toEqual(
      Array.from({ length: 20 }, (_, d) => `DTO/Model${d}.swift`).sort(),
    );
  });

  it('stores one edge per file again when groups are disabled', () => {
    vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
    const { imports, scope } = resolve(moduleFixture());
    expect(
      (imports.edgesAt(scope('App/View0.swift')) ?? []).filter((edge) => edge.kind === 'namespace'),
    ).toHaveLength(12);
  });
});
