import { SupportedLanguages, type NodeLabel } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import type {
  ProviderSemanticGraph,
  ProviderSemanticNode,
  ProviderSemanticRelationship,
  ProviderSemanticSymbol,
} from '../../language-provider.js';
import { generateId } from '../../../../lib/utils.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const DECLARATIONS = new Set([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defguard',
  'defguardp',
  'defdelegate',
]);
const MODULES = new Set(['defmodule', 'defprotocol']);

function keyword(node: SyntaxNode): string | undefined {
  const target = node.childForFieldName?.('target');
  return target?.type === 'identifier' ? target.text : undefined;
}

function remoteReceiver(node: SyntaxNode): string | undefined {
  const target = node.childForFieldName?.('target');
  return target?.type === 'dot' && target.childForFieldName?.('left')?.type === 'alias'
    ? target.childForFieldName('left')!.text
    : undefined;
}

function remoteMethod(node: SyntaxNode): string | undefined {
  const target = node.childForFieldName?.('target');
  return target?.type === 'dot' && target.childForFieldName?.('right')?.type === 'identifier'
    ? target.childForFieldName('right')!.text
    : undefined;
}

function argumentsNode(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'arguments') return child;
  }
  return null;
}

function declaration(
  node: SyntaxNode,
): { name: string; arity: number; required: number } | undefined {
  const args = argumentsNode(node);
  if (!args) return undefined;
  const first = args.namedChildren.find(
    (child) =>
      child?.type === 'call' || child?.type === 'binary_operator' || child?.type === 'identifier',
  );
  const signature = first?.type === 'binary_operator' ? first.childForFieldName?.('left') : first;
  const target =
    signature?.type === 'identifier' ? signature : signature?.childForFieldName?.('target');
  if (target?.type !== 'identifier') return undefined;
  const parameters = argumentsNode(signature);
  if (!parameters) return { name: target.text, arity: 0, required: 0 };
  let required = 0;
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const parameter = parameters.namedChild(i);
    if (parameter?.type !== 'binary_operator' || !parameter.text.includes('\\\\')) required++;
  }
  return { name: target.text, arity: parameters.namedChildCount, required };
}

function declarationName(node: SyntaxNode): string | undefined {
  return (
    declaration(node)?.name ??
    argumentsNode(node)?.namedChildren.find((child) => child?.type === 'identifier')?.text
  );
}

function enclosingModule(node: SyntaxNode): { name: string; identity: number } | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== 'call' || !MODULES.has(keyword(current) ?? '')) continue;
    const alias = argumentsNode(current)?.namedChildren.find((child) => child?.type === 'alias');
    if (alias) return { name: alias.text, identity: current.startIndex };
  }
  return undefined;
}

function callableLabel(kind: string): NodeLabel {
  return kind === 'defmacro' || kind === 'defmacrop' || kind === 'defguard' || kind === 'defguardp'
    ? 'Macro'
    : 'Function';
}

function isQuoted(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'call' && keyword(current) === 'quote') return true;
  }
  return false;
}

function isBehaviourModule(node: SyntaxNode): boolean {
  let found = false;
  const visit = (child: SyntaxNode): void => {
    if (found || (child.type === 'call' && keyword(child) === 'defmodule' && child !== node))
      return;
    if (child.type === 'unary_operator' && child.text.startsWith('@callback')) found = true;
    for (let i = 0; !found && i < child.namedChildCount; i++) {
      const next = child.namedChild(i);
      if (next) visit(next as SyntaxNode);
    }
  };
  visit(node);
  return found;
}

function keywordValue(node: SyntaxNode, name: string): SyntaxNode | undefined {
  const keywords =
    node.type === 'keywords'
      ? node
      : node.type === 'list'
        ? node.namedChildren.find((child) => child?.type === 'keywords')
        : argumentsNode(node)?.namedChildren.find((child) => child?.type === 'keywords');
  return keywords?.namedChildren
    .find((child) => child?.type === 'pair' && child.namedChild(0)?.text.trim() === `${name}:`)
    ?.namedChild(1) as SyntaxNode | undefined;
}

function literalAtom(node: SyntaxNode | undefined): string | undefined {
  return node?.type === 'atom' ? node.text.slice(1) : undefined;
}

function literalString(node: SyntaxNode | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(node.text);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function literalBoolean(node: SyntaxNode | undefined): boolean | undefined {
  return node?.type === 'boolean' ? node.text === 'true' : undefined;
}

function targetName(node: SyntaxNode | undefined): string | undefined {
  if (node?.type === 'alias') return node.text;
  // `{:local, Server}` is a statically named local registration; all other
  // server tuples may be process routing and deliberately stay unresolved.
  if (node?.type === 'tuple' && literalAtom(node.namedChild(0) as SyntaxNode) === 'local') {
    return targetName(node.namedChild(1) as SyntaxNode);
  }
  return undefined;
}

function listValues(node: SyntaxNode | undefined): readonly SyntaxNode[] | undefined {
  return node?.type === 'list' ? (node.namedChildren as readonly SyntaxNode[]) : undefined;
}

function definitionBody(node: SyntaxNode): SyntaxNode | undefined {
  const inline = keywordValue(node, 'do');
  if (inline) return inline;
  const block = node.namedChildren.find((child) => child?.type === 'do_block');
  return block?.namedChildren.length === 1 ? (block.namedChild(0) as SyntaxNode) : undefined;
}

/** Provider-owned canonical declarations; scope captures deliberately remain per clause. */
export function extractElixirSemanticGraph(
  tree: Parser.Tree,
  filePath: string,
): ProviderSemanticGraph {
  const nodes: ProviderSemanticNode[] = [];
  const relationships: ProviderSemanticRelationship[] = [];
  const symbols: ProviderSemanticSymbol[] = [];
  const seen = new Set<string>();
  const fileId = generateId('File', filePath);
  const moduleIds = new Map<string, string>();
  const evidenceTargets: { evidenceId: string; kind: string; target: string }[] = [];
  const definitions = new Map<string, SyntaxNode>();
  const isMixFile = filePath === 'mix.exs' || filePath.endsWith('/mix.exs');

  const collectDefinitions = (node: SyntaxNode): void => {
    if (node.type === 'call' && DECLARATIONS.has(keyword(node) ?? '')) {
      const name = declarationName(node);
      const body = definitionBody(node);
      if (name && body) definitions.set(name, body);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) collectDefinitions(child as SyntaxNode);
    }
  };
  if (isMixFile) collectDefinitions(tree.rootNode as SyntaxNode);

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'call') {
      const kind = keyword(node);
      if (isQuoted(node)) return;
      if (kind && MODULES.has(kind)) {
        const alias = argumentsNode(node)?.namedChildren.find((child) => child?.type === 'alias');
        if (alias)
          add(
            kind === 'defprotocol' || isBehaviourModule(node) ? 'Interface' : 'Class',
            alias.text,
            alias.text,
            node.startIndex,
            node.startPosition.row,
            node.endPosition.row,
            0,
            0,
            undefined,
          );
      } else if (kind && DECLARATIONS.has(kind)) {
        const declarationInfo = declaration(node);
        const owner = enclosingModule(node);
        if (declarationInfo && owner) {
          const label = callableLabel(kind);
          const qualifiedName = `${owner.name}.${declarationInfo.name}`;
          // Same clauses share this key; distinct module declarations/arities/kinds do not.
          const identity = `${owner.identity}:${qualifiedName}/${declarationInfo.arity}:${label}`;
          add(
            label,
            declarationInfo.name,
            qualifiedName,
            identity,
            node.startPosition.row,
            node.endPosition.row,
            declarationInfo.arity,
            declarationInfo.required,
            owner.name,
            kind === 'defp' || kind === 'defmacrop' || kind === 'defguardp' ? 'private' : 'public',
          );
        }
        const metadataName = declarationName(node);
        if (isMixFile && metadataName === 'project') {
          const metadata = definitionBody(node);
          if (metadata?.type === 'list') {
            const app = literalAtom(keywordValue(metadata, 'app'));
            if (app) addEvidence('mix-app', app, node, { app });
            const appsPath = literalString(keywordValue(metadata, 'apps_path'));
            if (appsPath) addEvidence('mix-umbrella', appsPath, node, { appsPath });
            const deps = keywordValue(metadata, 'deps');
            emitMixDependencies(
              deps?.type === 'call' && keyword(deps) === 'deps' ? definitions.get('deps') : deps,
              node,
            );
          }
        } else if (isMixFile && metadataName === 'application') {
          const metadata = definitionBody(node);
          if (metadata?.type === 'list') {
            for (const key of ['applications', 'extra_applications']) {
              for (const value of listValues(keywordValue(metadata, key)) ?? []) {
                const app = literalAtom(value);
                if (app) addEvidence('mix-application', app, node, { app, applicationKind: key });
              }
            }
          }
        }
      } else if (remoteMethod(node) === 'start_link' && remoteReceiver(node) === 'Supervisor') {
        for (const child of listValues(argumentsNode(node)?.namedChild(0) as SyntaxNode) ?? []) {
          const target =
            child.type === 'tuple'
              ? targetName(child.namedChild(0) as SyntaxNode)
              : targetName(child);
          if (target) addEvidence('supervisor-child', target, node, { target });
        }
      } else if (
        ['start_link', 'call', 'cast'].includes(remoteMethod(node) ?? '') &&
        remoteReceiver(node) === 'GenServer'
      ) {
        const target = targetName(argumentsNode(node)?.namedChild(0) as SyntaxNode);
        const method = remoteMethod(node)!;
        if (target) addEvidence(`genserver-${method}`, target, node, { target });
      } else if (kind === 'callback') {
        const declarationInfo = declaration(node);
        const owner = enclosingModule(node);
        if (declarationInfo && owner) {
          add(
            'Function',
            declarationInfo.name,
            `${owner.name}.${declarationInfo.name}`,
            `${owner.identity}:${owner.name}.${declarationInfo.name}/${declarationInfo.arity}:callback`,
            node.startPosition.row,
            node.endPosition.row,
            declarationInfo.arity,
            declarationInfo.required,
            owner.name,
          );
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };

  const add = (
    label: NodeLabel,
    name: string,
    qualifiedName: string,
    identity: string | number,
    startLine: number,
    endLine: number,
    parameterCount: number,
    requiredParameterCount: number,
    owner?: string,
    visibility = 'public',
  ): void => {
    const key = `${label}:${identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    const id = generateId(label, `${filePath}:${key}`);
    nodes.push({
      id,
      label,
      properties: {
        name,
        qualifiedName,
        filePath,
        startLine,
        endLine,
        language: SupportedLanguages.Elixir,
        isExported: visibility === 'public',
        ...(label === 'Function' || label === 'Macro'
          ? { parameterCount, requiredParameterCount, visibility }
          : {}),
      },
    });
    relationships.push({
      id: generateId('DEFINES', `${fileId}->${id}`),
      sourceId: fileId,
      targetId: id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'elixir semantic declaration',
    });
    symbols.push({
      filePath,
      name,
      nodeId: id,
      type: label,
      qualifiedName,
      ...(label === 'Function' || label === 'Macro'
        ? { parameterCount, requiredParameterCount, visibility }
        : {}),
      ...(owner ? { ownerId: generateId('Class', `${filePath}:Class:${owner}`) } : {}),
    });
    if (label === 'Class' || label === 'Interface') moduleIds.set(qualifiedName, id);
  };

  const addEvidence = (
    kind: string,
    name: string,
    node: SyntaxNode,
    properties: Record<string, unknown>,
  ): void => {
    const qualifiedName = `elixir:${kind}:${filePath}:${node.startIndex}:${name}`;
    const id = generateId('CodeElement', qualifiedName);
    nodes.push({
      id,
      label: 'CodeElement',
      properties: {
        name,
        qualifiedName,
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        language: SupportedLanguages.Elixir,
        isExported: true,
        elixirKind: kind,
        ...properties,
      },
    });
    relationships.push({
      id: generateId('DEFINES', `${fileId}->${id}`),
      sourceId: fileId,
      targetId: id,
      type: 'DEFINES',
      confidence: 1,
      reason: `elixir static ${kind} evidence`,
    });
    if (typeof properties.target === 'string')
      evidenceTargets.push({ evidenceId: id, kind, target: properties.target });
  };

  const emitMixDependencies = (value: SyntaxNode | undefined, node: SyntaxNode): void => {
    for (const entry of listValues(value) ?? []) {
      if (entry.type !== 'tuple') continue;
      const app = literalAtom(entry.namedChild(0) as SyntaxNode);
      const options = entry.namedChildren.find((child) => child?.type === 'keywords');
      const path = literalString(options && keywordValue(options as SyntaxNode, 'path'));
      const inUmbrella = literalBoolean(
        options && keywordValue(options as SyntaxNode, 'in_umbrella'),
      );
      if (app && (path !== undefined || inUmbrella === true)) {
        addEvidence('mix-dependency', app, node, {
          app,
          ...(path !== undefined ? { path } : {}),
          ...(inUmbrella === true ? { inUmbrella: true } : {}),
        });
      }
    }
  };

  visit(tree.rootNode as SyntaxNode);
  for (const evidence of evidenceTargets) {
    const target = moduleIds.get(evidence.target);
    if (target)
      relationships.push({
        id: generateId('DECLARES', `${evidence.evidenceId}->${target}`),
        sourceId: evidence.evidenceId,
        targetId: target,
        type: 'DECLARES',
        confidence: 1,
        reason: `elixir static ${evidence.kind} target`,
      });
  }
  return { nodes, relationships, symbols };
}
