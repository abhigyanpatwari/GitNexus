/** Collect URL-bearing calls while the provider's existing AST is available. */
import path from 'node:path';
import type Parser from 'tree-sitter';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';
import { stripLeadingTemplatePrefix } from './route-path.js';

/** A candidate is not an HTTP sink until its name matches a known wrapper. */
export interface FetchWrapperCall extends ExtractedFetchCall {
  /** The callee as written at the call site (`send` for `import { request as send }`). */
  functionName: string;
  /** Module stem declaring a bare callee, when this file declares or imports it relatively. */
  module?: string;
  /** The name the callee is declared under in `module`, when it differs from `functionName`. */
  declaredName?: string;
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
    const declared = calleeDeclarations(tree.rootNode, filePath).get(functionName);
    calls.push({
      filePath,
      functionName,
      fetchURL,
      lineNumber: call.startPosition.row + lineOffset + 1,
      ...(declared?.module ? { module: declared.module } : {}),
      ...(declared && declared.callee !== functionName ? { declaredName: declared.callee } : {}),
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

/** The function node a definition declares. */
function definedFunction(definition: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return FUNCTION_TYPES.includes(definition.type)
    ? definition
    : definition.descendantsOfType(FUNCTION_TYPES)[0];
}

/**
 * The name bound by a function's first parameter, when it is a plain identifier
 * that nothing inside the function redeclares; a shadowed name could be read
 * where the parameter is not, so it is not followed at all.
 */
function firstParameterName(fn: Parser.SyntaxNode | undefined): string | undefined {
  if (!fn) return undefined;
  let param =
    fn.childForFieldName('parameter') ??
    fn.childForFieldName('parameters')?.namedChildren.find((child) => child.type !== 'comment');
  if (param?.type === 'required_parameter' || param?.type === 'optional_parameter') {
    param = param.childForFieldName('pattern');
  }
  if (param?.type === 'assignment_pattern') param = param.childForFieldName('left');
  if (param?.type !== 'identifier') return undefined;
  const name = param.text;
  const redeclared =
    fn
      .descendantsOfType('variable_declarator')
      .some((d) => d.childForFieldName('name')?.text === name) ||
    fn
      .descendantsOfType(FUNCTION_TYPES)
      .some(
        (nested) =>
          nested.id !== fn.id &&
          [nested.childForFieldName('parameter'), nested.childForFieldName('parameters')].some(
            (params) =>
              params?.type === 'identifier'
                ? params.text === name
                : params?.descendantsOfType('identifier').some((id) => id.text === name),
          ),
      );
  return redeclared ? undefined : name;
}

/** The nearest function enclosing `node`. */
function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (FUNCTION_TYPES.includes(parent.type)) return parent;
  }
  return null;
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
  // An alias counts only where its declaring function encloses the call: a
  // nested helper's `const fetchImpl = globalThis.fetch` says nothing about an
  // outer `fetchImpl` parameter.
  // A name redeclared with any other value anywhere in the function (a block
  // that shadows it) is not an alias at all: which declaration a call reads
  // would need lexical scoping this pass does not do.
  const declarators = definition.descendantsOfType('variable_declarator');
  const conflicting = new Set(
    declarators
      .filter((d) => !namesFetch(d.childForFieldName('value')))
      .map((d) => d.childForFieldName('name')?.text),
  );
  const aliases = declarators.filter(
    (d) =>
      namesFetch(d.childForFieldName('value')) &&
      !conflicting.has(d.childForFieldName('name')?.text),
  );
  const declaresParameter = (fn: Parser.SyntaxNode, name: string) =>
    [fn.childForFieldName('parameter'), fn.childForFieldName('parameters')].some((params) =>
      params?.type === 'identifier'
        ? params.text === name
        : params?.descendantsOfType('identifier').some((id) => id.text === name),
    );
  const isAlias = (name: string, call: Parser.SyntaxNode) =>
    aliases.some((d) => {
      const scope = enclosingFunction(d);
      if (d.childForFieldName('name')?.text !== name) return false;
      if (scope && !(scope.startIndex <= call.startIndex && call.endIndex <= scope.endIndex)) {
        return false;
      }
      // A function between the alias and the call whose parameter has the
      // same name shadows the alias there.
      for (
        let fn = enclosingFunction(call);
        fn && fn.id !== scope?.id;
        fn = enclosingFunction(fn)
      ) {
        if (declaresParameter(fn, name)) return false;
      }
      return true;
    });
  const parameter = firstParameterName(definedFunction(definition));
  const carries = (argument: Parser.SyntaxNode | undefined): boolean =>
    !!parameter &&
    !!argument &&
    (argument.type === 'identifier'
      ? argument.text === parameter
      : ['template_string', 'binary_expression'].includes(argument.type) &&
        argument.descendantsOfType('identifier').some((id) => id.text === parameter));
  // A nested helper bound to a local that is never referenced again never
  // runs (`const later = () => resilientFetch(url)`), so its calls prove
  // nothing; a helper that is called or passed on (a retry callback) counts.
  const body = definedFunction(definition);
  const referenced = (name: Parser.SyntaxNode) =>
    definition
      .descendantsOfType('identifier')
      .some((id) => id.text === name.text && id.id !== name.id);
  const unused = definition
    .descendantsOfType([
      'variable_declarator',
      'function_declaration',
      'generator_function_declaration',
    ])
    .filter((d) => {
      const name = d.childForFieldName('name');
      return (
        // Not the definition itself or its own `const load = (url) => …` declarator.
        !!body &&
        d.id !== body.id &&
        body.startIndex <= d.startIndex &&
        d.endIndex <= body.endIndex &&
        (d.type !== 'variable_declarator' ||
          FUNCTION_TYPES.includes(d.childForFieldName('value')?.type ?? '')) &&
        name?.type === 'identifier' &&
        !referenced(name)
      );
    });
  // `window.fetch` through a parameter or local named `window` is that value's
  // method, not the platform fetch.
  const localNames = new Set([
    ...definition
      .descendantsOfType('variable_declarator')
      .map((d) => d.childForFieldName('name')?.text),
    ...definition
      .descendantsOfType(FUNCTION_TYPES)
      .flatMap((fn) =>
        [fn.childForFieldName('parameter'), fn.childForFieldName('parameters')].flatMap((params) =>
          params?.type === 'identifier'
            ? [params.text]
            : (params?.descendantsOfType('identifier').map((id) => id.text) ?? []),
        ),
      ),
  ]);
  const platformFetch = (name: string) =>
    FETCH_CALLEES.has(name) && (name === 'fetch' || !localNames.has(name.split('.')[0]));
  const runs = (call: Parser.SyntaxNode) =>
    !unused.some((d) => d.startIndex <= call.startIndex && call.endIndex <= d.endIndex);
  let seed = false;
  let forwardsUrl = false;
  const forwardsTo = new Map<string, ForwardedCallee>();
  for (const call of definition.descendantsOfType('call_expression').filter(runs)) {
    const name = calleeName(call.childForFieldName('function'));
    if (!name) continue;
    const argument = call
      .childForFieldName('arguments')
      ?.namedChildren.find((child) => child.type !== 'comment');
    if (platformFetch(name) || isAlias(name, call)) {
      seed = true;
      if (carries(argument)) forwardsUrl = true;
    }
    if (parameter && argument?.type === 'identifier' && argument.text === parameter) {
      forwardsTo.set(name, declared.get(name) ?? { callee: name, module: null });
    }
  }
  return { seed, forwardsUrl, forwardsTo: [...forwardsTo.values()] };
}
