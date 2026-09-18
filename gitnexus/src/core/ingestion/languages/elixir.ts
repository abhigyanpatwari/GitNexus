/**
 * Elixir Language Provider
 *
 * Key Elixir traits:
 *   - importSemantics: 'wildcard-leaf' (import/use bring all public functions into scope)
 *   - mroStrategy: 'none' (functional language — no class inheritance)
 *   - heritageDefaultEdge: 'IMPLEMENTS' (protocol/behaviour relationships)
 *   - Modules defined with defmodule, functions with def/defp
 *   - Module names are atoms: MyApp.User → lib/my_app/user.ex by convention
 */

import { SupportedLanguages, type NodeLabel } from 'gitnexus-shared';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as elixirTypeConfig } from '../type-extractors/elixir.js';
import { elixirExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { elixirImportConfig } from '../import-resolvers/configs/elixir.js';
import { ELIXIR_QUERIES } from '../tree-sitter-queries.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { createElixirCfgVisitor } from '../cfg/visitors/elixir.js';
import { elixirMethodConfig } from '../method-extractors/configs/elixir.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import { elixirClassConfig } from '../class-extractors/configs/elixir.js';
import type { CallExtractor, ExtractedCallSite } from '../call-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { countCallArguments } from '../utils/call-analysis.js';
import Parser from 'tree-sitter';
import type { Capture, CaptureMatch, ParsedImport } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { nodeToCapture } from '../utils/ast-helpers.js';
import { normalizeExtractedRoutePath } from '../route-extractors/route-path.js';
import { extractElixirSemanticGraph } from './elixir/semantic-graph.js';
import {
  clearElixirImportExcepts,
  collectElixirCaptureSideChannel,
  recordElixirFrameworkFacts,
  recordElixirImportExcept,
  recordElixirImportOnly,
  type ElixirFrameworkFact,
} from './elixir/import-filters.js';

const ELIXIR_DEF_KEYWORDS = new Set([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defguard',
  'defguardp',
  'defdelegate',
]);

const ELIXIR_MODULE_KEYWORDS = new Set(['defmodule', 'defprotocol']);

const ELIXIR_NON_CALL_KEYWORDS = new Set([
  ...ELIXIR_DEF_KEYWORDS,
  ...ELIXIR_MODULE_KEYWORDS,
  'defimpl',
  'defstruct',
  'defoverridable',
  'defexception',
  'callback',
  'import',
  'alias',
  'use',
  'require',
  'case',
  'cond',
  'if',
  'unless',
  'for',
  'with',
  'receive',
  'try',
  'quote',
  'fn',
]);

function callKeyword(node: SyntaxNode): string | undefined {
  const target = node.childForFieldName?.('target');
  return target?.type === 'identifier' ? target.text : undefined;
}

function findArguments(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'arguments') return child;
  }
  return null;
}

function firstAliasArgument(node: SyntaxNode): string | undefined {
  const args = findArguments(node);
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child?.type === 'alias') return child.text;
  }
  return undefined;
}

function extractFunctionNameFromDef(node: SyntaxNode): string | undefined {
  if (!ELIXIR_DEF_KEYWORDS.has(callKeyword(node) ?? '')) return undefined;
  const args = findArguments(node);
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    if (arg.type === 'identifier') return arg.text;
    if (arg.type === 'call') {
      const target = arg.childForFieldName?.('target');
      if (target?.type === 'identifier') return target.text;
    }
    if (arg.type === 'binary_operator') {
      const left = arg.childForFieldName?.('left');
      if (left?.type === 'call') {
        const target = left.childForFieldName?.('target');
        if (target?.type === 'identifier') return target.text;
      }
    }
  }
  return undefined;
}

function isInsideDefinitionHead(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'do_block') return false;
    if (current.type === 'call' && ELIXIR_DEF_KEYWORDS.has(callKeyword(current) ?? '')) {
      const signature = findArguments(current)?.namedChild(0);
      return (
        signature !== null &&
        signature !== undefined &&
        node.startIndex >= signature.startIndex &&
        node.endIndex <= signature.endIndex
      );
    }
    current = current.parent;
  }
  return false;
}

function isModuleAttributeCall(node: SyntaxNode): boolean {
  return node.parent?.type === 'unary_operator' && node.parent.text.startsWith('@');
}

function isInsideModuleAttribute(node: SyntaxNode): boolean {
  for (
    let current: SyntaxNode | null | undefined = node;
    current;
    current = current.parent as SyntaxNode | null
  )
    if (isModuleAttributeCall(current)) return true;
  return false;
}

function isBehaviourModule(node: SyntaxNode): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'unary_operator' && child.text.startsWith('@callback')) return true;
    if (child.type !== 'call' || callKeyword(child) !== 'defmodule') {
      if (isBehaviourModule(child as SyntaxNode)) return true;
    }
  }
  return false;
}

function elixirString(node: SyntaxNode | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(node.text);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Extract only literal Phoenix/Ecto declarations; this is capture-time data, never macro output. */
function extractElixirFrameworkFacts(tree: Parser.Tree): readonly ElixirFrameworkFact[] {
  const facts: ElixirFrameworkFact[] = [];
  const http = new Map([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
    ['head', 'HEAD'],
    ['options', 'OPTIONS'],
  ]);
  const resourceActions = [
    ['GET', '', 'index'],
    ['GET', '/:id', 'show'],
    ['GET', '/new', 'new'],
    ['GET', '/:id/edit', 'edit'],
    ['POST', '', 'create'],
    ['PATCH', '/:id', 'update'],
    ['PUT', '/:id', 'update'],
    ['DELETE', '/:id', 'delete'],
  ] as const;
  const args = (node: SyntaxNode) =>
    Array.from(
      { length: findArguments(node)?.namedChildCount ?? 0 },
      (_, i) => findArguments(node)!.namedChild(i) as SyntaxNode,
    );
  const alias = (node: SyntaxNode | undefined) => (node?.type === 'alias' ? node.text : undefined);
  const methodAt = (node: SyntaxNode): string | undefined => {
    const target = node.childForFieldName?.('target');
    return target?.type === 'dot' && target.childForFieldName?.('right')?.type === 'identifier'
      ? target.childForFieldName('right')!.text
      : undefined;
  };
  const moduleAt = (node: SyntaxNode): string | undefined => {
    for (let n = node.parent; n; n = n.parent)
      if (n.type === 'call' && callKeyword(n) === 'defmodule') return alias(args(n)[0]);
    return undefined;
  };
  const visit = (
    node: SyntaxNode,
    prefix = '',
    pipelines: readonly string[] = [],
    scopeModule?: string,
  ): void => {
    if (node.type === 'call' && !isQuotedElixirNode(node)) {
      const kind = callKeyword(node);
      const values = args(node);
      const body = node.namedChildren.find((child) => child?.type === 'do_block') as
        | SyntaxNode
        | undefined;
      if (kind === 'scope' && body) {
        const path = elixirString(values[0]);
        const mod = alias(values[1]) ?? scopeModule;
        if (path !== undefined) {
          const scopedPipelines = [
            ...pipelines,
            ...body.namedChildren.flatMap((child) => {
              if (child?.type !== 'call' || callKeyword(child as SyntaxNode) !== 'pipe_through')
                return [];
              const pipeline = args(child as SyntaxNode)[0];
              return pipeline?.type === 'atom' ? [pipeline.text.slice(1)] : [];
            }),
          ];
          for (const child of body.namedChildren)
            if (
              child &&
              (child.type !== 'call' || callKeyword(child as SyntaxNode) !== 'pipe_through')
            )
              visit(child as SyntaxNode, `${prefix}${path}`, scopedPipelines, mod);
        }
        return;
      }
      if ((kind === 'pipeline' || kind === 'live_session') && body) {
        for (const child of body.namedChildren)
          visit(child as SyntaxNode, prefix, pipelines, scopeModule);
        return;
      }
      if (kind === 'pipe_through') {
        const name = values[0]?.type === 'atom' ? values[0].text.slice(1) : undefined;
        if (name) pipelines = [...pipelines, name];
      }
      const method = kind ? http.get(kind) : undefined;
      if (method) {
        const path = elixirString(values[0]);
        const controller = alias(values[1]);
        const action = values[2]?.type === 'atom' ? values[2].text.slice(1) : undefined;
        if (path !== undefined && controller && action)
          facts.push({
            kind: 'route',
            path: normalizeExtractedRoutePath(path, prefix),
            method,
            handler:
              controller.includes('.') || !scopeModule
                ? controller
                : `${scopeModule}.${controller}`,
            action,
            line: node.startPosition.row + 1,
            pipelines,
          });
      }
      if (kind === 'resources') {
        const path = elixirString(values[0]);
        const controller = alias(values[1]);
        const keywords = values.find((value) => value.type === 'keywords');
        const filter = (name: string) =>
          (
            keywords?.namedChildren
              .find(
                (value) => value.type === 'pair' && value.namedChild(0)?.text.trim() === `${name}:`,
              )
              ?.namedChild(1) as SyntaxNode | undefined
          )?.namedChildren
            .map((value) => (value.type === 'atom' ? value.text.slice(1) : ''))
            .filter(Boolean);
        const only = filter('only');
        const except = filter('except');
        if (path !== undefined && controller)
          for (const [verb, suffix, action] of resourceActions)
            if ((!only || only.includes(action)) && (!except || !except.includes(action)))
              facts.push({
                kind: 'route',
                path: normalizeExtractedRoutePath(`${path}${suffix}`, prefix),
                method: verb,
                handler:
                  controller.includes('.') || !scopeModule
                    ? controller
                    : `${scopeModule}.${controller}`,
                action,
                line: node.startPosition.row + 1,
                pipelines,
              });
      }
      if (kind === 'live') {
        const path = elixirString(values[0]);
        const live = alias(values[1]);
        if (path !== undefined && live)
          facts.push({
            kind: 'route',
            path: normalizeExtractedRoutePath(path, prefix),
            method: 'GET',
            handler: live.includes('.') || !scopeModule ? live : `${scopeModule}.${live}`,
            line: node.startPosition.row + 1,
            pipelines,
          });
      }
      const model = moduleAt(node);
      if (model && (kind === 'schema' || kind === 'embedded_schema')) {
        const table = kind === 'schema' ? elixirString(values[0]) : undefined;
        facts.push({ kind: 'schema', model, table, line: node.startPosition.row + 1 });
      }
      if (
        model &&
        [
          'field',
          'belongs_to',
          'has_one',
          'has_many',
          'many_to_many',
          'embeds_one',
          'embeds_many',
        ].includes(kind ?? '')
      ) {
        const name = values[0]?.type === 'atom' ? values[0].text.slice(1) : undefined;
        const target = alias(values[1]);
        if (name)
          facts.push({
            kind: 'property',
            model,
            name,
            propertyKind: kind!,
            target,
            line: node.startPosition.row + 1,
          });
      }
      if (kind === 'from') {
        const keywords = values.find((value) => value.type === 'keywords');
        const inPair = keywords?.namedChildren.find(
          (value) => value.type === 'pair' && value.namedChild(0)?.text.trim() === 'in:',
        );
        const model = alias(inPair?.namedChild(1) as SyntaxNode);
        if (model)
          facts.push({ kind: 'query', model, method: 'from', line: node.startPosition.row + 1 });
      }
      if (
        remoteReceiver(node) === 'Repo' &&
        ['all', 'get', 'get_by', 'one', 'insert', 'update', 'delete', 'preload'].includes(
          methodAt(node) ?? '',
        )
      ) {
        const model =
          alias(values[0]) ?? alias(node.parent?.childForFieldName?.('left') as SyntaxNode);
        if (model)
          facts.push({
            kind: 'query',
            model,
            method: methodAt(node)!,
            line: node.startPosition.row + 1,
          });
      }
    }
    for (const child of node.namedChildren)
      visit(child as SyntaxNode, prefix, pipelines, scopeModule);
  };
  visit(tree.rootNode as SyntaxNode);
  return facts;
}

function remoteReceiver(callNode: SyntaxNode): string | undefined {
  const target = callNode.childForFieldName?.('target');
  if (target?.type !== 'dot') return undefined;
  const left = target.childForFieldName?.('left');
  return left?.type === 'alias' ? left.text : undefined;
}

function pipelineArity(callNode: SyntaxNode): number {
  const parent = callNode.parent;
  return parent?.type === 'binary_operator' &&
    parent.childForFieldName?.('right') === callNode &&
    parent.text.includes('|>')
    ? countCallArguments(callNode) + 1
    : countCallArguments(callNode);
}

const elixirCallExtractor: CallExtractor = {
  language: SupportedLanguages.Elixir,

  extract(callNode, callNameNode): ExtractedCallSite | null {
    if (!callNameNode) return null;
    if (isInsideModuleAttribute(callNode) || isInsideDefinitionHead(callNode)) return null;

    const calledName = callNameNode.text;
    if (ELIXIR_NON_CALL_KEYWORDS.has(calledName)) return null;

    const receiverName = remoteReceiver(callNode);
    return {
      calledName,
      callForm: receiverName ? 'member' : 'free',
      ...(receiverName ? { receiverName } : {}),
      argCount: pipelineArity(callNode),
    };
  },
};

/** Scope captures deliberately mirror Elixir declarations, never evaluated macro output. */
function emitElixirScopeCaptures(
  source: string,
  _file: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  clearElixirImportExcepts(_file);
  const grammar = getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<
    Parser['setLanguage']
  >[0];
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree =
    (cachedTree as ReturnType<Parser['parse']> | undefined) ?? parseSourceSafe(parser, source);
  recordElixirFrameworkFacts(_file, extractElixirFrameworkFacts(tree));
  const query = new Parser.Query(
    grammar,
    `
    (source) @scope.module
    (call target: (identifier) @_ (#eq? @_ "defmodule")) @scope.class
    (call target: (identifier) @_ (#match? @_ "^def(macrop?|guardp?|p)?$")) @scope.function
    (call target: (identifier) @_ (#eq? @_ "defdelegate")) @scope.function
    (call target: (identifier) @_ (#eq? @_ "defmodule") (arguments (alias) @declaration.name)) @declaration.class
    (call target: (identifier) @_ (#eq? @_ "defprotocol") (arguments (alias) @declaration.name)) @declaration.interface
    (call target: (dot left: (alias) @reference.receiver right: (identifier) @reference.name)) @reference.call.member
    (call target: (identifier) @reference.name) @reference.call.free
  `,
  );
  const captures = query.matches(tree.rootNode).flatMap((match) => {
    const referenceName = match.captures.find((capture) => capture.name === 'reference.name')
      ?.node as SyntaxNode | undefined;
    if (
      referenceName &&
      (ELIXIR_NON_CALL_KEYWORDS.has(referenceName.text) ||
        isInsideDefinitionHead(referenceName) ||
        isQuotedElixirNode(referenceName) ||
        isElixirCaptureNode(referenceName) ||
        isInsideModuleAttribute(referenceName))
    )
      return [];
    const grouped: Record<string, Capture> = {};
    for (const capture of match.captures) {
      const tag = `@${capture.name}`;
      grouped[tag] = nodeToCapture(tag, capture.node);
    }
    const moduleDeclaration = match.captures.find((capture) => capture.name === 'declaration.class')
      ?.node as SyntaxNode | undefined;
    if (moduleDeclaration && isBehaviourModule(moduleDeclaration)) {
      delete grouped['@declaration.class'];
      grouped['@declaration.interface'] = nodeToCapture(
        '@declaration.interface',
        moduleDeclaration,
      );
    }
    const call = match.captures.find(
      (capture) =>
        capture.name === 'reference.call.free' || capture.name === 'reference.call.member',
    )?.node as SyntaxNode | undefined;
    if (call) {
      const anchor =
        grouped['@reference.name'] ??
        grouped['@reference.call.free'] ??
        grouped['@reference.call.member'];
      if (anchor)
        grouped['@reference.arity'] = {
          ...anchor,
          name: '@reference.arity',
          text: String(pipelineArity(call)),
        };
    }
    return [grouped];
  });
  const synthetic: CaptureMatch[] = [];
  const add = (name: string, node: SyntaxNode, extra: Record<string, SyntaxNode | string> = {}) => {
    const match: Record<string, Capture> = { [name]: nodeToCapture(name, node) };
    for (const [tag, value] of Object.entries(extra)) {
      match[tag] =
        typeof value === 'string'
          ? { ...nodeToCapture(tag, node), text: value, name: tag }
          : nodeToCapture(tag, value);
    }
    synthetic.push(match);
  };
  const moduleNameAt = (node: SyntaxNode): string | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'call' && ELIXIR_MODULE_KEYWORDS.has(callKeyword(current) ?? ''))
        return firstAliasArgument(current);
    }
    return undefined;
  };
  const keywordValue = (node: SyntaxNode, name: string): SyntaxNode | undefined => {
    const args = findArguments(node);
    const keywords = args?.namedChildren.find((child) => child?.type === 'keywords');
    const pair = keywords?.namedChildren.find(
      (child) =>
        child?.type === 'pair' && child.namedChild(0)?.text.trim().replace(/:$/, '') === name,
    );
    return pair?.namedChild(1) ?? undefined;
  };
  const enclosingModule = (node: SyntaxNode): SyntaxNode | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'call' && callKeyword(current) === 'defmodule') return current;
    }
    return undefined;
  };
  const resolveAliasReceiver = (node: SyntaxNode, receiver: SyntaxNode): string | undefined => {
    const [local, ...suffix] = receiver.text.split('.');
    const owner = enclosingModule(node);
    if (!local || suffix.length === 0 || !owner) return undefined;
    let resolved: string | undefined;
    const contains = (ancestor: SyntaxNode, descendant: SyntaxNode): boolean => {
      for (
        let current: SyntaxNode | null | undefined = descendant;
        current;
        current = current.parent
      )
        if (current === ancestor) return true;
      return false;
    };
    const visibleAt = (candidate: SyntaxNode): boolean => {
      for (let current = candidate.parent; current; current = current.parent) {
        if (!contains(current as SyntaxNode, node)) return false;
        if (current === owner) return true;
      }
      return false;
    };
    const visitAliases = (candidate: SyntaxNode): void => {
      if (
        candidate.type === 'call' &&
        callKeyword(candidate) === 'alias' &&
        enclosingModule(candidate) === owner &&
        candidate.startIndex < node.startIndex &&
        visibleAt(candidate)
      ) {
        const target = findArguments(candidate)?.namedChild(0);
        const as = keywordValue(candidate, 'as');
        if (
          target?.type === 'alias' &&
          (as?.text.replace(/^:/, '') ?? target.text.split('.').at(-1)) === local
        )
          resolved = target.text;
      }
      for (const child of candidate.namedChildren) visitAliases(child as SyntaxNode);
    };
    visitAliases(tree.rootNode as SyntaxNode);
    return resolved ? `${resolved}.${suffix.join('.')}` : undefined;
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'call' && !isQuotedElixirNode(node)) {
      const kind = callKeyword(node);
      const args = findArguments(node);
      const signature = args?.namedChildren.find(
        (child) => child?.type === 'call' || child?.type === 'identifier',
      );
      if (kind && ELIXIR_DEF_KEYWORDS.has(kind) && signature) {
        const name =
          signature.type === 'call' ? signature.childForFieldName?.('target') : signature;
        if (name?.type === 'identifier') {
          const parameters = signature.type === 'call' ? findArguments(signature) : null;
          const count = parameters?.namedChildCount ?? 0;
          const required =
            parameters === null
              ? 0
              : Array.from({ length: parameters.namedChildCount }, (_, i) =>
                  parameters.namedChild(i),
                ).filter((p) => p?.type !== 'binary_operator' || !p.text.includes('\\\\')).length;
          const owner = moduleNameAt(node);
          const declarationKind =
            kind === 'defmacro' ||
            kind === 'defmacrop' ||
            kind === 'defguard' ||
            kind === 'defguardp'
              ? 'macro'
              : 'function';
          add(`@declaration.${declarationKind}`, node, {
            '@declaration.name': name,
            '@declaration.qualified_name': owner ? `${owner}.${name.text}` : name.text,
            '@declaration.parameter-count': String(count),
            '@declaration.required-parameter-count': String(required),
            '@declaration.is-exported':
              kind === 'defp' || kind === 'defmacrop' || kind === 'defguardp' ? 'false' : 'true',
          });
          if (kind === 'defdelegate' && signature.type === 'call') {
            const target = keywordValue(node, 'to');
            const delegated = keywordValue(node, 'as');
            if (target?.type === 'alias')
              add('@reference.call.member', node, {
                '@reference.receiver': target,
                '@reference.name': delegated?.text.replace(/^:/, '') ?? name,
                '@reference.arity': String(count),
              });
          }
        }
      } else if (kind === 'alias' && args) {
        const target = args.namedChild(0);
        const as = keywordValue(node, 'as');
        const owner = moduleNameAt(node);
        const emitAlias = (local: SyntaxNode | string, raw: string) =>
          add('@type-binding.alias', target, {
            '@type-binding.name': local,
            '@type-binding.type': raw,
          });
        if (target?.type === 'alias') emitAlias(as ?? target.text.split('.').at(-1)!, target.text);
        else if (
          target?.type === 'dot' &&
          target.childForFieldName?.('left')?.type === 'alias' &&
          target.childForFieldName?.('right')?.type === 'tuple'
        ) {
          const prefix = target.childForFieldName('left')!.text;
          for (const child of target.childForFieldName('right')!.namedChildren)
            if (child.type === 'alias') emitAlias(child, `${prefix}.${child.text}`);
        } else if (
          target?.type === 'dot' &&
          target.childForFieldName?.('left')?.text === '__MODULE__' &&
          target.childForFieldName?.('right')?.type === 'alias' &&
          owner
        ) {
          const local = as ?? target.childForFieldName('right')!;
          emitAlias(local, `${owner}.${target.childForFieldName('right')!.text}`);
        }
      } else if (kind === 'import' && args) {
        const target = args.namedChild(0);
        const only = keywordValue(node, 'only');
        const except = keywordValue(node, 'except');
        if (target?.type === 'alias' && only) {
          const allowed = only.namedChildren
            .flatMap((entry) => (entry.type === 'keywords' ? entry.namedChildren : [entry]))
            .flatMap((pair) => {
              const name = pair.namedChild(0)?.text.trim().replace(/:$/, '');
              const arity = Number(pair.namedChild(1)?.text);
              return name !== undefined && Number.isInteger(arity) && arity >= 0
                ? [{ name, arity }]
                : [];
            });
          recordElixirImportOnly(_file, {
            target: target.text,
            allowed,
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
          });
        } else if (target?.type === 'alias') {
          add('@import.statement', node, { '@import.source': target, '@import.wildcard': target });
          if (except?.type === 'list') {
            const excluded = except.namedChildren
              .flatMap((entry) => (entry.type === 'keywords' ? entry.namedChildren : [entry]))
              .flatMap((pair) => {
                const name = pair.namedChild(0)?.text.trim().replace(/:$/, '');
                const arity = Number(pair.namedChild(1)?.text);
                return name !== undefined && Number.isInteger(arity) && arity >= 0
                  ? [{ name, arity }]
                  : [];
              });
            recordElixirImportExcept(_file, {
              target: target.text,
              excluded,
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
            });
          }
        }
      } else if (kind === 'callback' && args) {
        // A behaviour callback is a declaration, not a call.  Keep it in the
        // normal scope model so the existing METHOD_IMPLEMENTS pass can pair
        // it with a same-name/same-arity module function.
        const first = args.namedChildren.find(
          (child) => child?.type === 'call' || child?.type === 'binary_operator',
        );
        const signature =
          first?.type === 'binary_operator' ? first.childForFieldName?.('left') : first;
        const name = signature?.childForFieldName?.('target');
        if (name?.type === 'identifier') {
          const parameters = findArguments(signature);
          const count = parameters?.namedChildCount ?? 0;
          const owner = moduleNameAt(node);
          if (owner)
            add('@declaration.function', node, {
              '@declaration.name': name,
              '@declaration.qualified_name': `${owner}.${name.text}`,
              '@declaration.parameter-count': String(count),
              '@declaration.required-parameter-count': String(count),
              '@declaration.is-exported': 'false',
            });
        }
      } else if (kind === 'defimpl' && args) {
        // `defimpl Protocol, for: Type` has no enclosing class scope for the
        // generic heritage pass. Preserve both names for the provider hook.
        const protocol = args.namedChildren.find((child) => child?.type === 'alias');
        const implementation = keywordValue(node, 'for');
        if (protocol?.type === 'alias' && implementation?.type === 'alias')
          add('@reference.inherits', node, {
            '@reference.name': protocol,
            '@reference.receiver': implementation,
          });
      }
    } else if (node.type === 'unary_operator' && node.text.startsWith('@behaviour')) {
      const operand = node.childForFieldName?.('operand') ?? node.namedChild(0);
      const behaviour = operand?.type === 'call' ? firstAliasArgument(operand) : undefined;
      if (behaviour) add('@reference.inherits', node, { '@reference.name': behaviour });
    } else if (
      node.type === 'unary_operator' &&
      node.text.startsWith('&') &&
      !isQuotedElixirNode(node)
    ) {
      const binary = node.namedChild(0);
      const target = binary?.childForFieldName?.('left');
      const arity = binary?.childForFieldName?.('right')?.text;
      if (target?.type === 'identifier' && arity !== undefined)
        add('@reference.call.free', node, { '@reference.name': target, '@reference.arity': arity });
      else if (target?.type === 'call' && arity !== undefined) {
        const dot = target.childForFieldName?.('target');
        const receiver = dot?.childForFieldName?.('left');
        const name = dot?.childForFieldName?.('right');
        if (receiver?.type === 'alias' && name?.type === 'identifier') {
          const resolved = resolveAliasReceiver(node, receiver);
          add('@reference.call.member', node, {
            '@reference.receiver': resolved ? `@elixir-alias:${resolved}` : receiver,
            '@reference.name': name,
            '@reference.arity': arity,
          });
        }
      }
    }
    for (const child of node.namedChildren) visit(child as SyntaxNode);
  };
  visit(tree.rootNode as SyntaxNode);
  return [...captures, ...synthetic];
}

function isQuotedElixirNode(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'call' && callKeyword(current) === 'quote') return true;
  }
  return false;
}

function isElixirCaptureNode(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'unary_operator' && current.text.startsWith('&')) return true;
    if (current.type === 'call' && ELIXIR_DEF_KEYWORDS.has(callKeyword(current) ?? ''))
      return false;
  }
  return false;
}

function interpretElixirImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined) return null;
  const name = captures['@import.name']?.text;
  if (captures['@import.wildcard'] !== undefined) return { kind: 'wildcard', targetRaw: source };
  return name === undefined
    ? {
        kind: 'namespace',
        localName: source.split('.').at(-1)!,
        importedName: source,
        targetRaw: source,
      }
    : {
        kind: 'named',
        localName: name,
        importedName: name,
        targetRaw: source,
        importedSymbolKind: 'function',
      };
}

function interpretElixirTypeBinding(captures: CaptureMatch) {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  return name === undefined || type === undefined
    ? null
    : { boundName: name, rawTypeName: type, source: 'assignment-inferred' as const };
}

function skipElixirStructuralDefinition(
  captures: Record<string, SyntaxNode>,
  label: NodeLabel,
): boolean {
  if (label !== 'Class' && label !== 'Interface' && label !== 'Function' && label !== 'Macro')
    return false;
  for (let node = captures.name; node; node = node.parent) {
    if (
      node.type === 'call' &&
      (ELIXIR_MODULE_KEYWORDS.has(callKeyword(node) ?? '') ||
        ELIXIR_DEF_KEYWORDS.has(callKeyword(node) ?? ''))
    )
      return true;
  }
  return false;
}

const elixirIsClassContainerNode = (node: SyntaxNode): boolean =>
  node.type === 'call' && ELIXIR_MODULE_KEYWORDS.has(callKeyword(node) ?? '');

const elixirEnclosingFunctionFinder = (
  node: SyntaxNode,
): { funcName: string; label: NodeLabel; definitionNode: SyntaxNode } | null => {
  if (node.type !== 'call') return null;
  const funcName = extractFunctionNameFromDef(node);
  return funcName ? { funcName, label: 'Function', definitionNode: node } : null;
};

const elixirImportPathPreprocessor = (cleaned: string, importNode: SyntaxNode): string | null => {
  const keyword = callKeyword(importNode);
  return keyword === 'import' || keyword === 'use' || keyword === 'require' || keyword === 'alias'
    ? cleaned
    : null;
};

const BUILT_INS: ReadonlySet<string> = new Set([
  // Kernel built-ins
  'send',
  'spawn',
  'spawn_link',
  'spawn_monitor',
  'exit',
  'throw',
  'raise',
  'reraise',
  'apply',
  'is_atom',
  'is_binary',
  'is_bitstring',
  'is_boolean',
  'is_float',
  'is_function',
  'is_integer',
  'is_list',
  'is_map',
  'is_nil',
  'is_number',
  'is_pid',
  'is_port',
  'is_reference',
  'is_struct',
  'is_tuple',
  'length',
  'hd',
  'tl',
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'rem',
  'div',
  'max',
  'min',
  'elem',
  'put_elem',
  'tuple_size',
  'map_size',
  'byte_size',
  'bit_size',
  'binary_part',
  'get_in',
  'put_in',
  'update_in',
  'pop_in',
  'get_and_update_in',
  'struct',
  'struct!',
  // IO
  'IO.puts',
  'IO.inspect',
  'IO.gets',
  'IO.write',
  'IO.read',
  // Common pipeline functions
  'then',
  'tap',
  'dbg',
]);

export const elixirProvider = defineLanguage({
  id: SupportedLanguages.Elixir,
  extensions: ['.ex', '.exs'],

  entryPointPatterns: [
    /^mount$/,
    /^handle_event$/,
    /^handle_info$/,
    /^handle_call$/,
    /^handle_cast$/,
    /^handle_continue$/,
    /^perform$/,
    /^process$/,
    /^call$/,
    /^init$/,
    /^start_link$/,
    /^action$/,
  ],

  astFrameworkPatterns: [
    {
      framework: 'phoenix-liveview',
      entryPointMultiplier: 3.0,
      reason: 'liveview-handler',
      patterns: ['Phoenix.LiveView', 'use Phoenix.LiveView', 'mount', 'handle_event'],
    },
    {
      framework: 'phoenix-controller',
      entryPointMultiplier: 2.5,
      reason: 'phoenix-action',
      patterns: ['use Phoenix.Controller', 'conn', 'params', 'Phoenix.Controller'],
    },
    {
      framework: 'phoenix-channel',
      entryPointMultiplier: 2.5,
      reason: 'phoenix-channel',
      patterns: ['use Phoenix.Channel', 'Phoenix.Channel', 'socket', 'join'],
    },
    {
      framework: 'oban-worker',
      entryPointMultiplier: 2.8,
      reason: 'oban-job',
      patterns: ['use Oban.Worker', 'Oban.Worker', 'perform'],
    },
    {
      framework: 'genserver',
      entryPointMultiplier: 2.0,
      reason: 'genserver',
      patterns: ['use GenServer', 'GenServer', 'handle_call', 'handle_cast', 'handle_info'],
    },
    {
      framework: 'plug',
      entryPointMultiplier: 2.0,
      reason: 'plug-middleware',
      patterns: ['use Plug.Router', 'Plug.Conn', 'plug'],
    },
  ] satisfies AstFrameworkPatternConfig[],

  treeSitterQueries: ELIXIR_QUERIES,
  typeConfig: elixirTypeConfig,
  exportChecker: elixirExportChecker,
  importResolver: createImportResolver(elixirImportConfig),
  importPathPreprocessor: elixirImportPathPreprocessor,
  emitScopeCaptures: emitElixirScopeCaptures,
  interpretImport: interpretElixirImport,
  collectCaptureSideChannel: collectElixirCaptureSideChannel,
  interpretTypeBinding: interpretElixirTypeBinding,
  shouldSkipDefinitionCapture: skipElixirStructuralDefinition,
  extractSemanticGraph: extractElixirSemanticGraph,
  resolveContainerTypeOwner: (container) => {
    if (!elixirIsClassContainerNode(container)) return null;
    const name = firstAliasArgument(container);
    if (name === undefined) return null;
    return { name, label: callKeyword(container) === 'defprotocol' ? 'Interface' : 'Class' };
  },
  callExtractor: elixirCallExtractor,
  enclosingFunctionFinder: elixirEnclosingFunctionFinder,
  methodExtractor: createMethodExtractor(elixirMethodConfig),
  classExtractor: createClassExtractor(elixirClassConfig),
  cfgVisitor: createElixirCfgVisitor(),
  builtInNames: BUILT_INS,
});
