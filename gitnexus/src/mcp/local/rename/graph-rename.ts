import { applyEdits, createOffsetLookup } from 'gitnexus-shared';
import fs from 'node:fs/promises';
import {
  CLASS_KINDS,
  METHOD_KINDS,
  type GraphNode,
  type Range,
  type ReferenceSite,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../core/graph/graph.js';
import { createSemanticModel } from '../../../core/ingestion/model/semantic-model.js';
import { computeMRO } from '../../../core/ingestion/mro-processor.js';
import {
  getProviderForFile,
  getProviderForFileContent,
  needsContentLanguageClassification,
} from '../../../core/ingestion/languages/index.js';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameReplacement,
  RenameSemanticContext,
  RenameSource,
} from '../../../core/ingestion/rename-provider.js';
import type { ScopeResolver } from '../../../core/ingestion/scope-resolution/contract/scope-resolver.js';
import { SCOPE_RESOLVERS } from '../../../core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../../core/ingestion/scope-resolution/pipeline/run.js';
import type { SourceBindingResolution } from '../../../core/ingestion/scope-resolution/source-binding-resolution.js';
import {
  buildGraphNodeLookup,
  LINKABLE_LABELS,
  qualifiedKey,
} from '../../../core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import {
  resolveDefGraphId,
  simpleQualifiedName,
} from '../../../core/ingestion/scope-resolution/graph-bridge/ids.js';
import {
  containsRange,
  innermostRenameScopeAt,
  rangeKey,
} from '../../../core/ingestion/languages/rename-tree-sitter.js';
import { lookupNameClaim } from '../../../core/ingestion/scope-resolution/scope/walkers.js';
import { definitionIdPosition } from '../../../core/ingestion/scope-resolution/utils/definition-id.js';
import {
  RenameFailure,
  repositoryPath,
  type RenameOptions,
  type RenamePlan,
  type RenameSymbol,
  type OccurrenceEdit,
} from './rename-plan.js';

type SemanticObservation = Parameters<
  NonNullable<Parameters<typeof runScopeResolution>[0]['onResolved']>
>[0];

/**
 * `SourceBindingResolution.basis` values, emitted with `status: 'blocked'` and
 * no target, that PROVE the written name denotes some other declaration:
 * a lexical claim (shadowing, non-callable binding), a qualified-type root that
 * is not a type owner, a type parameter, or C++ ordinary lookup stopping at a
 * non-function. Every other blocked basis (an unbound `this`, member-name
 * hiding, an absent namespace member) records that resolution stopped without
 * saying what the name means, so it can never clear a same-spelled site.
 */
const DISTINCT_DECLARATION_BASES: ReadonlySet<string> = new Set([
  'lexical-name-claim',
  'qualified-type-root',
  'type-parameter',
  'adl-ordinary-lookup-blocked',
]);

/** A fresh provider-owned semantic pass uses graph identities, never text-search edits. */
export async function planGraphRename(
  repoPath: string,
  symbol: RenameSymbol,
  options: RenameOptions,
  graphNodes: readonly GraphNode[],
  referenceFiles: readonly string[] = [],
): Promise<RenamePlan> {
  const targetNode = graphNodes.find((node) => node.id === symbol.uid);
  if (
    !targetNode ||
    targetNode.label === 'File' ||
    targetNode.properties.filePath !== symbol.filePath ||
    targetNode.properties.name !== symbol.name ||
    targetNode.properties.startLine !== symbol.startLine - 1 ||
    (symbol.kind !== undefined && targetNode.label !== symbol.kind) ||
    (symbol.endLine !== undefined && targetNode.properties.endLine !== symbol.endLine - 1)
  ) {
    throw new RenameFailure(
      'stale_graph',
      'The selected graph declaration does not match this checkout. Re-analyze first.',
    );
  }
  const root = await fs.realpath(repoPath);
  const contents = new Map<string, string>();
  const readSource = async (filePath: string): Promise<string> => {
    const existing = contents.get(filePath);
    if (existing !== undefined) return existing;
    const absolute = repositoryPath(repoPath, filePath);
    repositoryPath(root, await fs.realpath(absolute));
    const bytes = await fs.readFile(absolute);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new RenameFailure(
        'unsupported_encoding',
        `Source is not lossless UTF-8: ${filePath}`,
        'unsupported',
      );
    }
    contents.set(filePath, content);
    return content;
  };
  const targetProvider = getProviderForFileContent(
    symbol.filePath,
    await readSource(symbol.filePath),
  );
  const resolver = targetProvider && SCOPE_RESOLVERS.get(targetProvider.id);
  const provider = resolver?.languageProvider.rename;
  if (!targetProvider || !resolver || !provider) {
    throw new RenameFailure(
      'unsupported_language',
      'This language has no semantic rename provider.',
      'unsupported',
    );
  }
  const language = targetProvider.id;
  const canonical = (
    name: string,
    context?: Parameters<NonNullable<RenameProvider['canonicalName']>>[1],
  ) => provider.canonicalName?.(name, context) ?? name;
  if (
    typeof options.new_name !== 'string' ||
    !options.new_name ||
    options.new_name === symbol.name
  ) {
    throw new RenameFailure('invalid_name', 'Choose a different, nonempty identifier.');
  }
  reject(provider.validateName?.(options.new_name));
  const sourceResolvers = new Map<string, ScopeResolver>();
  const boundarySnapshots = new Map<string, string>();
  for (const node of graphNodes) {
    if (node.label !== 'File') continue;
    const filenameProvider = getProviderForFile(node.properties.filePath);
    if (
      !needsContentLanguageClassification(node.properties.filePath) &&
      (!filenameProvider ||
        (filenameProvider.id !== language &&
          !provider.acceptsSourceProvider?.(filenameProvider, node.properties.filePath) &&
          !provider.interoperatesWithSourceProvider?.(filenameProvider, node.properties.filePath)))
    )
      continue;
    const sourceProvider = getProviderForFileContent(
      node.properties.filePath,
      await readSource(node.properties.filePath),
    );
    if (!sourceProvider) continue;
    if (
      sourceProvider.id !== language &&
      !provider.acceptsSourceProvider?.(sourceProvider, node.properties.filePath)
    ) {
      if (provider.interoperatesWithSourceProvider?.(sourceProvider, node.properties.filePath)) {
        const filePath = node.properties.filePath;
        const content = contents.get(filePath)!;
        if (!content.trim()) {
          boundarySnapshots.set(repositoryPath(repoPath, filePath), content);
          continue;
        }
        const sourceResolver = SCOPE_RESOLVERS.get(sourceProvider.id);
        const sourceRename = sourceResolver?.languageProvider.rename;
        if (!sourceResolver || !sourceRename)
          throw new RenameFailure(
            'unsupported_boundary',
            `An interoperating indexed source has no name inventory: ${filePath}`,
            'unsupported',
          );
        let boundary: RenameSource;
        try {
          boundary = await parseSource(sourceRename, sourceResolver, filePath, content);
        } catch {
          throw new RenameFailure(
            'unsupported_boundary',
            `Cannot establish the name inventory of an interoperating indexed source: ${filePath}`,
            'unsupported',
          );
        }
        const spellings = new Set(
          [canonical(symbol.name), canonical(options.new_name)].flatMap((name) => [
            name,
            ...(provider.interopNames?.(name, sourceProvider) ?? []),
          ]),
        );
        // Normalise both sides: the consumer may write the selected entity under a
        // different spelling (a full selector for a base name) than its declaration.
        const writtenNames = (occurrence: RenameOccurrence): readonly string[] => {
          const written =
            sourceRename.canonicalName?.(occurrence.name, { occurrence }) ?? occurrence.name;
          return [written, ...(sourceRename.boundaryNames?.(written, targetProvider) ?? [])];
        };
        if (
          boundary.occurrences.some((occurrence) =>
            writtenNames(occurrence).some((name) => spellings.has(name)),
          ) ||
          sourceRename.additionalInteropNames?.(boundary).some((name) => spellings.has(name))
        )
          throw new RenameFailure(
            'unsupported_boundary',
            `An interoperating indexed source contains the selected or replacement name without a proven binding: ${filePath}`,
            'unsupported',
          );
        // Absence of names is part of the safety proof and must survive apply.
        boundarySnapshots.set(repositoryPath(repoPath, filePath), content);
      }
      continue;
    }
    const sourceResolver = SCOPE_RESOLVERS.get(sourceProvider.id);
    if (!sourceResolver?.languageProvider.rename) {
      throw new RenameFailure(
        'unsupported_boundary',
        `A workspace source has no rename provider: ${node.properties.filePath}`,
        'unsupported',
      );
    }
    sourceResolvers.set(node.properties.filePath, sourceResolver);
  }
  const filePaths = [...sourceResolvers.keys()].sort();
  if (!filePaths.includes(symbol.filePath)) {
    throw new RenameFailure(
      'stale_graph',
      'The target source file is absent from the indexed file set.',
    );
  }
  if (referenceFiles.some((filePath) => !filePaths.includes(filePath))) {
    throw new RenameFailure(
      'unsupported_boundary',
      'The indexed graph contains references outside this language scope.',
      'unsupported',
    );
  }
  const snapshots = new Map(boundarySnapshots);
  const files = new Map<string, RenameSource>();
  for (const filePath of filePaths) {
    const absolute = repositoryPath(repoPath, filePath);
    const content = contents.get(filePath)!;
    snapshots.set(absolute, content);
    const sourceResolver = sourceResolvers.get(filePath)!;
    if (content.trim())
      files.set(
        filePath,
        await parseSource(
          sourceResolver.languageProvider.rename!,
          sourceResolver,
          filePath,
          content,
        ),
      );
  }
  const resolutionConfig = resolver.captureResolutionConfig
    ? await resolver.captureResolutionConfig(repoPath, filePaths)
    : await resolver.loadResolutionConfig?.(repoPath);
  const before = resolveSources(files, graphNodes, resolver, resolutionConfig);
  const { parsedFiles, indexes, referenceBindings } = before.observation;
  const definitions = parsedFiles.flatMap((file) => [...file.localDefs]);
  const nodeLookup = buildGraphNodeLookup(
    before.graph,
    new Set([...LINKABLE_LABELS, ...definitions.map((def) => def.type)]),
  );
  const targetDefs = definitions.filter((def) => {
    const position = definitionIdPosition(def.nodeId, def.filePath);
    if (
      def.filePath !== symbol.filePath ||
      canonical(simpleQualifiedName(def) ?? '', { definition: def }) !==
        canonical(symbol.name, { definition: def }) ||
      (position?.line ?? def.declarationRange?.startLine) !== symbol.startLine ||
      (symbol.endLine !== undefined && def.declarationRange?.endLine !== symbol.endLine) ||
      resolveDefGraphId(def.filePath, def, nodeLookup) !== targetNode.id
    )
      return false;
    if (provider.matchesGraphIdentity)
      return provider.matchesGraphIdentity({
        definition: def,
        node: targetNode,
        definitions,
        graph: before.graph,
        files,
      });
    if (def.qualifiedName === undefined) return def.nodeId === targetNode.id;
    const qualifiedName =
      def.namespacePrefix && !def.qualifiedName.startsWith(`${def.namespacePrefix}.`)
        ? `${def.namespacePrefix}.${def.qualifiedName}`
        : def.qualifiedName;
    return (
      nodeLookup.get(qualifiedKey(def.filePath, targetNode.label, qualifiedName)) === targetNode.id
    );
  });
  if (targetDefs.length !== 1 || targetDefs[0]!.isSynthetic) {
    throw new RenameFailure(
      'stale_graph',
      'The graph identity is not a unique current source declaration.',
    );
  }
  const target = targetDefs[0]!;
  const context: RenameSemanticContext = {
    target,
    definitions,
    files,
    indexes,
    referenceBindings,
    model: before.model,
    graph: before.graph,
    newName: options.new_name,
  };
  reject(provider.checkSafety?.(context));
  const familyResult = provider.symbolFamily?.(context) ?? [target];
  if (isIssue(familyResult)) reject(familyResult);
  const family = familyResult as readonly SymbolDefinition[];
  const familyIds = new Set(family.map((def) => def.nodeId));
  if (
    !familyIds.has(target.nodeId) ||
    family.some((def) => !definitions.includes(def) || def.isSynthetic)
  ) {
    throw new RenameFailure(
      'incomplete_semantics',
      'The provider did not identify a complete source symbol family.',
    );
  }
  assertDeclarationCollisions(context, familyIds, provider);
  const edits = new Map<string, OccurrenceEdit>();
  const accounted = new Set<string>();
  const add = (
    source: RenameSource,
    occurrence: RenameOccurrence,
    selected: boolean,
    targetDefIds: readonly string[],
    site?: ReferenceSite,
  ) => {
    const sourceProvider = sourceResolvers.get(source.path)!.languageProvider.rename!;
    const key = occurrenceKey(source.path, occurrence);
    reject(
      sourceProvider.checkOccurrence?.({
        ...context,
        source,
        occurrence,
        selected,
        targetDefIds,
        site,
      }),
    );
    accounted.add(key);
    if (!selected) return;
    const replacementResult =
      sourceProvider.rewrite?.({ ...context, source, occurrence, newName: options.new_name }) ??
      (occurrence.spans.length === 1
        ? occurrence.spans.map((span) => ({
            ...span,
            oldText: source.content.slice(span.start, span.start + span.length),
            newText: options.new_name,
          }))
        : {
            code: 'unsupported_occurrence',
            message: `The provider has no multipart name rewrite in ${source.path}.`,
            status: 'unsupported' as const,
          });
    if (isIssue(replacementResult)) reject(replacementResult);
    for (const replacement of replacementResult as readonly RenameReplacement[]) {
      if (
        replacement.start < 0 ||
        replacement.length <= 0 ||
        source.content.slice(replacement.start, replacement.start + replacement.length) !==
          replacement.oldText
      )
        throw new RenameFailure(
          'unsupported_occurrence',
          `The provider returned an invalid source span in ${source.path}.`,
          'unsupported',
        );
      const edit: OccurrenceEdit = {
        file_path: source.path,
        start: replacement.start,
        length: replacement.length,
        old_text: replacement.oldText,
        new_text: replacement.newText,
      };
      const id = `${source.path}:${edit.start}:${edit.length}`;
      const previous = edits.get(id);
      if (previous && previous.new_text !== edit.new_text) {
        throw new RenameFailure(
          'unsupported_occurrence',
          'Two symbol identities require incompatible source rewrites.',
          'unsupported',
        );
      }
      edits.set(id, edit);
    }
  };
  for (const def of definitions) {
    const selected = familyIds.has(def.nodeId);
    if (
      !selected &&
      canonical(simpleQualifiedName(def) ?? '', { definition: def }) !==
        canonical(symbol.name, { definition: def })
    )
      continue;
    const source = files.get(def.filePath);
    if (!source)
      throw new RenameFailure(
        'incomplete_semantics',
        'A declaration lies outside the indexed source set.',
      );
    const occurrence =
      occurrenceIndex(source).byDefinitionId.get(def.nodeId) ?? occurrenceAt(source, def.nameRange);
    add(source, occurrence, selected, [def.nodeId]);
  }
  for (const [scopeId, imports] of indexes.imports) {
    const scope = indexes.scopeTree.getScope(scopeId);
    const source = scope && files.get(scope.filePath);
    if (!source) continue;
    for (const edge of imports) {
      const selected = edge.targetDefId !== undefined && familyIds.has(edge.targetDefId);
      const matchesExport =
        canonical(edge.targetExportedName, { definition: target }) ===
        canonical(symbol.name, { definition: target });
      const matchesLocal =
        canonical(edge.localName, { definition: target }) ===
        canonical(symbol.name, { definition: target });
      if (!selected && !matchesExport && !matchesLocal) continue;
      if (!edge.atRange || edge.linkStatus === 'unresolved') {
        throw new RenameFailure(
          'incomplete_semantics',
          `An import of ${symbol.name} is unresolved in ${source.path}.`,
        );
      }
      const candidates = source.occurrences.filter(
        (candidate) =>
          containsRange(edge.atRange!, candidate.range) &&
          canonical(candidate.name, { occurrence: candidate }) ===
            canonical(symbol.name, { occurrence: candidate }),
      );
      if (
        candidates.length === 0 &&
        (edge.kind === 'wildcard-expanded' || edge.kind === 'namespace')
      )
        continue;
      // Distinct imported/local identities are supplied by the provider. A
      // shared span needs an explicit rewrite; guessing by source order is unsafe.
      const exported = candidates.filter(
        (candidate) =>
          candidate.role === 'imported' ||
          (candidate.definitionId !== undefined && candidate.definitionId === edge.targetDefId),
      );
      if (exported.length) {
        for (const occurrence of exported)
          add(source, occurrence, selected, edge.targetDefId ? [edge.targetDefId] : []);
        for (const occurrence of candidates) {
          if (!exported.includes(occurrence)) add(source, occurrence, false, []);
        }
      } else if (candidates.length === 1) {
        add(
          source,
          candidates[0]!,
          selected && (matchesExport || !matchesLocal),
          edge.targetDefId ? [edge.targetDefId] : [],
        );
      } else if (candidates.length !== 0 || matchesExport) {
        throw new RenameFailure(
          'unsupported_occurrence',
          `The import has no unambiguous source identity in ${source.path}.`,
          'unsupported',
        );
      }
    }
  }
  for (const site of indexes.referenceSites) {
    const binding = referenceBindings.get(site);
    const matches = canonical(site.name, { site }) === canonical(symbol.name, { site });
    const selected = binding?.targetDefIds.some((id) => familyIds.has(id)) === true;
    if (!matches && !selected) continue;
    const scope = indexes.scopeTree.getScope(site.inScope);
    const source = scope && files.get(scope.filePath);
    if (!source)
      throw new RenameFailure(
        'incomplete_semantics',
        'A reference lies outside the indexed source set.',
      );
    const occurrence =
      occurrenceIndex(source).byReferenceSite.get(site) ?? occurrenceAt(source, site.nameRange);
    if (accounted.has(occurrenceKey(source.path, occurrence))) continue;
    const completeFamily =
      binding?.status === 'ambiguous' &&
      binding.candidatesComplete === true &&
      binding.targetDefIds.length > 0 &&
      binding.targetDefIds.every((id) => familyIds.has(id));
    if (
      !binding ||
      (binding.status !== 'resolved' && binding.status !== 'blocked' && !completeFamily)
    ) {
      throw new RenameFailure(
        'ambiguous_reference',
        `Cannot prove the written binding of ${site.name} at ${source.path}:${site.atRange.startLine}.`,
      );
    }
    if (selected && binding.targetDefIds.some((id) => !familyIds.has(id))) {
      throw new RenameFailure(
        'ambiguous_reference',
        `The written name denotes several symbol families in ${source.path}.`,
      );
    }
    add(
      source,
      occurrence,
      selected && binding.importAlias === undefined,
      binding.targetDefIds,
      site,
    );
    // `blocked` only says the resolver stopped. It is a negative proof only when
    // it names another declaration, or its basis shows the written name denotes
    // one; a site whose receiver or member lookup stayed unknown may still be a
    // real reference. The provider's own occurrence checks above take precedence.
    if (
      binding.status === 'blocked' &&
      !selected &&
      binding.targetDefIds.length === 0 &&
      !DISTINCT_DECLARATION_BASES.has(binding.basis)
    ) {
      throw new RenameFailure(
        'ambiguous_reference',
        `Cannot prove that ${site.name} at ${source.path}:${site.atRange.startLine} is not a reference to ${symbol.name}: the binding was blocked (${binding.basis}) without identifying another declaration.`,
      );
    }
  }
  for (const source of files.values()) {
    for (const occurrence of source.occurrences) {
      if (
        canonical(occurrence.name, { occurrence }) !== canonical(symbol.name, { occurrence }) ||
        accounted.has(occurrenceKey(source.path, occurrence))
      )
        continue;
      if (occurrence.role === 'unrelated') {
        add(source, occurrence, false, []);
        continue;
      }
      if (occurrence.role === 'binding') {
        const scope = innermostRenameScopeAt(source.parsed, occurrence.range);
        if (
          scope &&
          lookupNameClaim(scope, occurrence.name, indexes, {
            position: occurrence.range,
            purpose: 'value',
          }).status === 'blocked'
        ) {
          add(source, occurrence, false, []);
          continue;
        }
      }
      throw new RenameFailure(
        'incomplete_semantics',
        `Uncovered occurrence in ${source.path}:${occurrence.range.startLine}.`,
      );
    }
  }
  const ordered = [...edits.values()].sort(
    (a, b) => a.file_path.localeCompare(b.file_path) || a.start - b.start,
  );
  const editsByFile = new Map<string, OccurrenceEdit[]>();
  for (const edit of ordered) {
    const group = editsByFile.get(edit.file_path) ?? [];
    if (
      group.length &&
      group[group.length - 1]!.start + group[group.length - 1]!.length > edit.start
    ) {
      throw new RenameFailure(
        'unsupported_occurrence',
        'Provider source rewrites overlap.',
        'unsupported',
      );
    }
    group.push(edit);
    editsByFile.set(edit.file_path, group);
  }
  const updatedFiles = new Map<string, RenameSource>();
  // Re-extract EVERY source: resolution mutates semantic captures and unchanged
  // callers can be captured by a new name without receiving an edit themselves.
  for (const source of files.values()) {
    const fileEdits = editsByFile.get(source.path) ?? [];
    const sourceResolver = sourceResolvers.get(source.path)!;
    const sourceProvider = sourceResolver.languageProvider.rename!;
    const updated = await parseSource(
      sourceProvider,
      sourceResolver,
      source.path,
      applyEdits(source.content, fileEdits),
    );
    reject(
      sourceProvider.validateRewrite?.({
        ...context,
        source,
        updated,
        edits: fileEdits.map(asReplacement),
      }),
    );
    updatedFiles.set(source.path, updated);
  }
  const updatedDefinitions = [...updatedFiles.values()].flatMap((file) => [
    ...file.parsed.localDefs,
  ]);
  const offsetOf = createOffsetLookup();
  const editIndexes = new Map(
    [...editsByFile].map(([filePath, fileEdits]) => [filePath, indexEdits(fileEdits)] as const),
  );
  const definitionMap = matchDefinitions(
    definitions,
    updatedDefinitions,
    files,
    updatedFiles,
    editIndexes,
    offsetOf,
  );
  const definitionsByGraphId = new Map(
    definitions.flatMap((def) => {
      const id = resolveDefGraphId(def.filePath, def, nodeLookup);
      return id ? [[id, def] as const] : [];
    }),
  );
  const updatedDefinitionsById = new Map(updatedDefinitions.map((def) => [def.nodeId, def]));
  const updatedNodes = graphNodes.map((node) => {
    const original = definitionsByGraphId.get(node.id);
    const replacementId = original && definitionMap.get(original.nodeId);
    const replacement = replacementId && updatedDefinitionsById.get(replacementId);
    const updatedSource = replacement && updatedFiles.get(replacement.filePath);
    const replacementName =
      replacement && updatedSource && familyIds.has(original!.nodeId)
        ? (
            occurrenceIndex(updatedSource).byDefinitionId.get(replacement.nodeId) ??
            occurrenceAt(updatedSource, replacement.nameRange)
          ).name
        : node.properties.name;
    return replacement
      ? {
          ...node,
          properties: {
            ...node.properties,
            name: replacementName,
            qualifiedName: replacement.qualifiedName,
            startLine:
              (replacement.declarationRange?.startLine ?? node.properties.startLine! + 1) - 1,
            endLine: (replacement.declarationRange?.endLine ?? node.properties.endLine! + 1) - 1,
          },
        }
      : node;
  });
  const after = resolveSources(updatedFiles, updatedNodes, resolver, resolutionConfig);
  const afterDefinitions = after.observation.parsedFiles.flatMap((file) => [...file.localDefs]);
  const afterTarget = afterDefinitions.find(
    (def) => def.nodeId === definitionMap.get(target.nodeId),
  );
  if (!afterTarget)
    throw new RenameFailure(
      'name_collision',
      'The proposed name changes the selected declaration identity.',
    );
  const afterFamily = provider.symbolFamily?.({
    target: afterTarget,
    definitions: afterDefinitions,
    files: updatedFiles,
    indexes: after.observation.indexes,
    referenceBindings: after.observation.referenceBindings,
    model: after.model,
    graph: after.graph,
    newName: options.new_name,
  }) ?? [afterTarget];
  const expectedFamily = new Set(family.map((def) => definitionMap.get(def.nodeId)));
  if (
    isIssue(afterFamily) ||
    afterFamily.length !== expectedFamily.size ||
    afterFamily.some((def) => !expectedFamily.has(def.nodeId))
  ) {
    throw new RenameFailure(
      'name_collision',
      'The proposed name changes the declaration or override family.',
    );
  }
  assertBindingsPreserved(
    before.observation,
    after.observation,
    files,
    updatedFiles,
    editIndexes,
    definitionMap,
    offsetOf,
  );
  return {
    symbol,
    new_name: options.new_name,
    snapshots,
    edits: ordered,
    coverage: {
      name: 'gitnexus-semantic',
      scope: 'indexed-repository',
      source_file_count: filePaths.length,
      languages: [
        ...new Set([...sourceResolvers.values()].map((sourceResolver) => sourceResolver.language)),
      ],
      limitations: [
        'Only indexed source files covered by this language provider contribute rename locations.',
        'Source files added after the last analyze are not indexed and contribute no rename locations; re-run analyze before renaming if files were added.',
      ],
    },
  };
}

function isIssue(value: unknown): value is RenameIssue {
  return value !== null && typeof value === 'object' && 'code' in value && 'message' in value;
}

function reject(issue: RenameIssue | void): void {
  if (issue)
    throw new RenameFailure(
      issue.code,
      issue.message,
      issue.status === 'unsupported' ? 'unsupported' : 'blocked',
    );
}

async function parseSource(
  provider: RenameProvider,
  resolver: ScopeResolver,
  path: string,
  content: string,
): Promise<RenameSource> {
  let source: RenameSource;
  try {
    source = await provider.parseSource({
      filePath: path,
      content,
      languageProvider: resolver.languageProvider,
      scopeResolver: resolver,
    });
  } catch (error) {
    if (isIssue(error)) reject(error);
    throw error;
  }
  if (source.path !== path || source.content !== content || source.parsed.filePath !== path) {
    throw new RenameFailure(
      'incomplete_semantics',
      `The provider returned a different source identity for ${path}.`,
    );
  }
  return source;
}

function resolveSources(
  files: ReadonlyMap<string, RenameSource>,
  nodes: readonly GraphNode[],
  resolver: ScopeResolver,
  resolutionConfig: unknown,
) {
  const graph = createKnowledgeGraph();
  const languages = new Map(
    [...files].map(([path, source]) => [path, getProviderForFileContent(path, source.content)?.id]),
  );
  for (const node of nodes)
    graph.addNode({
      ...node,
      properties: {
        ...node.properties,
        language: languages.get(node.properties.filePath) ?? node.properties.language,
      },
    });
  const model = createSemanticModel();
  for (const source of files.values()) {
    resolver.populateOwners(source.parsed);
    const sourceProvider = getProviderForFileContent(source.path, source.content)?.rename;
    for (const def of source.parsed.localDefs) {
      const rawName = simpleQualifiedName(def);
      const name =
        rawName && (sourceProvider?.canonicalName?.(rawName, { definition: def }) ?? rawName);
      if (name) model.symbols.add(source.path, name, def.nodeId, def.type, def);
    }
  }
  let observation: SemanticObservation | undefined;
  const warnings: string[] = [];
  const stats = runScopeResolution(
    {
      graph,
      model,
      files: [...files.values()],
      resolutionConfig,
      treeCache: new Map(
        [...files].flatMap(([path, source]) => (source.tree ? [[path, source.tree] as const] : [])),
      ),
      preExtractedParsedFiles: new Map([...files].map(([path, source]) => [path, source.parsed])),
      onWarn: (warning) => warnings.push(warning),
      onResolved: (result) => {
        observation = result;
      },
    },
    resolver,
  );
  if (
    !observation ||
    stats.filesSkipped ||
    stats.scopeExtractionFailedPaths.length ||
    warnings.length
  ) {
    throw new RenameFailure(
      'incomplete_semantics',
      'The semantic pass could not verify every indexed source file.',
    );
  }
  // The ordinary ingestion MRO phase consumes source ownership edges emitted
  // by parsing. Reconstruct those exact edges from the fresh owned definitions
  // before invoking the same phase here; inheritance alone is not an override.
  const definitions = new Map(
    observation.parsedFiles.flatMap((file) =>
      file.localDefs.map((def) => [def.nodeId, def] as const),
    ),
  );
  const lookup = buildGraphNodeLookup(graph);
  for (const def of definitions.values()) {
    const graphId = resolveDefGraphId(def.filePath, def, lookup);
    const node = graphId && graph.getNode(graphId);
    if (!node) continue;
    node.properties.parameterCount = def.parameterCount;
    node.properties.parameterTypes = def.parameterTypes ? [...def.parameterTypes] : undefined;
    const owner = def.ownerId && definitions.get(def.ownerId);
    const ownerGraphId =
      owner && CLASS_KINDS.includes(owner.type) && resolveDefGraphId(owner.filePath, owner, lookup);
    if (ownerGraphId && METHOD_KINDS.includes(def.type))
      graph.addRelationship({
        id: `HAS_METHOD:${ownerGraphId}->${node.id}`,
        sourceId: ownerGraphId,
        targetId: node.id,
        type: 'HAS_METHOD',
        confidence: 1,
        reason: 'fresh-source-ownership',
      });
  }
  computeMRO(graph);
  return { observation, graph, model };
}

function occurrenceKey(path: string, occurrence: RenameOccurrence): string {
  return `${path}:${occurrence.spans.map((span) => `${span.start}:${span.length}`).join(',')}`;
}

/** Lookup tables over one immutable provider source, built on first use. Each
 * holds the FIRST occurrence for a key, exactly what `Array.find` returned. */
interface OccurrenceIndex {
  readonly byReferenceSite: ReadonlyMap<ReferenceSite, RenameOccurrence>;
  readonly byDefinitionId: ReadonlyMap<string, RenameOccurrence>;
  readonly byRange: ReadonlyMap<string, readonly RenameOccurrence[]>;
}

const occurrenceIndexes = new WeakMap<RenameSource, OccurrenceIndex>();

function occurrenceIndex(source: RenameSource): OccurrenceIndex {
  const existing = occurrenceIndexes.get(source);
  if (existing) return existing;
  const byReferenceSite = new Map<ReferenceSite, RenameOccurrence>();
  const byDefinitionId = new Map<string, RenameOccurrence>();
  const byRange = new Map<string, RenameOccurrence[]>();
  for (const occurrence of source.occurrences) {
    if (occurrence.referenceSite && !byReferenceSite.has(occurrence.referenceSite))
      byReferenceSite.set(occurrence.referenceSite, occurrence);
    if (occurrence.definitionId !== undefined && !byDefinitionId.has(occurrence.definitionId))
      byDefinitionId.set(occurrence.definitionId, occurrence);
    const key = rangeKey(occurrence.range);
    const group = byRange.get(key);
    if (group) group.push(occurrence);
    else byRange.set(key, [occurrence]);
  }
  const built = { byReferenceSite, byDefinitionId, byRange };
  occurrenceIndexes.set(source, built);
  return built;
}

function occurrenceAt(source: RenameSource, range: Range | undefined): RenameOccurrence {
  const matches = range && occurrenceIndex(source).byRange.get(rangeKey(range));
  if (!matches || matches.length !== 1) {
    throw new RenameFailure(
      'unsupported_occurrence',
      `The provider has no exact source-name span in ${source.path}.`,
      'unsupported',
    );
  }
  return matches[0]!;
}

/** Edits of one file with the cumulative length change before each, so a
 * position can be relocated or located inside a replacement in O(log n). */
interface EditIndex {
  readonly edits: readonly OccurrenceEdit[];
  /** `shifts[i]` is the net length change of `edits[0..i)`. */
  readonly shifts: readonly number[];
}

function indexEdits(edits: readonly OccurrenceEdit[]): EditIndex {
  const shifts = [0];
  for (const edit of edits)
    shifts.push(shifts[shifts.length - 1]! + edit.new_text.length - edit.length);
  return { edits, shifts };
}

const NO_EDITS = indexEdits([]);

/** Count of leading edits whose start is below (or, with `inclusive`, at) `offset`. */
function editsBefore(index: EditIndex, offset: number, inclusive: boolean): number {
  let low = 0;
  let high = index.edits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = index.edits[middle]!.start;
    if (start < offset || (inclusive && start === offset)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The edit whose replaced span holds `offset`, if any. Edits never overlap. */
function editContaining(index: EditIndex, offset: number): OccurrenceEdit | undefined {
  const count = editsBefore(index, offset, true);
  const edit = count > 0 ? index.edits[count - 1] : undefined;
  return edit && offset < edit.start + edit.length ? edit : undefined;
}

/** Where an original-source offset lands after the edits (see `relocated`). */
function relocate(index: EditIndex, offset: number): number {
  const count = editsBefore(index, offset, false);
  const edit = count > 0 ? index.edits[count - 1] : undefined;
  if (edit && offset < edit.start + edit.length) return edit.start + index.shifts[count - 1]!;
  return offset + index.shifts[count]!;
}

function assertDeclarationCollisions(
  context: RenameSemanticContext,
  family: ReadonlySet<string>,
  provider: RenameProvider,
): void {
  const canonical = (name: string, definition: SymbolDefinition) =>
    provider.canonicalName?.(name, { definition }) ?? name;
  for (const source of context.files.values()) {
    for (const scope of source.parsed.scopes) {
      const selected = [...scope.bindings.values()]
        .flat()
        .find((binding) => family.has(binding.def.nodeId) && binding.origin === 'local');
      if (!selected) continue;
      for (const [name, bindings] of scope.bindings) {
        if (canonical(name, selected.def) !== canonical(context.newName, selected.def)) continue;
        if (bindings.some((binding) => !family.has(binding.def.nodeId))) {
          throw new RenameFailure(
            'name_collision',
            'The proposed name already belongs to another declaration in this scope.',
          );
        }
      }
    }
  }
}

function asReplacement(edit: OccurrenceEdit): RenameReplacement {
  return { start: edit.start, length: edit.length, oldText: edit.old_text, newText: edit.new_text };
}

function declarationPosition(def: SymbolDefinition): { line: number; column: number } | undefined {
  const position = definitionIdPosition(def.nodeId, def.filePath);
  return (
    position ??
    (def.declarationRange && {
      line: def.declarationRange.startLine,
      column: def.declarationRange.startCol,
    })
  );
}

function matchDefinitions(
  before: readonly SymbolDefinition[],
  after: readonly SymbolDefinition[],
  files: ReadonlyMap<string, RenameSource>,
  updated: ReadonlyMap<string, RenameSource>,
  edits: ReadonlyMap<string, EditIndex>,
  offsetOf: ReturnType<typeof createOffsetLookup>,
): ReadonlyMap<string, string> {
  const candidates = new Map<string, SymbolDefinition[]>();
  for (const def of after) {
    const position = declarationPosition(def);
    const source = updated.get(def.filePath);
    if (!position || !source) continue;
    const key = `${def.filePath}:${def.type}:${offsetOf(source, position.line, position.column)}`;
    const group = candidates.get(key) ?? [];
    group.push(def);
    candidates.set(key, group);
  }
  const matches = new Map<string, string>();
  for (const def of before) {
    const position = declarationPosition(def);
    const source = files.get(def.filePath);
    if (!position || !source) continue;
    const offset = relocate(
      edits.get(def.filePath) ?? NO_EDITS,
      offsetOf(source, position.line, position.column),
    );
    const atPosition = candidates.get(`${def.filePath}:${def.type}:${offset}`);
    // Synthetic accessors share their property's range but remain distinct
    // declarations. Their signatures survive renaming and distinguish them.
    const group =
      atPosition && atPosition.length > 1
        ? atPosition.filter(
            (candidate) =>
              candidate.parameterCount === def.parameterCount &&
              candidate.requiredParameterCount === def.requiredParameterCount &&
              JSON.stringify(candidate.parameterTypes) === JSON.stringify(def.parameterTypes),
          )
        : atPosition;
    if (group?.length !== 1) {
      throw new RenameFailure(
        'name_collision',
        `The proposed rewrite changes declaration identity in ${def.filePath}.`,
      );
    }
    matches.set(def.nodeId, group[0]!.nodeId);
  }
  return matches;
}

function bindingIds(binding: SourceBindingResolution, map?: ReadonlyMap<string, string>): string {
  return [...new Set(binding.targetDefIds.map((id) => map?.get(id) ?? id))].sort().join('\0');
}

/** The sites at `[from, to)` in a list sorted by offset. */
function sitesWithin(
  sorted: readonly { offset: number; site: ReferenceSite }[],
  from: number,
  to: number,
): ReferenceSite[] {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]!.offset < from) low = middle + 1;
    else high = middle;
  }
  const within: ReferenceSite[] = [];
  for (let i = low; i < sorted.length && sorted[i]!.offset < to; i++) within.push(sorted[i]!.site);
  return within;
}

function assertBindingsPreserved(
  before: SemanticObservation,
  after: SemanticObservation,
  files: ReadonlyMap<string, RenameSource>,
  updated: ReadonlyMap<string, RenameSource>,
  edits: ReadonlyMap<string, EditIndex>,
  definitions: ReadonlyMap<string, string>,
  offsetOf: ReturnType<typeof createOffsetLookup>,
): void {
  const nextSites = new Map<string, ReferenceSite[]>();
  const nextPositions = new Map<string, { offset: number; site: ReferenceSite }[]>();
  for (const site of after.indexes.referenceSites) {
    const path = after.indexes.scopeTree.getScope(site.inScope)?.filePath;
    const source = path && updated.get(path);
    const range = site.nameRange ?? site.atRange;
    if (!source) continue;
    const offset = offsetOf(source, range.startLine, range.startCol);
    const prefix = `${source.path}:${site.kind}:${site.callForm ?? ''}`;
    const key = `${prefix}:${offset}`;
    const group = nextSites.get(key) ?? [];
    group.push(site);
    nextSites.set(key, group);
    const positions = nextPositions.get(prefix) ?? [];
    positions.push({ offset, site });
    nextPositions.set(prefix, positions);
  }
  // Sorted once, so the sites inside one expanded replacement are a contiguous run.
  for (const positions of nextPositions.values()) positions.sort((a, b) => a.offset - b.offset);
  for (const site of before.indexes.referenceSites) {
    const path = before.indexes.scopeTree.getScope(site.inScope)?.filePath;
    const source = path && files.get(path);
    const range = site.nameRange ?? site.atRange;
    if (!source)
      throw new RenameFailure(
        'incomplete_semantics',
        'A reference lies outside the validated source set.',
      );
    const originalOffset = offsetOf(source, range.startLine, range.startCol);
    const fileEdits = edits.get(source.path) ?? NO_EDITS;
    const offset = relocate(fileEdits, originalOffset);
    const replacement = editContaining(fileEdits, originalOffset);
    // A provider may expand a shared token into several names. Match the
    // original binding inside that exact replacement, never by global spelling.
    const replacementStart = replacement && relocate(fileEdits, replacement.start);
    const candidates = replacement
      ? sitesWithin(
          nextPositions.get(`${source.path}:${site.kind}:${site.callForm ?? ''}`) ?? [],
          replacementStart!,
          replacementStart! + replacement.new_text.length,
        )
      : nextSites.get(`${source.path}:${site.kind}:${site.callForm ?? ''}:${offset}`);
    const previous = before.referenceBindings.get(site);
    const matches = previous
      ? (candidates ?? []).filter((candidate) => {
          const next = after.referenceBindings.get(candidate);
          return (
            next &&
            previous.status === next.status &&
            previous.candidatesComplete === next.candidatesComplete &&
            bindingIds(previous, definitions) === bindingIds(next) &&
            (previous.importAlias !== undefined) === (next.importAlias !== undefined)
          );
        })
      : [];
    const positionOf = (candidate: ReferenceSite): number => {
      const nextRange = candidate.nameRange ?? candidate.atRange;
      return offsetOf(updated.get(source.path)!, nextRange.startLine, nextRange.startCol);
    };
    const matchedPositions = new Set(matches.map(positionOf));
    // Capture queries can describe the same reference more than once. Accept
    // equivalent evidence at one token, but never conflicting bindings there
    // or multiple matching tokens inside an expanded shorthand replacement.
    if (
      matchedPositions.size !== 1 ||
      candidates?.filter((candidate) => matchedPositions.has(positionOf(candidate))).length !==
        matches.length
    ) {
      throw new RenameFailure(
        'name_collision',
        `The proposed name changes a source binding in ${source.path}:${range.startLine}.`,
      );
    }
  }
}
