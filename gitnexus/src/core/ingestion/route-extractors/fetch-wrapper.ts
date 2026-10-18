/** Collect URL-bearing calls while the provider's existing AST is available. */
import path from 'node:path';
import type Parser from 'tree-sitter';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';
import { stripLeadingTemplatePrefix } from './route-path.js';

/** A candidate is not an HTTP sink until its name matches a known wrapper. */
export interface FetchWrapperCall extends ExtractedFetchCall {
  functionName: string;
}

function calleeName(node: Parser.SyntaxNode | null): string | undefined {
  // The TS grammar puts `await f<T>(...)` inside the call's function field.
  while (node?.type === 'await_expression') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  // Unlike constant names, configured wrapper names may start with this/super.
  const parts: string[] = [];
  while (node?.type === 'member_expression') {
    const property = node.childForFieldName('property');
    if (property?.type !== 'property_identifier') return undefined;
    parts.push(property.text);
    node = node.childForFieldName('object');
  }
  if (!node || !['identifier', 'this', 'super'].includes(node.type)) return undefined;
  parts.push(node.text);
  return parts.reverse().join('.');
}

export function extractFetchWrapperCalls(
  tree: Parser.Tree,
  filePath: string,
  lineOffset: number,
): FetchWrapperCall[] {
  const calls: FetchWrapperCall[] = [];
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    if (call.hasError) continue;
    const argument = call
      .childForFieldName('arguments')
      ?.namedChildren.find((child) => child.type !== 'comment');
    if (argument?.type !== 'string' && argument?.type !== 'template_string') continue;
    // Keep template substitutions for the existing route URL normalizer.
    // Requiring the whole argument to be a literal excludes concatenation.
    const fetchURL = argument.text.slice(1, -1);
    // `${backendUrl}/api/x` keeps its base for normalizeFetchURL to strip (#3488).
    if (!stripLeadingTemplatePrefix(fetchURL)?.startsWith('/')) continue;
    const functionName = calleeName(call.childForFieldName('function'));
    if (!functionName) continue;
    calls.push({
      filePath,
      functionName,
      fetchURL,
      lineNumber: call.startPosition.row + lineOffset + 1,
    });
  }
  return calls;
}

const FUNCTION_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'arrow_function',
];
const FETCH_CALLEES = new Set(['fetch', 'globalThis.fetch', 'window.fetch', 'self.fetch']);

/** The name bound by a function's first parameter, when it is a plain identifier. */
function firstParameterName(definition: Parser.SyntaxNode): string | undefined {
  const fn = FUNCTION_TYPES.includes(definition.type)
    ? definition
    : definition.descendantsOfType(FUNCTION_TYPES)[0];
  if (!fn) return undefined;
  let param =
    fn.childForFieldName('parameter') ??
    fn.childForFieldName('parameters')?.namedChildren.find((child) => child.type !== 'comment');
  if (param?.type === 'required_parameter' || param?.type === 'optional_parameter') {
    param = param.childForFieldName('pattern');
  }
  if (param?.type === 'assignment_pattern') param = param.childForFieldName('left');
  return param?.type === 'identifier' ? param.text : undefined;
}

/** A value naming fetch, through `??`/`||`, `?:`, parentheses, `as` or `await`. */
function namesFetch(node: Parser.SyntaxNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === 'binary_expression') {
    return (
      namesFetch(node.childForFieldName('left')) || namesFetch(node.childForFieldName('right'))
    );
  }
  if (node.type === 'ternary_expression') {
    return (
      namesFetch(node.childForFieldName('consequence')) ||
      namesFetch(node.childForFieldName('alternative'))
    );
  }
  if (
    [
      'parenthesized_expression',
      'as_expression',
      'satisfies_expression',
      'non_null_expression',
    ].includes(node.type)
  ) {
    return namesFetch(node.namedChildren.find((child) => child.type !== 'comment'));
  }
  const name = calleeName(node);
  return !!name && FETCH_CALLEES.has(name);
}

/** A repo-relative module path without its extension or `/index`. */
export function moduleStem(filePath: string): string {
  return filePath.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

/** A callee a function forwards its first parameter to, and the module declaring it when known. */
export interface ForwardedCallee {
  callee: string;
  /** Module stem of a same-file declaration or a relative named import; null when unknown. */
  module: string | null;
}

/**
 * Bare names a file declares at top level or imports by name from a relative
 * module, mapped to the declaring module and the name it is declared under.
 */
const declaredCallees = new WeakMap<Parser.Tree, Map<string, ForwardedCallee>>();
function calleeDeclarations(
  root: Parser.SyntaxNode,
  filePath: string,
): Map<string, ForwardedCallee> {
  const cached = declaredCallees.get(root.tree);
  if (cached) return cached;
  const own = moduleStem(filePath);
  const declared = new Map<string, ForwardedCallee>();
  for (const statement of root.namedChildren) {
    const node =
      statement.type === 'export_statement'
        ? (statement.childForFieldName('declaration') ?? statement)
        : statement;
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) declared.set(name, { callee: name, module: own });
    } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const declarator of node.namedChildren) {
        const name = declarator.childForFieldName('name');
        if (name?.type === 'identifier')
          declared.set(name.text, { callee: name.text, module: own });
      }
    } else if (node.type === 'import_statement') {
      const spec = node.childForFieldName('source')?.text.slice(1, -1) ?? '';
      if (!spec.startsWith('.')) continue;
      const module = moduleStem(
        path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec)),
      );
      for (const named of node.descendantsOfType('import_specifier')) {
        const name = named.childForFieldName('name')?.text;
        const local = named.childForFieldName('alias')?.text ?? name;
        if (name && local) declared.set(local, { callee: name, module });
      }
    }
  }
  declaredCallees.set(root.tree, declared);
  return declared;
}

/**
 * What a function definition proves about wrapping fetch (#1852, #3488). It is
 * a `seed` when it calls fetch itself, through `globalThis`/`window`/`self`, or
 * through a local alias (`const f = opts.fetchImpl ?? globalThis.fetch`).
 * `forwardsUrl` holds when its first parameter reaches that call's URL
 * argument, alone or inside a template or concatenation. `forwardsTo` lists the
 * callees that receive its own first parameter as their first argument, with
 * the module declaring each when the file shows it, so a function forwarding
 * its URL to a URL-carrying wrapper is one too.
 */
export function fetchWrapperFacts(
  definition: Parser.SyntaxNode,
  filePath: string,
): {
  seed: boolean;
  forwardsUrl: boolean;
  forwardsTo: ForwardedCallee[];
} {
  const declared = calleeDeclarations(definition.tree.rootNode, filePath);
  const aliases = new Set(
    definition
      .descendantsOfType('variable_declarator')
      .filter((d) => namesFetch(d.childForFieldName('value')))
      .map((d) => d.childForFieldName('name')?.text),
  );
  const parameter = firstParameterName(definition);
  const carries = (argument: Parser.SyntaxNode | undefined): boolean =>
    !!parameter &&
    !!argument &&
    (argument.type === 'identifier'
      ? argument.text === parameter
      : ['template_string', 'binary_expression'].includes(argument.type) &&
        argument.descendantsOfType('identifier').some((id) => id.text === parameter));
  let seed = false;
  let forwardsUrl = false;
  const forwardsTo = new Map<string, ForwardedCallee>();
  for (const call of definition.descendantsOfType('call_expression')) {
    const name = calleeName(call.childForFieldName('function'));
    if (!name) continue;
    const argument = call
      .childForFieldName('arguments')
      ?.namedChildren.find((child) => child.type !== 'comment');
    if (FETCH_CALLEES.has(name) || aliases.has(name)) {
      seed = true;
      if (carries(argument)) forwardsUrl = true;
    }
    if (parameter && argument?.type === 'identifier' && argument.text === parameter) {
      forwardsTo.set(name, declared.get(name) ?? { callee: name, module: null });
    }
  }
  return { seed, forwardsUrl, forwardsTo: [...forwardsTo.values()] };
}
