import { glob } from 'glob';
import {
  Kind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import { getMaxFileSizeBytes } from '../../ingestion/utils/max-file-size.js';
import { logger } from '../../logger.js';
import { ParseTimeoutError, parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafeBounded } from './fs-utils.js';

const PROVIDER_GLOB = '**/*.{ts,tsx,mts,cts}';
const DOCUMENT_GLOB = '**/*.{graphql,gql}';
const NEST_GRAPHQL_PACKAGE = '@nestjs/graphql';
const MAX_GRAPHQL_TOKENS = 100_000;
const MAX_GRAPHQL_DEFINITIONS = 5_000;
const MAX_GRAPHQL_OPERATIONS = 500;
const MAX_GRAPHQL_SELECTIONS = 10_000;
const MAX_GRAPHQL_TRAVERSAL_DEPTH = 64;
const MAX_PROVIDER_AST_NODES = 100_000;
const MAX_PROVIDER_AST_DEPTH = 256;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

type GraphqlOperationKind = 'query' | 'mutation' | 'subscription';

interface ResolvedSymbol {
  uid: string;
  name: string;
  filePath: string;
}

interface DecoratorBindings {
  operations: Map<string, GraphqlOperationKind>;
  resolvers: Set<string>;
}

type DecoratorFieldName =
  | { kind: 'absent' }
  | { kind: 'literal'; value: string }
  | { kind: 'dynamic' };

type GeneratedSymbolIndex = Map<string, Parser.SyntaxNode[]>;
type GeneratedIndexCache = Map<string, Promise<GeneratedSymbolIndex | null>>;

export const RESOLVE_METHOD_QUERY = `
MATCH (n)
WHERE labels(n) IN ['Method','Function','Property','CodeElement']
  AND n.name = $name AND n.filePath = $filePath AND n.startLine = $startLine AND n.id <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
ORDER BY n.id ASC
LIMIT 2`;

// LadybugDB returns labels(n) as a scalar string, not Neo4j's string array.
// The real-db integration test executes this exact query and guards that dialect contract.
export const RESOLVE_GENERATED_SYMBOL_QUERY = `
MATCH (n)
WHERE labels(n) IN ['Const','Variable','Function','Method','CodeElement']
  AND n.name = $name AND n.filePath <> '' AND n.id <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
ORDER BY n.id ASC
LIMIT 2`;

function rowValue(row: Record<string, unknown>, key: string, position: number): string {
  return String(row[key] ?? row[position] ?? '');
}

function uniqueRealSymbol(rows: Record<string, unknown>[]): ResolvedSymbol | null {
  if (rows.length !== 1) return null;
  const row = rows[0];
  const symbol = {
    uid: rowValue(row, 'uid', 0),
    name: rowValue(row, 'name', 1),
    filePath: rowValue(row, 'filePath', 2).replace(/\\/g, '/'),
  };
  return symbol.uid && symbol.name && symbol.filePath ? symbol : null;
}

function unquote(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || trimmed.at(-1) !== quote) return null;
  const value = trimmed.slice(1, -1);
  return value.includes('${') ? null : value;
}

function unwrapExpression(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current = node;
  while (
    ['as_expression', 'satisfies_expression', 'parenthesized_expression'].includes(current.type) &&
    current.namedChildren[0]
  ) {
    current = current.namedChildren[0];
  }
  return current;
}

function objectPairValue(node: Parser.SyntaxNode, key: string): Parser.SyntaxNode | null {
  const object = unwrapExpression(node);
  if (object.type !== 'object') return null;
  for (const pair of object.namedChildren) {
    if (pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const pairKey = keyNode ? (unquote(keyNode.text) ?? keyNode.text) : null;
    if (pairKey === key) return pair.childForFieldName('value');
  }
  return null;
}

function literalValue(node: Parser.SyntaxNode | null): string | null {
  return node ? unquote(unwrapExpression(node).text) : null;
}

function graphqlNameValue(node: Parser.SyntaxNode | null): string | null {
  return node ? literalValue(objectPairValue(node, 'value')) : null;
}

function withinGeneratedAstBudget(root: Parser.SyntaxNode): boolean {
  const pending: Array<{ node: Parser.SyntaxNode; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited++;
    if (visited > MAX_PROVIDER_AST_NODES || current.depth > MAX_PROVIDER_AST_DEPTH) return false;
    for (let index = current.node.namedChildren.length - 1; index >= 0; index--) {
      const child = current.node.namedChildren[index];
      if (child) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function generatedRootFields(
  selectionSet: Parser.SyntaxNode | null,
  fragments: ReadonlyMap<string, Parser.SyntaxNode>,
): Set<string> | null {
  const fields = new Set<string>();
  if (!selectionSet) return null;
  const seenFragments = new Set<string>();
  const pending: Array<{ selectionSet: Parser.SyntaxNode; depth: number }> = [
    { selectionSet, depth: 0 },
  ];
  let selectionsVisited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > MAX_GRAPHQL_TRAVERSAL_DEPTH) return null;
    const selections = objectPairValue(current.selectionSet, 'selections');
    const array = selections ? unwrapExpression(selections) : null;
    if (!array || array.type !== 'array') return null;
    for (const item of array.namedChildren) {
      selectionsVisited++;
      if (selectionsVisited > MAX_GRAPHQL_SELECTIONS) return null;
      const selection = unwrapExpression(item);
      const kind = literalValue(objectPairValue(selection, 'kind'));
      if (kind === 'Field') {
        const field = graphqlNameValue(objectPairValue(selection, 'name'));
        if (field) fields.add(field);
        continue;
      }
      if (kind === 'InlineFragment') {
        const nested = objectPairValue(selection, 'selectionSet');
        if (nested) pending.push({ selectionSet: nested, depth: current.depth + 1 });
        continue;
      }
      if (kind !== 'FragmentSpread') continue;
      const name = graphqlNameValue(objectPairValue(selection, 'name'));
      if (!name || seenFragments.has(name)) continue;
      const fragment = fragments.get(name);
      if (!fragment) continue;
      const nested = objectPairValue(fragment, 'selectionSet');
      if (!nested) continue;
      seenFragments.add(name);
      pending.push({ selectionSet: nested, depth: current.depth + 1 });
    }
  }
  return fields;
}

function parsedDocumentProof(
  source: string,
  operationKind: GraphqlOperationKind,
  operationName: string,
  requiredFields: readonly string[],
): boolean {
  let document: DocumentNode;
  try {
    document = parse(source, { noLocation: true, maxTokens: MAX_GRAPHQL_TOKENS });
  } catch {
    return false;
  }
  if (document.definitions.length > MAX_GRAPHQL_DEFINITIONS) return false;
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    if (definition.operation !== operationKind || definition.name?.value !== operationName)
      continue;
    const fields = rootFields(definition.selectionSet, fragments);
    return fields !== null && requiredFields.every((field) => fields.includes(field));
  }
  return false;
}

function staticGraphqlSource(initializer: Parser.SyntaxNode): string | null {
  const value = unwrapExpression(initializer);
  if (value.type === 'string') {
    if (value.text.startsWith('"')) {
      try {
        return JSON.parse(value.text) as string;
      } catch {
        return null;
      }
    }
    return unquote(value.text);
  }
  if (value.type === 'template_string') return unquote(value.text);

  if (value.type === 'call_expression') {
    const template = value.namedChildren.find((child) => child.type === 'template_string');
    return template ? unquote(template.text) : null;
  }

  if (value.type !== 'new_expression') return null;
  const constructor = value.childForFieldName('constructor') ?? value.namedChildren[0];
  if (!constructor || !constructor.text.endsWith('TypedDocumentString')) return null;
  const args = value.childForFieldName('arguments');
  const first = args?.namedChildren[0];
  return first ? staticGraphqlSource(first) : null;
}

export function hasGeneratedDocumentProof(
  initializer: Parser.SyntaxNode,
  operationKind: GraphqlOperationKind,
  operationName: string,
  requiredFields: readonly string[],
): boolean {
  if (!withinGeneratedAstBudget(initializer)) return false;
  const staticSource = staticGraphqlSource(initializer);
  if (staticSource !== null) {
    return parsedDocumentProof(staticSource, operationKind, operationName, requiredFields);
  }
  const document = unwrapExpression(initializer);
  if (literalValue(objectPairValue(document, 'kind')) !== 'Document') return false;
  const definitions = objectPairValue(document, 'definitions');
  const array = definitions ? unwrapExpression(definitions) : null;
  if (!array || array.type !== 'array') return false;

  const fragments = new Map<string, Parser.SyntaxNode>();
  for (const item of array.namedChildren) {
    const definition = unwrapExpression(item);
    if (literalValue(objectPairValue(definition, 'kind')) !== 'FragmentDefinition') continue;
    const name = graphqlNameValue(objectPairValue(definition, 'name'));
    if (name) fragments.set(name, definition);
  }

  for (const item of array.namedChildren) {
    const definition = unwrapExpression(item);
    if (literalValue(objectPairValue(definition, 'kind')) !== 'OperationDefinition') continue;
    if (literalValue(objectPairValue(definition, 'operation')) !== operationKind) continue;
    if (graphqlNameValue(objectPairValue(definition, 'name')) !== operationName) continue;
    const fields = generatedRootFields(objectPairValue(definition, 'selectionSet'), fragments);
    if (fields && requiredFields.every((field) => fields.has(field))) return true;
  }
  return false;
}

function importedDecoratorBindings(root: Parser.SyntaxNode): DecoratorBindings {
  const operations = new Map<string, GraphqlOperationKind>();
  const resolvers = new Set<string>();
  for (const child of root.namedChildren) {
    if (child.type !== 'import_statement') continue;
    const source = child.childForFieldName('source');
    if (!source || unquote(source.text) !== NEST_GRAPHQL_PACKAGE) continue;

    const namedImports = child.namedChildren
      .find((node) => node.type === 'import_clause')
      ?.namedChildren.find((node) => node.type === 'named_imports');
    if (!namedImports) continue;

    for (const specifier of namedImports.namedChildren) {
      if (specifier.type !== 'import_specifier') continue;
      const imported = specifier.childForFieldName('name')?.text;
      const local = specifier.childForFieldName('alias')?.text ?? imported;
      if (!imported || !local) continue;
      const kind = imported.toLowerCase();
      if (kind === 'query' || kind === 'mutation' || kind === 'subscription') {
        operations.set(local, kind);
      } else if (imported === 'Resolver') {
        resolvers.add(local);
      }
    }
  }
  return { operations, resolvers };
}

function decoratorKind(
  decorator: Parser.SyntaxNode,
  bindings: Map<string, GraphqlOperationKind>,
): { kind: GraphqlOperationKind; argumentsNode?: Parser.SyntaxNode } | null {
  const expression = decorator.namedChildren[0];
  if (!expression) return null;
  if (expression.type === 'identifier') {
    const kind = bindings.get(expression.text);
    return kind ? { kind } : null;
  }
  if (expression.type !== 'call_expression') return null;
  const callee = expression.childForFieldName('function');
  if (!callee || callee.type !== 'identifier') return null;
  const kind = bindings.get(callee.text);
  if (!kind) return null;
  return { kind, argumentsNode: expression.childForFieldName('arguments') ?? undefined };
}

function decoratorFieldName(argumentsNode: Parser.SyntaxNode | undefined): DecoratorFieldName {
  if (!argumentsNode || argumentsNode.namedChildren.length === 0) return { kind: 'absent' };
  const args = argumentsNode.namedChildren;
  if (args[0] && ['string', 'template_string'].includes(args[0].type)) {
    const direct = unquote(args[0].text);
    return direct === null ? { kind: 'dynamic' } : { kind: 'literal', value: direct };
  }

  let sawOptions = false;

  for (const arg of args) {
    if (arg.type !== 'object') continue;
    sawOptions = true;
    for (const pair of arg.namedChildren) {
      if (pair.type === 'spread_element' || pair.type.startsWith('shorthand_property_identifier')) {
        return { kind: 'dynamic' };
      }
      if (pair.type !== 'pair') continue;
      const key = pair.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '');
      if (key !== 'name') continue;
      const value = pair.childForFieldName('value');
      if (!value || !['string', 'template_string'].includes(value.type)) {
        return { kind: 'dynamic' };
      }
      const literal = unquote(value.text);
      return literal === null ? { kind: 'dynamic' } : { kind: 'literal', value: literal };
    }
  }
  if (sawOptions || args.length === 1) return { kind: 'absent' };
  return { kind: 'dynamic' };
}

function topLevelResolverClassBodies(
  root: Parser.SyntaxNode,
  resolverBindings: ReadonlySet<string>,
): Parser.SyntaxNode[] | null {
  if (!withinGeneratedAstBudget(root)) return null;
  const bodies: Parser.SyntaxNode[] = [];
  for (const statement of root.namedChildren) {
    const classNode =
      statement.type === 'class_declaration'
        ? statement
        : statement.type === 'export_statement'
          ? statement.namedChildren.find((child) => child.type === 'class_declaration')
          : undefined;
    if (!classNode) continue;
    const decorators = [
      ...new Set([
        ...statement.namedChildren.filter((child) => child.type === 'decorator'),
        ...classNode.namedChildren.filter((child) => child.type === 'decorator'),
      ]),
    ];
    const isResolver = decorators.some((decorator) => {
      const expression = decorator.namedChildren[0];
      if (!expression) return false;
      const callee =
        expression.type === 'call_expression'
          ? expression.childForFieldName('function')
          : expression;
      return callee?.type === 'identifier' && resolverBindings.has(callee.text);
    });
    if (!isResolver) continue;
    const body = classNode.childForFieldName('body');
    if (body) bodies.push(body);
  }
  return bodies;
}

function rootFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): string[] | null {
  const fields: string[] = [];
  const seenFragments = new Set<string>();
  const pending: Array<{ selectionSet: SelectionSetNode; depth: number }> = [
    { selectionSet, depth: 0 },
  ];
  let selectionsVisited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > MAX_GRAPHQL_TRAVERSAL_DEPTH) return null;
    for (const selection of current.selectionSet.selections) {
      selectionsVisited++;
      if (selectionsVisited > MAX_GRAPHQL_SELECTIONS) return null;
      if (selection.kind === Kind.FIELD) {
        fields.push(selection.name.value);
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        pending.push({ selectionSet: selection.selectionSet, depth: current.depth + 1 });
        continue;
      }
      const name = selection.name.value;
      if (seenFragments.has(name)) continue;
      const fragment = fragments.get(name);
      if (!fragment) continue;
      seenFragments.add(name);
      pending.push({ selectionSet: fragment.selectionSet, depth: current.depth + 1 });
    }
  }
  return fields;
}

function generatedCandidates(operation: OperationDefinitionNode): string[] {
  const name = operation.name?.value;
  return name ? [`${name}Document`] : [];
}

async function generatedDocumentMatches(
  repoPath: string,
  symbol: ResolvedSymbol,
  operationKind: GraphqlOperationKind,
  operationName: string,
  requiredFields: readonly string[],
  cache: GeneratedIndexCache,
): Promise<boolean> {
  const normalizedPath = symbol.filePath.replace(/\\/g, '/');
  let pendingIndex = cache.get(normalizedPath);
  if (!pendingIndex) {
    pendingIndex = buildGeneratedSymbolIndex(repoPath, normalizedPath);
    cache.set(normalizedPath, pendingIndex);
  }
  const index = await pendingIndex;
  const values = index?.get(symbol.name) ?? [];
  return values.some((value) =>
    hasGeneratedDocumentProof(value, operationKind, operationName, requiredFields),
  );
}

async function buildGeneratedSymbolIndex(
  repoPath: string,
  filePath: string,
): Promise<GeneratedSymbolIndex | null> {
  const source = await readSafeBounded(repoPath, filePath, getMaxFileSizeBytes());
  if (source === null) return null;
  const parser = new Parser();
  parser.setLanguage(
    filePath.toLowerCase().endsWith('.tsx') ? TypeScript.tsx : TypeScript.typescript,
  );
  let tree: Parser.Tree;
  try {
    tree = parseSourceSafe(parser, source, undefined, undefined, filePath);
  } catch (error) {
    if (error instanceof ParseTimeoutError) return null;
    throw error;
  }

  return indexGeneratedDeclarators(tree.rootNode);
}

export function indexGeneratedDeclarators(root: Parser.SyntaxNode): GeneratedSymbolIndex {
  const index: GeneratedSymbolIndex = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name && value) {
        const values = index.get(name) ?? [];
        values.push(value);
        index.set(name, values);
      }
    }
    for (let child = node.namedChildren.length - 1; child >= 0; child--) {
      pending.push(node.namedChildren[child]);
    }
  }
  return index;
}

function dedupe(contracts: ExtractedContract[]): ExtractedContract[] {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = `${contract.contractId}|${contract.role}|${contract.symbolUid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class GraphqlExtractor implements ContractExtractor {
  type = 'graphql' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    if (!dbExecutor) return [];
    const ignore = await createIgnoreFilter(repoPath);
    const [providerFiles, documentFiles] = await Promise.all([
      glob(PROVIDER_GLOB, { cwd: repoPath, ignore, nodir: true }),
      glob(DOCUMENT_GLOB, { cwd: repoPath, ignore, nodir: true }),
    ]);
    const contracts = [
      ...(await this.extractProviders(dbExecutor, repoPath, providerFiles)),
      ...(await this.extractConsumers(dbExecutor, repoPath, documentFiles)),
    ];
    return dedupe(contracts);
  }

  private async extractProviders(
    dbExecutor: CypherExecutor,
    repoPath: string,
    files: string[],
  ): Promise<ExtractedContract[]> {
    const parser = new Parser();
    const contracts: ExtractedContract[] = [];
    const maxFileSizeBytes = getMaxFileSizeBytes();
    for (const rel of files) {
      if (/\.(?:spec|test)\.[cm]?tsx?$/i.test(rel)) continue;
      const source = await readSafeBounded(repoPath, rel, maxFileSizeBytes);
      if (source === null || !source.includes(NEST_GRAPHQL_PACKAGE)) continue;
      parser.setLanguage(
        rel.toLowerCase().endsWith('.tsx') ? TypeScript.tsx : TypeScript.typescript,
      );
      let tree: Parser.Tree;
      try {
        tree = parseSourceSafe(parser, source, undefined, undefined, rel);
      } catch (error) {
        if (error instanceof ParseTimeoutError) continue;
        throw error;
      }
      const bindings = importedDecoratorBindings(tree.rootNode);
      if (bindings.operations.size === 0 || bindings.resolvers.size === 0) continue;
      const bodies = topLevelResolverClassBodies(tree.rootNode, bindings.resolvers);
      if (bodies === null) continue;
      for (const body of bodies) {
        let decorators: Parser.SyntaxNode[] = [];
        for (const member of body.namedChildren) {
          if (member.type === 'comment') continue;
          if (member.type === 'decorator') {
            decorators.push(member);
            continue;
          }
          if (member.type !== 'method_definition' && member.type !== 'public_field_definition') {
            decorators = [];
            continue;
          }
          const memberDecorators = [
            ...new Set([
              ...decorators,
              ...member.namedChildren.filter((child) => child.type === 'decorator'),
            ]),
          ];
          const methodName = member.childForFieldName('name')?.text;
          if (!methodName) {
            decorators = [];
            continue;
          }
          for (const decorator of memberDecorators) {
            const operation = decoratorKind(decorator, bindings.operations);
            if (!operation) continue;
            const parsedField = decoratorFieldName(operation.argumentsNode);
            if (parsedField.kind === 'dynamic') continue;
            const field = parsedField.kind === 'literal' ? parsedField.value : methodName;
            if (!GRAPHQL_NAME.test(field)) continue;
            const filePath = rel.replace(/\\/g, '/');
            const symbol = uniqueRealSymbol(
              await dbExecutor(RESOLVE_METHOD_QUERY, {
                name: methodName,
                filePath,
                startLine:
                  member.type === 'public_field_definition'
                    ? (member.childForFieldName('value')?.startPosition.row ??
                        member.startPosition.row) + 1
                    : member.startPosition.row + 1,
              }),
            );
            if (!symbol) continue;
            contracts.push({
              contractId: `graphql::${operation.kind}::${field}`,
              type: 'graphql',
              role: 'provider',
              symbolUid: symbol.uid,
              symbolRef: { filePath: symbol.filePath, name: symbol.name },
              symbolName: symbol.name,
              confidence: 1,
              meta: {
                operationKind: operation.kind,
                fieldName: field,
                resolverPath: filePath,
                extractionStrategy: 'nestjs_decorator',
              },
            });
          }
          decorators = [];
        }
      }
    }
    return contracts;
  }

  private async extractConsumers(
    dbExecutor: CypherExecutor,
    repoPath: string,
    files: string[],
  ): Promise<ExtractedContract[]> {
    const contracts: ExtractedContract[] = [];
    const generatedIndexCache: GeneratedIndexCache = new Map();
    const maxFileSizeBytes = getMaxFileSizeBytes();
    for (const rel of files) {
      const source = await readSafeBounded(repoPath, rel, maxFileSizeBytes);
      if (source === null) continue;
      let document: DocumentNode;
      try {
        document = parse(source, { noLocation: true, maxTokens: MAX_GRAPHQL_TOKENS });
      } catch (error) {
        logger.debug({ file: rel, error }, 'skipping invalid GraphQL document');
        continue;
      }
      if (document.definitions.length > MAX_GRAPHQL_DEFINITIONS) continue;
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const definition of document.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          fragments.set(definition.name.value, definition);
        }
      }
      const operations = document.definitions.filter(
        (definition): definition is OperationDefinitionNode =>
          definition.kind === Kind.OPERATION_DEFINITION && definition.name !== undefined,
      );
      if (operations.length > MAX_GRAPHQL_OPERATIONS) continue;
      for (const definition of operations) {
        const operationName = definition.name?.value;
        if (!operationName) continue;
        const documentPath = rel.replace(/\\/g, '/');
        const operationFields = rootFields(definition.selectionSet, fragments);
        if (operationFields === null) continue;
        const uniqueFields = [...new Set(operationFields)];
        let symbol: ResolvedSymbol | null = null;
        for (const candidate of generatedCandidates(definition)) {
          const resolved = uniqueRealSymbol(
            await dbExecutor(RESOLVE_GENERATED_SYMBOL_QUERY, { name: candidate }),
          );
          if (
            resolved &&
            (await generatedDocumentMatches(
              repoPath,
              resolved,
              definition.operation,
              operationName,
              uniqueFields,
              generatedIndexCache,
            ))
          ) {
            symbol = resolved;
            break;
          }
        }
        if (!symbol) continue;
        for (const field of uniqueFields) {
          contracts.push({
            contractId: `graphql::${definition.operation}::${field}`,
            type: 'graphql',
            role: 'consumer',
            symbolUid: symbol.uid,
            symbolRef: { filePath: symbol.filePath, name: symbol.name },
            symbolName: symbol.name,
            confidence: 1,
            meta: {
              operationKind: definition.operation,
              operationName: definition.name.value,
              fieldName: field,
              documentPath,
              extractionStrategy: 'graphql_ast',
            },
          });
        }
      }
    }
    return contracts;
  }
}
