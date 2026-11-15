import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportedLanguages, type ImportVisibility, type ScopeId } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { emitReferencesToGraph } from '../../../../src/core/ingestion/emit-references.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { javaScopeResolver } from '../../../../src/core/ingestion/languages/java/scope-resolver.js';
import { SCOPE_RESOLVERS } from '../../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { graphIdentity } from '../../../helpers/graph-identity.js';

/**
 * Java stores `import pkg.*;` as one group per statement. These tests look at
 * the storage itself, through the whole chain from the provider flag to the
 * finalized `ImportVisibility`: behavioural tests alone cannot tell whether
 * grouping happened, because grouping changes no answer.
 */
const sources = {
  'src/models/User.java': 'package models; public class User { public void save() {} }',
  'src/models/Order.java': 'package models; public class Order {}',
  'src/models/Audit.java': 'package models; public class Audit {}',
  'src/util/Text.java': 'package util; public class Text {}',
  'src/app/Main.java':
    'package app;\nimport util.Text;\nimport models.*;\npublic class Main { void run(User user) { user.save(); new Text(); } }',
  'src/app/Other.java': 'package app;\nimport models.*;\npublic class Other { Order order; }',
};
/** The package's files in the order the pass was given them: the order of the package's list. */
const MODELS = ['src/models/User.java', 'src/models/Order.java', 'src/models/Audit.java'];

function resolve(emitScopes = false) {
  const graph = createKnowledgeGraph();
  let imports: ImportVisibility | undefined;
  let moduleScopes: ReadonlyMap<string, ScopeId> = new Map();
  runScopeResolution(
    {
      graph,
      files: Object.entries(sources).map(([path, content]) => ({ path, content })),
      model: createSemanticModel(),
      onResolved: (result) => {
        imports = result.indexes.imports;
        moduleScopes = new Map(
          result.parsedFiles.map((parsed) => [parsed.filePath, parsed.moduleScope]),
        );
        if (emitScopes) {
          emitReferencesToGraph({
            graph,
            scopes: result.indexes,
            referenceIndex: { bySourceScope: new Map(), byTargetDef: new Map() },
          });
        }
      },
    },
    javaScopeResolver,
  );
  const scope = (filePath: string): ScopeId => moduleScopes.get(filePath)!;
  const visited = (filePath: string): string[] => {
    const seen: string[] = [];
    imports!.forEachTarget(scope(filePath), (targetFile, via) =>
      seen.push(`${via.kind} ${targetFile}`),
    );
    return seen;
  };
  const wildcardEdges = (filePath: string): number =>
    (imports!.edgesAt(scope(filePath)) ?? []).filter((edge) => edge.kind === 'wildcard-expanded')
      .length;
  return { graph, imports: imports!, scope, visited, wildcardEdges };
}

// Whatever the shell exports, each test starts with groups enabled.
beforeEach(() => vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', ''));
afterEach(() => vi.unstubAllEnvs());

describe('Java on-demand imports are stored as groups', () => {
  it('is the only provider that groups, so the only one these both-forms tests must cover', () => {
    // A provider that opts in needs its own grouped-versus-one-edge-per-file
    // tests first: finalize cannot see a provider hook that reads wildcard
    // targets from `edgesAt`.
    expect(
      [...SCOPE_RESOLVERS]
        .filter(([, resolver]) => resolver.groupsWildcardImportTargets === true)
        .map(([language]) => language),
    ).toEqual([SupportedLanguages.Java]);
  });

  it('keeps no edge per package file, and still reaches every package file', () => {
    const { imports, scope, wildcardEdges } = resolve();
    expect(wildcardEdges('src/app/Main.java')).toBe(0);
    expect(wildcardEdges('src/app/Other.java')).toBe(0);
    expect(MODELS.map((file) => imports.reaches(scope('src/app/Main.java'), file))).toEqual([
      true,
      true,
      true,
    ]);
    expect(imports.reaches(scope('src/app/Main.java'), 'src/util/Text.java')).toBe(true);
    expect(imports.reaches(scope('src/app/Other.java'), 'src/util/Text.java')).toBe(false);
  });

  it('visits explicit and on-demand targets in the order they are written', () => {
    expect(resolve().visited('src/app/Main.java')).toEqual([
      'named src/util/Text.java',
      ...MODELS.map((file) => `wildcard-expanded ${file}`),
    ]);
  });

  it('keeps the explicit import as an edge a reader can select by name', () => {
    const { imports, scope } = resolve();
    expect(
      (imports.edgesAt(scope('src/app/Main.java')) ?? []).map((edge) => edge.localName),
    ).toEqual(['Text']);
    expect(imports.edgesAt(scope('src/app/Other.java'))).toEqual([]);
  });

  it('stores one edge per package file again when groups are disabled', () => {
    vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
    const { visited, wildcardEdges } = resolve();
    expect(wildcardEdges('src/app/Main.java')).toBe(MODELS.length);
    expect(visited('src/app/Main.java')).toEqual([
      'named src/util/Text.java',
      ...MODELS.map((file) => `wildcard-expanded ${file}`),
    ]);
  });

  it('produces the same graph with groups and without', () => {
    const grouped = graphIdentity(resolve().graph);
    vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
    expect(graphIdentity(resolve().graph)).toEqual(grouped);
    expect(grouped.relationships.filter((rel) => rel.includes('"type":"IMPORTS"'))).toHaveLength(3);
  });

  it('preserves every scope import edge when scope emission is enabled', () => {
    vi.stubEnv('INGESTION_EMIT_SCOPES', '1');
    const grouped = resolve(true);
    const scopeImports = [...grouped.graph.iterRelationshipsByType('IMPORTS')].filter((rel) =>
      rel.id.startsWith('rel:imports:'),
    );
    expect(scopeImports.map((rel) => [rel.sourceId, rel.targetId, rel.reason])).toEqual([
      [
        grouped.scope('src/app/Main.java'),
        grouped.scope('src/util/Text.java'),
        'import named Text',
      ],
      ...['src/app/Main.java', 'src/app/Other.java'].flatMap((source) =>
        MODELS.map((target) => [
          grouped.scope(source),
          grouped.scope(target),
          'import wildcard-expanded ',
        ]),
      ),
    ]);
    vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
    expect(graphIdentity(resolve(true).graph)).toEqual(graphIdentity(grouped.graph));
  });
});
