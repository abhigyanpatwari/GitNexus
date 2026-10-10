import fs from 'node:fs/promises';
import type Parser from 'tree-sitter';
import {
  CLASS_KINDS,
  SupportedLanguages,
  getLanguageFromFilename,
  type GraphNode,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../core/graph/graph.js';
import { createSemanticModel } from '../../../core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../core/ingestion/model/scope-resolution-indexes.js';
import { lookupOwnedMembersByOwner } from '../../../core/ingestion/model/owned-members-lookup.js';
import { createReferenceLookup } from '../../../core/ingestion/resolve-references.js';
import { extractParsedFile } from '../../../core/ingestion/scope-extractor-bridge.js';
import { SCOPE_RESOLVERS } from '../../../core/ingestion/scope-resolution/pipeline/registry.js';
import { runScopeResolution } from '../../../core/ingestion/scope-resolution/pipeline/run.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
} from '../../../core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import {
  resolveDefGraphId,
  simpleQualifiedName,
} from '../../../core/ingestion/scope-resolution/graph-bridge/ids.js';
import { lookupNameClaim } from '../../../core/ingestion/scope-resolution/scope/walkers.js';
import { definitionIdPosition } from '../../../core/ingestion/scope-resolution/utils/definition-id.js';
import { createParserForLanguage } from '../../../core/tree-sitter/parser-loader.js';
import {
  RenameFailure,
  repositoryPath,
  type RenameOptions,
  type RenamePlan,
  type RenameSymbol,
  type OccurrenceEdit,
} from './rename-plan.js';

interface SourceFile {
  path: string;
  content: string;
  tree: Parser.Tree;
  parsed: ParsedFile;
  tokens: Parser.SyntaxNode[];
  namedOccurrences: Parser.SyntaxNode[];
  tokensByRange: Map<string, Parser.SyntaxNode>;
  tokensByStart: Map<number, Parser.SyntaxNode>;
}

/** A fresh semantic pass uses indexed graph identities, never name-search edits. */
export async function planGraphRename(
  repoPath: string,
  symbol: RenameSymbol,
  options: RenameOptions,
  graphNodes: readonly GraphNode[],
  referenceFiles: readonly string[] = [],
): Promise<RenamePlan> {
  const language = getLanguageFromFilename(symbol.filePath);
  const resolver = language === undefined ? undefined : SCOPE_RESOLVERS.get(language);
  if (!language || !resolver || resolver.scopeResolutionEdgeMode === 'callable-flow-only') {
    throw new RenameFailure(
      'unsupported_language',
      'This language has no complete semantic rename provider.',
      'unsupported',
    );
  }
  if (language === SupportedLanguages.PHP) {
    throw new RenameFailure(
      'unsupported_language',
      'The PHP provider does not yet prove complete rename coverage for case-insensitive names.',
      'unsupported',
    );
  }
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
  if (
    typeof options.new_name !== 'string' ||
    !options.new_name ||
    options.new_name === symbol.name
  ) {
    throw new RenameFailure('invalid_name', 'Choose a different, nonempty identifier.');
  }
  const graph = createKnowledgeGraph();
  for (const node of graphNodes) graph.addNode(node);
  const nodeLookup = buildGraphNodeLookup(graph);
  const model = createSemanticModel();
  const snapshots = new Map<string, string>();
  const files = new Map<string, SourceFile>();
  const filePaths = [
    ...new Set(
      graphNodes
        .filter(
          (node) =>
            node.label === 'File' && getLanguageFromFilename(node.properties.filePath) === language,
        )
        .map((node) => node.properties.filePath),
    ),
  ];
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
  const root = await fs.realpath(repoPath);
  for (const filePath of filePaths.sort()) {
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
    snapshots.set(absolute, content);
    if (!content.trim()) continue;
    const parser = await createParserForLanguage(language, filePath);
    if (
      parser
        .getLanguage()
        .nodeTypeInfo.some((info) => !info.named && info.type === options.new_name)
    ) {
      throw new RenameFailure(
        'invalid_name',
        'The proposed name is a reserved syntax token in this language.',
      );
    }
    const parseText = resolver.languageProvider.preprocessSource?.(content, filePath) ?? content;
    if (parseText !== content) {
      throw new RenameFailure(
        'unsupported_source',
        `Rename cannot prove offsets for transformed source: ${filePath}`,
        'unsupported',
      );
    }
    const tree = parser.parse(content);
    if (!tree || tree.rootNode.hasError) {
      throw new RenameFailure('parse_error', `Cannot establish semantic coverage for ${filePath}.`);
    }
    const parsed = extractParsedFile(resolver.languageProvider, content, filePath, undefined, tree);
    if (!parsed)
      throw new RenameFailure(
        'incomplete_semantics',
        `Scope extraction is unavailable for ${filePath}.`,
      );
    resolver.populateOwners(parsed);
    for (const def of parsed.localDefs) {
      const name = simpleQualifiedName(def);
      if (name) model.symbols.add(filePath, name, def.nodeId, def.type, def);
    }
    const tokens = sourceTokens(tree.rootNode);
    const namedOccurrences = tokens.filter((token) => token.text === symbol.name);
    const tokensByRange = new Map<string, Parser.SyntaxNode>();
    const tokensByStart = new Map<number, Parser.SyntaxNode>();
    for (const token of namedOccurrences) {
      const range = tokenRangeKey(token);
      if (!tokensByRange.has(range)) tokensByRange.set(range, token);
      if (!tokensByStart.has(token.startIndex)) tokensByStart.set(token.startIndex, token);
    }
    files.set(filePath, {
      path: filePath,
      content,
      tree,
      parsed,
      tokens,
      namedOccurrences,
      tokensByRange,
      tokensByStart,
    });
  }
  let observation:
    | { readonly parsedFiles: readonly ParsedFile[]; readonly indexes: ScopeResolutionIndexes }
    | undefined;
  const warnings: string[] = [];
  const stats = runScopeResolution(
    {
      graph,
      model,
      files: [...files.values()],
      treeCache: new Map([...files].map(([filePath, file]) => [filePath, file.tree])),
      preExtractedParsedFiles: new Map(
        [...files].map(([filePath, file]) => [filePath, file.parsed]),
      ),
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
  const { parsedFiles, indexes } = observation;
  if (
    [...files.values()].some((file) => file.tokens.some((token) => token.text === options.new_name))
  ) {
    throw new RenameFailure(
      'name_collision',
      'The proposed name already occurs in the indexed language scope.',
    );
  }
  const definitions = parsedFiles.flatMap((file) => [...file.localDefs]);
  const targetDefs = definitions.filter(
    (def) =>
      def.filePath === symbol.filePath &&
      simpleQualifiedName(def) === symbol.name &&
      definitionIdPosition(def.nodeId, def.filePath)?.line === symbol.startLine &&
      (symbol.endLine === undefined || def.declarationRange?.endLine === symbol.endLine) &&
      def.qualifiedName !== undefined &&
      nodeLookup.get(
        qualifiedKey(
          def.filePath,
          targetNode.label,
          def.namespacePrefix && !def.qualifiedName.startsWith(`${def.namespacePrefix}.`)
            ? `${def.namespacePrefix}.${def.qualifiedName}`
            : def.qualifiedName,
        ),
      ) === targetNode.id &&
      resolveDefGraphId(def.filePath, def, nodeLookup) === targetNode.id,
  );
  if (targetDefs.length !== 1 || targetDefs[0]!.isSynthetic) {
    throw new RenameFailure(
      'stale_graph',
      'The graph identity is not a unique current source declaration.',
    );
  }
  const target = targetDefs[0]!;
  if (
    CLASS_KINDS.includes(target.type) &&
    (definitions.some(
      (def) => def.ownerId === target.nodeId && simpleQualifiedName(def) === symbol.name,
    ) ||
      [...files.values()].some((file) =>
        file.namedOccurrences.some((token) => isNameCoupledDeclaration(token)),
      ))
  ) {
    throw new RenameFailure(
      'unsupported_symbol_family',
      'Renaming a class with name-coupled constructors or destructors requires a complete symbol-family plan.',
      'unsupported',
    );
  }
  if (target.ownerId) {
    const owner = definitions.find((def) => def.nodeId === target.ownerId);
    if (owner && CLASS_KINDS.includes(owner.type) && simpleQualifiedName(owner) === symbol.name) {
      throw new RenameFailure(
        'unsupported_symbol_family',
        'Renaming a name-coupled constructor or destructor requires a complete symbol-family plan.',
        'unsupported',
      );
    }
    const ownerGraphId = owner && resolveDefGraphId(owner.filePath, owner, nodeLookup);
    if (
      ownerGraphId &&
      [...graph.iterRelationships()].some(
        (edge) =>
          (edge.type === 'EXTENDS' || edge.type === 'IMPLEMENTS') &&
          (edge.sourceId === ownerGraphId || edge.targetId === ownerGraphId),
      )
    ) {
      throw new RenameFailure(
        'unsupported_symbol_family',
        'Renaming an inherited or interface member requires a complete symbol-family plan.',
        'unsupported',
      );
    }
  }
  if (definitions.some((def) => simpleQualifiedName(def) === options.new_name)) {
    throw new RenameFailure(
      'name_collision',
      'The proposed name already belongs to a definition in the indexed language scope.',
    );
  }
  const lookup = createReferenceLookup({
    scopes: indexes,
    providers: { arityCompatibility: resolver.arityCompatibility },
    ownedMembersByOwner: (owner, name) => lookupOwnedMembersByOwner(model, owner, name),
  });
  const boundMembers = (site: ReferenceSite): readonly SymbolDefinition[] | undefined => {
    if (!site.explicitReceiver) return undefined;
    const receiverClaim = lookupNameClaim(site.inScope, site.explicitReceiver.name, indexes, {
      position: site.atRange,
      purpose: 'value',
    });
    const type = receiverClaim.typeBinding;
    if (
      type?.source === 'decorator-unknown' ||
      (type?.declaredSpelling && type.declaredSpelling !== type.rawName)
    )
      return [];
    const owners = type
      ? lookupNameClaim(type.declaredAtScope, type.rawName, indexes, {
          position: type.lookupPosition ?? site.atRange,
          purpose: 'type',
        }).bindings
      : receiverClaim.bindings;
    const classOwners = [
      ...new Map(
        owners
          .filter((binding) => CLASS_KINDS.includes(binding.def.type))
          .map((binding) => [binding.def.nodeId, binding.def]),
      ).values(),
    ];
    if (classOwners.length !== 1) return undefined;
    return lookupOwnedMembersByOwner(model, classOwners[0]!.nodeId, site.name);
  };
  const edits = new Map<string, OccurrenceEdit>();
  const accounted = new Set<string>();
  const key = (file: string, start: number) => `${file}:${start}`;
  const add = (file: SourceFile, token: Parser.SyntaxNode, rename: boolean) => {
    const id = key(file.path, token.startIndex);
    accounted.add(id);
    if (!rename) return;
    // Shorthand keys and bindings have a second semantic identity. Until a
    // provider describes its rewrite, changing only the token would corrupt it.
    if (token.type.includes('shorthand') || token.parent?.type.includes('shorthand')) {
      throw new RenameFailure(
        'unsupported_occurrence',
        `Shorthand occurrence needs a provider rewrite: ${file.path}:${token.startPosition.row + 1}`,
        'unsupported',
      );
    }
    edits.set(id, {
      file_path: file.path,
      start: token.startIndex,
      length: token.endIndex - token.startIndex,
      old_text: symbol.name,
      new_text: options.new_name,
    });
  };
  const tokenAtRange = (file: SourceFile, range: Range | undefined): Parser.SyntaxNode => {
    const token =
      range &&
      file.tokensByRange.get(
        `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`,
      );
    if (!token)
      throw new RenameFailure(
        'unsupported_occurrence',
        `The provider has no exact identifier span in ${file.path}.`,
        'unsupported',
      );
    return token;
  };
  for (const def of definitions) {
    if (simpleQualifiedName(def) !== symbol.name) continue;
    const file = files.get(def.filePath)!;
    add(file, tokenAtRange(file, def.nameRange), def.nodeId === target.nodeId);
  }
  // Finalized import provenance identifies the exported token. Aliased local
  // names retain their spelling; their later usages are a separate binding.
  for (const [scopeId, imports] of indexes.imports) {
    const scope = indexes.scopeTree.getScope(scopeId);
    const file = scope && files.get(scope.filePath);
    if (!file) continue;
    for (const edge of imports) {
      if (edge.targetExportedName !== symbol.name && edge.localName !== symbol.name) continue;
      if (!edge.atRange || edge.linkStatus === 'unresolved') {
        throw new RenameFailure(
          'incomplete_semantics',
          `An import of ${symbol.name} is unresolved in ${file.path}.`,
        );
      }
      const candidates = file.namedOccurrences.filter((token) => contains(edge.atRange!, token));
      const isTarget = edge.targetDefId === target.nodeId;
      if (candidates.length !== 1) {
        throw new RenameFailure(
          'unsupported_occurrence',
          `The import has no unambiguous source token in ${file.path}.`,
          'unsupported',
        );
      }
      add(file, candidates[0]!, isTarget && edge.targetExportedName === symbol.name);
    }
  }
  for (const site of indexes.referenceSites) {
    if (site.name !== symbol.name) continue;
    const scope = indexes.scopeTree.getScope(site.inScope);
    const file = scope && files.get(scope.filePath);
    if (!file)
      throw new RenameFailure(
        'incomplete_semantics',
        'A reference points outside the indexed source set.',
      );
    const token = tokenAtRange(file, site.nameRange);
    if (accounted.has(key(file.path, token.startIndex))) continue;
    const claim =
      site.explicitReceiver === undefined
        ? lookupNameClaim(site.lookupScope ?? site.inScope, site.name, indexes, {
            position: site.atRange,
            purpose:
              site.lookupPurpose ??
              (site.kind === 'type-reference' || site.kind === 'inherits' ? 'type' : 'value'),
          })
        : undefined;
    const members = boundMembers(site);
    const resolutions =
      members !== undefined || claim?.bindings.length || claim?.status === 'blocked'
        ? []
        : lookup(site);
    if (
      resolutions.some(
        (resolution) =>
          !resolution.evidence.some((evidence) => evidence.kind === 'type-binding') ||
          !resolution.evidence.some((evidence) => evidence.kind === 'owner-match') ||
          resolution.evidence.some(
            (evidence) =>
              evidence.kind === 'global-name' ||
              evidence.kind === 'global-qualified' ||
              evidence.kind === 'dynamic-import-unresolved',
          ),
      )
    ) {
      throw new RenameFailure(
        'ambiguous_reference',
        `Only heuristic evidence resolves ${symbol.name} at ${file.path}:${site.atRange.startLine}.`,
      );
    }
    const candidates =
      members ??
      (claim?.bindings.length
        ? claim.bindings.map((binding) => binding.def)
        : claim?.status === 'blocked'
          ? []
          : resolutions.map((resolution) => resolution.def));
    const ids = new Set(candidates.map((def) => def.nodeId));
    if (ids.size > 1 || (ids.size === 0 && claim?.status !== 'blocked')) {
      throw new RenameFailure(
        'ambiguous_reference',
        `Cannot prove the target of ${symbol.name} at ${file.path}:${site.atRange.startLine}.`,
      );
    }
    add(file, token, ids.has(target.nodeId));
  }
  // Audit every source identifier with the same spelling. This catches syntax
  // that a provider has not captured instead of claiming a complete rename.
  for (const file of files.values()) {
    if (hasComputedAccess(file.tree.rootNode)) {
      throw new RenameFailure(
        'unsupported_occurrence',
        `A computed member access prevents complete rename coverage in ${file.path}.`,
        'unsupported',
      );
    }
    for (const token of file.tokens) {
      if (token.text === symbol.name && hasCompoundBinding(token)) {
        throw new RenameFailure(
          'unsupported_occurrence',
          `An alias or destructuring binding needs a provider rewrite in ${file.path}.`,
          'unsupported',
        );
      }
      if (token.text !== symbol.name || accounted.has(key(file.path, token.startIndex))) continue;
      if (isUnrelatedLabel(token)) {
        add(file, token, false);
        continue;
      }
      // Parameters may be represented by a scope blocker rather than a symbol
      // definition. That proof can preserve the binder, but must never authorize
      // an edit to an uncaptured token. Only provider reference sites do that.
      if (isParameterBinder(token)) {
        const scope = innermostScope(file.parsed, token);
        if (
          scope &&
          lookupNameClaim(scope, token.text, indexes, {
            position: {
              startLine: token.startPosition.row + 1,
              startCol: token.startPosition.column,
            },
            purpose: 'value',
          }).status === 'blocked'
        ) {
          add(file, token, false);
          continue;
        }
      }
      throw new RenameFailure(
        'incomplete_semantics',
        `Uncovered occurrence in ${file.path}:${token.startPosition.row + 1}.`,
      );
    }
  }
  const ordered = [...edits.values()].sort(
    (a, b) => a.file_path.localeCompare(b.file_path) || a.start - b.start,
  );
  const editsByFile = new Map<string, OccurrenceEdit[]>();
  for (const edit of ordered) {
    const group = editsByFile.get(edit.file_path) ?? [];
    group.push(edit);
    editsByFile.set(edit.file_path, group);
  }
  for (const file of files.values()) {
    const fileEdits = editsByFile.get(file.path);
    if (!fileEdits) continue;
    const pieces: string[] = [];
    let cursor = 0;
    for (const edit of fileEdits) {
      pieces.push(file.content.slice(cursor, edit.start), edit.new_text);
      cursor = edit.start + edit.length;
    }
    pieces.push(file.content.slice(cursor));
    const updated = pieces.join('');
    const parser = await createParserForLanguage(language, file.path);
    const validated = parser.parse(updated);
    const updatedTokens = new Map<number, Parser.SyntaxNode>();
    for (const token of validated ? sourceTokens(validated.rootNode) : []) {
      if (!updatedTokens.has(token.startIndex)) updatedTokens.set(token.startIndex, token);
    }
    let delta = 0;
    for (const edit of fileEdits) {
      const original = file.tokensByStart.get(edit.start)!;
      const replacement = updatedTokens.get(edit.start + delta);
      if (
        !validated ||
        validated.rootNode.hasError ||
        !replacement ||
        replacement.text !== options.new_name ||
        replacement.type !== original.type ||
        replacement.parent?.type !== original.parent?.type
      ) {
        throw new RenameFailure(
          'invalid_name',
          'The proposed name does not preserve the source identifier syntax.',
        );
      }
      delta += edit.new_text.length - edit.length;
    }
  }
  return {
    symbol,
    new_name: options.new_name,
    snapshots,
    edits: ordered,
    coverage: {
      name: 'gitnexus-semantic',
      scope: 'indexed-repository',
      source_file_count: filePaths.length,
      languages: [language],
      limitations: [
        'Only indexed files in this language are covered.',
        'Computed accesses, incomplete symbol families, and uncaptured identifier roles are refused.',
      ],
    },
  };
}

function contains(range: Range, node: Parser.SyntaxNode): boolean {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return (
    (startLine > range.startLine ||
      (startLine === range.startLine && node.startPosition.column >= range.startCol)) &&
    (endLine < range.endLine ||
      (endLine === range.endLine && node.endPosition.column <= range.endCol))
  );
}

function sourceTokens(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const tokens: Parser.SyntaxNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type.includes('comment')) continue;
    if (node.namedChildCount === 0) {
      if (
        node.isNamed &&
        !node.type.includes('string') &&
        !node.type.includes('template_chars') &&
        !node.type.includes('escape')
      )
        tokens.push(node);
    } else pending.push(...node.namedChildren);
  }
  return tokens;
}

function innermostScope(parsed: ParsedFile, token: Parser.SyntaxNode): string | undefined {
  let result: ParsedFile['scopes'][number] | undefined;
  for (const scope of parsed.scopes) {
    if (
      contains(scope.range, token) &&
      (!result ||
        scope.range.startLine > result.range.startLine ||
        (scope.range.startLine === result.range.startLine &&
          scope.range.startCol >= result.range.startCol))
    )
      result = scope;
  }
  return result?.id;
}

function hasComputedAccess(root: Parser.SyntaxNode): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type.includes('comment')) continue;
    // Raw key spelling cannot establish identity: variables, concatenations,
    // escapes, and runtime receivers may all denote the selected member. Until
    // providers expose complete key/owner proofs, refuse every computed access.
    if (
      node.childForFieldName('index') ||
      node.childForFieldName('subscript') ||
      [
        'subscript_expression',
        'subscript',
        'element_access_expression',
        'index_expression',
        'array_access',
        'element_reference',
        'computed_property_name',
      ].includes(node.type)
    )
      return true;
    pending.push(...node.namedChildren);
  }
  return false;
}

function isNameCoupledDeclaration(token: Parser.SyntaxNode): boolean {
  return (
    token.parent?.type === 'destructor_name' ||
    ((token.parent?.type === 'constructor_declaration' ||
      token.parent?.type === 'compact_constructor_declaration' ||
      token.parent?.type === 'destructor_declaration') &&
      token.parent.childForFieldName('name')?.id === token.id)
  );
}

function isUnrelatedLabel(token: Parser.SyntaxNode): boolean {
  const parent = token.parent;
  if (!parent) return false;
  if (parent.childForFieldName('key')?.id === token.id) return true;
  if (parent.type === 'keyword_argument' && parent.childForFieldName('name')?.id === token.id)
    return true;
  if (parent.type === 'jsx_attribute' && parent.firstNamedChild?.id === token.id) return true;
  return (
    ['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'].includes(
      parent.type,
    ) &&
    parent.childForFieldName('name')?.id === token.id &&
    /^[a-z]/.test(token.text)
  );
}

function isParameterBinder(token: Parser.SyntaxNode): boolean {
  const parent = token.parent;
  if (!parent) return false;
  return (
    ((parent.type === 'required_parameter' || parent.type === 'optional_parameter') &&
      parent.childForFieldName('pattern')?.id === token.id) ||
    parent.type === 'formal_parameters' ||
    parent.type === 'parameters'
  );
}

function hasCompoundBinding(token: Parser.SyntaxNode): boolean {
  let parent = token.parent;
  while (parent) {
    if (
      parent.type.includes('pattern') ||
      (parent.type.includes('export') && parent.childForFieldName('alias'))
    )
      return true;
    if (parent.type.includes('statement') || parent.type.includes('declaration')) break;
    parent = parent.parent;
  }
  return false;
}

function tokenRangeKey(token: Parser.SyntaxNode): string {
  return `${token.startPosition.row + 1}:${token.startPosition.column}:${token.endPosition.row + 1}:${token.endPosition.column}`;
}
