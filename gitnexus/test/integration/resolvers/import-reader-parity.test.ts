/**
 * Reader parity for grouped module imports.
 *
 * Finalize may store a module import as groups over the module's files; Swift
 * `import X` is the provider that does, so its pipeline supplies the shapes. Pipeline
 * output alone cannot show that a reader of `ImportVisibility` got the grouped
 * form wrong (a claim's status, for example, is not in the graph), so every
 * reader is asked the same questions twice over ONE finalize result: through
 * the grouped visibility the pipeline built, and through a per-file visibility
 * whose edges are the groups written out. The written-out form is first
 * checked against a run with `GITNEXUS_DISABLE_IMPORT_GROUPS=1`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEagerImportVisibility,
  createGroupedImportVisibility,
  importEdgeFiles,
  type ImportEdge,
  type ImportEntry,
  type ParsedFile,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { swiftScopeResolver } from '../../../src/core/ingestion/languages/swift/scope-resolver.js';
import {
  findClassBindingInScope,
  isClassFileImportGrounded,
  isClassLike,
  isNamespaceNameShadowed,
  lookupNameClaim,
  namespaceImportAllowsMember,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { collectNamespaceTargets } from '../../../src/core/ingestion/scope-resolution/scope/namespace-targets.js';
import { withCachedNameLookups } from '../../../src/core/ingestion/scope-resolution/scope/name-lookup-cache.js';
import {
  namespaceCallReturnType,
  qualifiedYieldAt,
} from '../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import {
  baseRooting,
  namespaceImportTargets,
} from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { prng } from '../../helpers/import-visibility-contract.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const MODULES = ['M0', 'M1', 'M2', 'M3'];

/** A seeded workspace of directory-named modules and importers that reach
 *  them through the module name: qualified types and calls, awaited calls,
 *  extensions of qualified types, locals shadowing a module name, explicit
 *  `import struct`, and modules with a type named after themselves. */
function workspace(seed: number): Record<string, string> {
  const next = prng(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const files: Record<string, string> = {};
  const types: string[][] = MODULES.map(() => []);
  MODULES.forEach((module, m) => {
    const count = 2 + pick(4);
    for (let f = 0; f < count; f++) {
      const name = `T${m}_${f}`;
      types[m]!.push(name);
      const lines = [
        `public struct ${name} {`,
        '    public init() {}',
        '    public func run() -> Int { 1 }',
        '}',
        `public func make${m}_${f}() -> ${name} { ${name}() }`,
        `public func fetch${m}_${f}() async -> ${name} { ${name}() }`,
      ];
      // A type named after its module makes `import M` bind through this file,
      // also when it is nested in another type.
      if (pick(3) === 0) lines.push(`public enum ${module} { public static let tag = ${f} }`);
      else if (pick(3) === 0)
        lines.push(`public enum Box${m}_${f} { public enum ${module} { case tag } }`);
      files[`${module}/F${f}.swift`] = lines.join('\n') + '\n';
    }
  });
  const importers = 3 + pick(4);
  for (let i = 0; i < importers; i++) {
    const imported = MODULES.filter(() => pick(2) === 0);
    if (imported.length === 0) imported.push(MODULES[pick(4)]!);
    const lines = imported.map((module) => `import ${module}`);
    const m = MODULES.indexOf(imported[0]!);
    const t = types[m]![pick(types[m]!.length)]!;
    if (pick(3) === 0) lines.push(`import struct ${imported[0]}.${t}`);
    lines.push('', `func use${i}() async -> Int {`);
    lines.push(`    let a: ${imported[0]}.${t} = ${imported[0]}.make${t.slice(1)}()`);
    lines.push(`    let b = await ${imported[0]}.fetch${t.slice(1)}()`);
    if (pick(2) === 0) lines.push(`    let ${imported[imported.length - 1]} = 1`);
    lines.push('    return a.run() + b.run()', '}');
    if (pick(2) === 0) lines.push(`extension ${imported[0]}.${t} {`, '    func extra() {}', '}');
    // A top-level declaration named like an imported module.
    if (pick(4) === 0) lines.push(`let ${imported[imported.length - 1]} = 0`);
    files[`App/Use${i}.swift`] = lines.join('\n') + '\n';
  }
  return files;
}

interface Resolved {
  readonly indexes: ScopeResolutionIndexes;
  readonly parsedFiles: readonly ParsedFile[];
}

function resolve(files: Record<string, string>): Resolved {
  let resolved: Resolved | undefined;
  runScopeResolution(
    {
      graph: createKnowledgeGraph(),
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      model: createSemanticModel(),
      onResolved: (result) => {
        resolved = { indexes: result.indexes, parsedFiles: result.parsedFiles };
      },
    },
    swiftScopeResolver,
  );
  return resolved!;
}

/** Every scope's imports in statement order, groups as groups. */
function entriesOf(indexes: ScopeResolutionIndexes): Map<ScopeId, readonly ImportEntry[]> {
  const imports = indexes.imports;
  return new Map(
    [...imports.scopes()].map((scope) => [
      scope,
      (imports.statementsAt(scope) ?? []).map(
        (edge): ImportEntry =>
          edge.groupsFiles === true
            ? { via: edge, targetFiles: importEdgeFiles(edge, imports) }
            : edge,
      ),
    ]),
  );
}

/** The same entries with each group written out as its per-file edges. */
function writtenOut(
  entries: ReadonlyMap<ScopeId, readonly ImportEntry[]>,
  indexes: ScopeResolutionIndexes,
): Map<ScopeId, readonly ImportEdge[]> {
  return new Map(
    [...entries].map(([scope, list]) => [
      scope,
      list.flatMap((entry): ImportEdge[] => {
        if (!('targetFiles' in entry)) return [entry];
        const { groupsFiles: _marker, ...statement } = entry.via;
        return entry.targetFiles.map((targetFile) => {
          const targetModuleScope = indexes.moduleScopes.get(targetFile);
          return {
            ...statement,
            targetFile,
            ...(targetModuleScope === undefined ? {} : { targetModuleScope }),
          };
        });
      }),
    ]),
  );
}

/** Shapes the contract allows and the Swift pipeline does not produce, made
 *  from the same entries: name filters on module imports; each module import
 *  re-bound, over the first half of its files, in the importer's first
 *  function scope (a nearer import of the same name); and an unresolved import
 *  under each module import's name. */
function variant(
  kind: 'filters' | 'lexical' | 'unresolved',
  entries: ReadonlyMap<ScopeId, readonly ImportEntry[]>,
  resolved: Resolved,
  typeNames: readonly string[],
): Map<ScopeId, readonly ImportEntry[]> {
  const out = new Map(entries);
  const filtered = (edge: ImportEdge): ImportEdge =>
    edge.kind === 'namespace'
      ? { ...edge, nameFilters: [{ kind: 'hide', names: typeNames.filter((_, i) => i % 2 === 0) }] }
      : edge;
  for (const parsed of resolved.parsedFiles) {
    if (!parsed.filePath.startsWith('App/')) continue;
    const list = entries.get(parsed.moduleScope) ?? [];
    if (kind === 'unresolved') {
      const names = new Set(
        list.map((entry) => ('targetFiles' in entry ? entry.via : entry).localName),
      );
      out.set(parsed.moduleScope, [
        ...list,
        ...[...names].map(
          (localName): ImportEdge => ({
            kind: 'namespace',
            localName,
            targetExportedName: `${localName}.Missing`,
            targetFile: null,
            linkStatus: 'unresolved',
          }),
        ),
      ]);
      continue;
    }
    if (kind === 'filters') {
      out.set(
        parsed.moduleScope,
        list.map((entry) =>
          'targetFiles' in entry ? { ...entry, via: filtered(entry.via) } : filtered(entry),
        ),
      );
      continue;
    }
    const fn = resolved.indexes.scopeTree
      .getChildren(parsed.moduleScope)
      .find((id) => resolved.indexes.scopeTree.getScope(id)?.kind === 'Function');
    if (fn === undefined) continue;
    const namespaces = list.filter(
      (entry) => ('targetFiles' in entry ? entry.via : entry).kind === 'namespace',
    );
    const remaining = new Map<ImportEdge['atRange'], number>();
    for (const entry of namespaces) {
      const range = 'targetFiles' in entry ? entry.via.atRange : entry.atRange;
      const files = 'targetFiles' in entry ? entry.targetFiles.length : 1;
      remaining.set(range, (remaining.get(range) ?? 0) + files);
    }
    for (const [range, files] of remaining) remaining.set(range, Math.ceil(files / 2));
    out.set(
      fn,
      namespaces.flatMap((entry): ImportEntry[] => {
        const range = 'targetFiles' in entry ? entry.via.atRange : entry.atRange;
        const count = remaining.get(range) ?? 0;
        if (count === 0) return [];
        if ('targetFiles' in entry) {
          const targetFiles = entry.targetFiles.slice(0, count);
          remaining.set(range, count - targetFiles.length);
          return [{ via: { ...entry.via }, targetFiles }];
        }
        remaining.set(range, count - 1);
        return [entry];
      }),
    );
  }
  return out;
}

function scopesOf(indexes: ScopeResolutionIndexes, parsed: ParsedFile): ScopeId[] {
  const out: ScopeId[] = [];
  const stack = [parsed.moduleScope];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...indexes.scopeTree.getChildren(id));
  }
  return out;
}

const files = (edges: readonly ImportEdge[], indexes: ScopeResolutionIndexes) =>
  [...new Set(edges.flatMap((edge) => importEdgeFiles(edge, indexes.imports)))].sort();

/** Every reader's answer, without and with the pass's name-lookup cache. */
function answers(indexes: ScopeResolutionIndexes, resolved: Resolved): Record<string, unknown> {
  return {
    uncached: readerAnswers(indexes, resolved),
    cached: withCachedNameLookups(indexes, () => readerAnswers(indexes, resolved)),
  };
}

/** Every reader's answer to every question this workspace can ask. */
function readerAnswers(
  indexes: ScopeResolutionIndexes,
  resolved: Resolved,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const importers = resolved.parsedFiles.filter((p) => p.filePath.startsWith('App/'));
  const classes: SymbolDefinition[] = resolved.parsedFiles
    .flatMap((p) => p.localDefs)
    .filter((def) => isClassLike(def.type));
  const typeNames = [...new Set(classes.map((def) => def.qualifiedName ?? ''))];
  const names = [...MODULES, ...typeNames, 'Missing'];
  for (const parsed of importers) {
    for (const module of MODULES)
      out[`targets ${parsed.filePath} ${module}`] = namespaceImportTargets(
        parsed.moduleScope,
        module,
        indexes,
      );
    for (const scope of scopesOf(indexes, parsed)) {
      const at = `${parsed.filePath} ${scope}`;
      out[`namespaces ${at}`] = [...collectNamespaceTargets(parsed, indexes, { inScope: scope })];
      out[`namespaces/identity ${at}`] = [
        ...collectNamespaceTargets(parsed, indexes, {
          inScope: scope,
          bindingIdentity: (namespace) => namespace.importPath,
        }),
      ];
      for (const name of names) {
        for (const purpose of ['value', 'type'] as const) {
          const claim = lookupNameClaim(scope, name, indexes, { purpose });
          out[`claim/${purpose} ${at} ${name}`] = {
            status: claim.status,
            files: files(claim.imports, indexes),
            bindings: claim.bindings.map((b) => b.def.nodeId).sort(),
          };
        }
        out[`shadowed ${at} ${name}`] = isNamespaceNameShadowed(name, scope, indexes);
        out[`rooting ${at} ${name}`] = baseRooting(scope, name, indexes, {});
        for (const def of classes)
          out[`grounded ${at} ${name} ${def.nodeId}`] = isClassFileImportGrounded(
            scope,
            def,
            indexes,
            name,
          );
      }
      for (const module of MODULES) {
        for (const type of typeNames) {
          out[`class ${at} ${module}.${type}`] = findClassBindingInScope(
            scope,
            `${module}.${type}`,
            indexes,
          )?.nodeId;
          out[`member ${at} ${module}.${type}`] = namespaceImportAllowsMember(
            scope,
            module,
            type,
            indexes,
          );
          for (const target of resolved.parsedFiles)
            if (target.filePath.startsWith(`${module}/`))
              out[`member ${at} ${module}.${type} ${target.filePath}`] =
                namespaceImportAllowsMember(
                  scope,
                  module,
                  type,
                  indexes,
                  undefined,
                  target.filePath,
                );
          out[`yield ${at} ${module}.${type}`] = qualifiedYieldAt(
            `${module}.${type}`,
            scope,
            indexes,
          );
          out[`return ${at} ${module}.make${type.slice(1)}`] = namespaceCallReturnType(
            `${module}.make${type.slice(1)}`,
            scope,
            indexes,
          );
        }
      }
    }
  }
  return out;
}

const SEEDS = Array.from({ length: 12 }, (_, i) => 9100 + i);

beforeEach(() => vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', ''));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!swiftAvailable)('ImportVisibility readers: grouped and per-file answers', () => {
  it.each(SEEDS)(
    'seed %i',
    (seed) => {
      const source = workspace(seed);
      const grouped = resolve(source);
      const eager = writtenOut(entriesOf(grouped.indexes), grouped.indexes);
      // The written-out form is what finalize stores with groups disabled.
      vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', '1');
      const flat = resolve(source);
      expect(
        new Map(
          [...flat.indexes.imports.scopes()].map((scope) => [
            scope,
            flat.indexes.imports.edgesAt(scope),
          ]),
        ),
      ).toEqual(eager);
      const perFile = { ...grouped.indexes, imports: createEagerImportVisibility(eager) };
      expect(answers(grouped.indexes, grouped)).toEqual(answers(perFile, grouped));
    },
    120_000,
  );

  it.each(
    SEEDS.flatMap((seed) =>
      (['filters', 'lexical', 'unresolved'] as const).map((kind) => ({ seed, kind })),
    ),
  )(
    'seed $seed, $kind',
    ({ seed, kind }) => {
      const resolved = resolve(workspace(seed));
      const typeNames = resolved.parsedFiles
        .flatMap((p) => p.localDefs)
        .filter((def) => isClassLike(def.type))
        .map((def) => def.qualifiedName ?? '');
      const original = entriesOf(resolved.indexes);
      const entries = variant(kind, original, resolved, typeNames);
      if (kind === 'lexical') {
        const input = writtenOut(original, resolved.indexes);
        const rebound = writtenOut(entries, resolved.indexes);
        for (const parsed of resolved.parsedFiles.filter((file) =>
          file.filePath.startsWith('App/'),
        )) {
          const fn = resolved.indexes.scopeTree
            .getChildren(parsed.moduleScope)
            .find((id) => resolved.indexes.scopeTree.getScope(id)?.kind === 'Function');
          expect(fn).toBeDefined();
          for (const module of MODULES) {
            const targetsAt = (edges: readonly ImportEdge[]) =>
              edges
                .filter((edge) => edge.kind === 'namespace' && edge.localName === module)
                .map((edge) => edge.targetFile);
            const targets = targetsAt(input.get(parsed.moduleScope) ?? []);
            expect(targetsAt(rebound.get(fn!) ?? [])).toEqual(
              targets.slice(0, Math.ceil(targets.length / 2)),
            );
          }
        }
      }
      const groupedForm = { ...resolved.indexes, imports: createGroupedImportVisibility(entries) };
      const perFileForm = {
        ...resolved.indexes,
        imports: createEagerImportVisibility(writtenOut(entries, resolved.indexes)),
      };
      expect(answers(groupedForm, resolved)).toEqual(answers(perFileForm, resolved));
    },
    120_000,
  );

  it('exercises grouped statements and statements split by a module-named type, top-level or nested', () => {
    let groups = 0;
    let splits = 0;
    let nestedSplits = 0;
    for (const seed of SEEDS) {
      const { indexes } = resolve(workspace(seed));
      for (const scope of indexes.imports.scopes()) {
        const statements = indexes.imports.statementsAt(scope) ?? [];
        const grouping = statements.filter((edge) => edge.groupsFiles === true);
        groups += grouping.length;
        const bound = statements.filter(
          (edge) =>
            edge.groupsFiles !== true &&
            grouping.some((group) => group.atRange === edge.atRange) &&
            edge.targetDefId !== undefined,
        );
        if (bound.length > 0) splits++;
        if (
          bound.some((edge) =>
            (indexes.defs.get(edge.targetDefId!)?.qualifiedName ?? '').includes('.'),
          )
        )
          nestedSplits++;
      }
    }
    expect(groups).toBeGreaterThan(20);
    expect(splits).toBeGreaterThan(3);
    expect(nestedSplits).toBeGreaterThan(0);
  }, 120_000);
});
