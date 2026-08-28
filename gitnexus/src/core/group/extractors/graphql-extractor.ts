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
import { logger } from '../../logger.js';
import { ParseTimeoutError, parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';

const PROVIDER_GLOB = '**/*.{ts,tsx,mts,cts}';
const DOCUMENT_GLOB = '**/*.{graphql,gql}';
const NEST_GRAPHQL_PACKAGE = '@nestjs/graphql';
const MAX_GRAPHQL_SOURCE_BYTES = 1_000_000;
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

export const RESOLVE_METHOD_QUERY = `
MATCH (n:Method)
WHERE n.name = $name AND n.filePath = $filePath AND n.id <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
LIMIT 2`;

export const RESOLVE_GENERATED_SYMBOL_QUERY = `
MATCH (n)
WHERE labels(n) IN ['Const','Variable','Function','Method','CodeElement']
  AND n.name = $name AND n.filePath <> '' AND n.id <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
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

interface LiteralTokenNode {
  readonly text: string;
  readonly namedChildren: readonly LiteralTokenNode[];
}

export function hasRequiredLiteralTokens(
  root: LiteralTokenNode,
  requiredNames: readonly string[],
  maxNodes = MAX_PROVIDER_AST_NODES,
  initialDepth = 0,
  maxDepth = MAX_PROVIDER_AST_DEPTH,
): boolean {
  const tokens = new Set<string>();
  const pending: Array<{ node: LiteralTokenNode; depth: number }> = [
    { node: root, depth: initialDepth },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited++;
    if (visited > maxNodes || current.depth > maxDepth) return false;
    if (current.node.namedChildren.length === 0) {
      const literal = unquote(current.node.text);
      tokens.add(literal ?? current.node.text);
      continue;
    }
    for (let index = current.node.namedChildren.length - 1; index >= 0; index--) {
      const child = current.node.namedChildren[index];
      if (child) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return requiredNames.every((name) => tokens.has(name));
}

function importedDecoratorBindings(root: Parser.SyntaxNode): Map<string, GraphqlOperationKind> {
  const bindings = new Map<string, GraphqlOperationKind>();
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
        bindings.set(local, kind);
      }
    }
  }
  return bindings;
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

function decoratorFieldName(argumentsNode: Parser.SyntaxNode | undefined): string | null {
  if (!argumentsNode) return null;
  const args = argumentsNode.namedChildren;
  const direct =
    args[0] && ['string', 'template_string'].includes(args[0].type) ? unquote(args[0].text) : null;
  if (direct) return direct;

  for (const arg of args) {
    if (arg.type !== 'object') continue;
    for (const pair of arg.namedChildren) {
      if (pair.type !== 'pair') continue;
      const key = pair.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '');
      if (key !== 'name') continue;
      const value = pair.childForFieldName('value');
      if (!value || !['string', 'template_string'].includes(value.type)) return null;
      return unquote(value.text);
    }
  }
  return null;
}

function collectClassBodies(root: Parser.SyntaxNode): Parser.SyntaxNode[] | null {
  const bodies: Parser.SyntaxNode[] = [];
  const pending: Array<{ node: Parser.SyntaxNode; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited++;
    if (visited > MAX_PROVIDER_AST_NODES || current.depth > MAX_PROVIDER_AST_DEPTH) return null;
    if (current.node.type === 'class_body') bodies.push(current.node);
    for (let index = current.node.namedChildren.length - 1; index >= 0; index--) {
      pending.push({ node: current.node.namedChildren[index], depth: current.depth + 1 });
    }
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

function generatedDocumentMatches(
  repoPath: string,
  symbol: ResolvedSymbol,
  requiredNames: readonly string[],
): boolean {
  const source = readSafe(repoPath, symbol.filePath, MAX_GRAPHQL_SOURCE_BYTES);
  if (!source) return false;
  const parser = new Parser();
  parser.setLanguage(
    symbol.filePath.toLowerCase().endsWith('.tsx') ? TypeScript.tsx : TypeScript.typescript,
  );
  let tree: Parser.Tree;
  try {
    tree = parseSourceSafe(parser, source, undefined, undefined, symbol.filePath);
  } catch (error) {
    if (error instanceof ParseTimeoutError) return false;
    throw error;
  }

  const pending: Array<{ node: Parser.SyntaxNode; depth: number }> = [
    { node: tree.rootNode, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited++;
    if (visited > MAX_PROVIDER_AST_NODES || current.depth > MAX_PROVIDER_AST_DEPTH) return false;
    if (
      current.node.type === 'variable_declarator' &&
      current.node.childForFieldName('name')?.text === symbol.name
    ) {
      const value = current.node.childForFieldName('value');
      if (!value) return false;
      return hasRequiredLiteralTokens(
        value,
        requiredNames,
        MAX_PROVIDER_AST_NODES - visited,
        current.depth + 1,
      );
    }
    for (let index = current.node.namedChildren.length - 1; index >= 0; index--) {
      pending.push({ node: current.node.namedChildren[index], depth: current.depth + 1 });
    }
  }
  return false;
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
    for (const rel of files) {
      const source = readSafe(repoPath, rel, MAX_GRAPHQL_SOURCE_BYTES);
      if (!source) continue;
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
      if (bindings.size === 0) continue;
      const bodies = collectClassBodies(tree.rootNode);
      if (bodies === null) continue;
      for (const body of bodies) {
        let decorators: Parser.SyntaxNode[] = [];
        for (const member of body.namedChildren) {
          if (member.type === 'decorator') {
            decorators.push(member);
            continue;
          }
          if (member.type !== 'method_definition') {
            decorators = [];
            continue;
          }
          const methodName = member.childForFieldName('name')?.text;
          if (!methodName) {
            decorators = [];
            continue;
          }
          for (const decorator of decorators) {
            const operation = decoratorKind(decorator, bindings);
            if (!operation) continue;
            const field = decoratorFieldName(operation.argumentsNode) ?? methodName;
            if (!GRAPHQL_NAME.test(field)) continue;
            const filePath = rel.replace(/\\/g, '/');
            const symbol = uniqueRealSymbol(
              await dbExecutor(RESOLVE_METHOD_QUERY, { name: methodName, filePath }),
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
    for (const rel of files) {
      const source = readSafe(repoPath, rel, MAX_GRAPHQL_SOURCE_BYTES);
      if (!source) continue;
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
            generatedDocumentMatches(repoPath, resolved, [operationName, ...uniqueFields])
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
