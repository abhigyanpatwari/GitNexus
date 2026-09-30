/**
 * gin / echo routes for the indexer (#3402).
 *
 * A gin or echo endpoint is a verb call on a router value —
 * `admin.POST("/rounds/:id", h.Finalize)` — whose full URL is the join of every
 * `Group("/p")` the router value was derived from. Neither the verb call nor
 * any one `Group` call is the route on its own, so this walks each function
 * body, tracks which local names hold a router with a PROVEN prefix, and emits
 * a route only for a verb call on such a name.
 *
 * Proven means: the name is an engine (`*gin.Engine` / `*echo.Echo` parameter,
 * `gin.Default()`, `gin.New()`, `echo.New()`) or a `Group(<string literal>)` of
 * a proven router, and every assignment to it in the function agrees. Anything
 * else — a `*gin.RouterGroup` parameter, a computed group path, a struct field,
 * a name assigned two different routers — is unknown, and a verb call on it is
 * dropped. A route stored under the wrong URL is a false fact that `route_map`
 * and FETCHES matching would repeat; a missing route is a documented gap
 * (groups handed to another function are the known one).
 *
 * The handler travels as `handlerName` (the raw designator) plus a
 * `handlerReceiver` hint read from this file's own syntax. Resolving it to a
 * symbol needs the rest of the package, so that is the Go provider's
 * `resolveRouteHandler` hook, not this file.
 */

import type Parser from 'tree-sitter';
import { goImportPackageName } from '../languages/go/import-package-name.js';
import { normalizeExtractedRoutePath } from './route-path.js';
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedDecoratorRoute, RouteHandlerReceiver } from '../workers/parse-worker.js';

export const GIN_ROUTE_SOURCE = 'gin-route';
export const ECHO_ROUTE_SOURCE = 'echo-route';

const VERBS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

interface Framework {
  readonly source: string;
  /** Import local name of the framework package. */
  readonly alias: string;
  /** Engine type name reached through the alias (`gin.Engine`, `echo.Echo`). */
  readonly engineType: string;
  /** Engine constructors reached through the alias. */
  readonly constructors: ReadonlySet<string>;
  /** gin takes the handler last (middleware first); echo takes it second. */
  readonly handlerArg: 'last' | 'second';
}

const FUNCTION_TYPE_LIST = ['function_declaration', 'method_declaration', 'func_literal'];
const FUNCTION_TYPES: ReadonlySet<string> = new Set(FUNCTION_TYPE_LIST);

function stringLiteral(node: SyntaxNode | null | undefined): string | null {
  if (!node || node.hasError) return null;
  const body = node.text.slice(1, -1);
  // Go discards carriage returns in raw strings, including CRLF source files.
  if (node.type === 'raw_string_literal') return body.replace(/\r/g, '');
  if (node.type !== 'interpreted_string_literal') return null;
  if (!body.includes('\\')) return body;

  const simple: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
  };
  const chunks: Buffer[] = [];
  const tokens =
    /\\(?:[abfnrtv\\"]|[0-7]{3}|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})|[^\\"\n]+/g;
  let consumed = 0;
  for (const match of body.matchAll(tokens)) {
    if (match.index !== consumed) return null;
    const token = match[0];
    consumed += token.length;
    if (!token.startsWith('\\')) {
      chunks.push(Buffer.from(token));
    } else if (simple[token[1]] !== undefined) {
      chunks.push(Buffer.from(simple[token[1]]));
    } else {
      const octal = /[0-7]/.test(token[1]);
      const value = Number.parseInt(token.slice(octal ? 1 : 2), octal ? 8 : 16);
      if (octal || token[1] === 'x') {
        // Octal and hex escapes encode bytes, not Unicode code points.
        if (value > 255) return null;
        chunks.push(Buffer.from([value]));
      } else {
        if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
        chunks.push(Buffer.from(String.fromCodePoint(value)));
      }
    }
  }
  if (consumed !== body.length) return null;
  try {
    // Arbitrary non-UTF-8 Go byte strings cannot be represented losslessly in a URL.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** Local import names, and the framework this file routes with (if exactly one). */
function readImports(root: SyntaxNode): {
  readonly localNames: ReadonlySet<string>;
  readonly framework: Framework | null;
} {
  const localNames = new Set<string>();
  let gin: string | null = null;
  let echo: string | null = null;
  // Imports sit only at file scope; this runs on every Go file, so skip bodies.
  const specs = root.namedChildren
    .filter((node) => node.type === 'import_declaration')
    .flatMap((decl) => decl.descendantsOfType('import_spec'));
  for (const spec of specs) {
    const importPath = stringLiteral(spec.childForFieldName('path'));
    if (importPath === null) continue;
    const explicit = spec.childForFieldName('name')?.text;
    // `_` and `.` imports bind no qualifier this file can call through.
    if (explicit === '_' || explicit === '.') continue;
    const local = explicit ?? goImportPackageName(importPath);
    if (!local) continue;
    localNames.add(local);
    if (importPath === 'github.com/gin-gonic/gin') gin = local;
    if (/^github\.com\/labstack\/echo(\/v\d+)?$/.test(importPath)) echo = local;
  }
  // Both, or neither: no way to tell which argument is the handler.
  if (gin !== null && echo === null) {
    return {
      localNames,
      framework: {
        source: GIN_ROUTE_SOURCE,
        alias: gin,
        engineType: 'Engine',
        constructors: new Set(['Default', 'New']),
        handlerArg: 'last',
      },
    };
  }
  if (echo !== null && gin === null) {
    return {
      localNames,
      framework: {
        source: ECHO_ROUTE_SOURCE,
        alias: echo,
        engineType: 'Echo',
        constructors: new Set(['New']),
        handlerArg: 'second',
      },
    };
  }
  return { localNames, framework: null };
}

/** Named descendants of a function body, not descending into nested functions. */
function bodyNodes(body: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    out.push(node);
    if (FUNCTION_TYPES.has(node.type)) continue;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return out;
}

/** `T`, `*T`, `pkg.T`, `*pkg.T` → type hint; anything else → undefined. */
function typeHint(typeNode: SyntaxNode | null | undefined): RouteHandlerReceiver | undefined {
  if (!typeNode) return undefined;
  if (typeNode.type === 'pointer_type') return typeHint(typeNode.namedChild(0));
  if (typeNode.type === 'type_identifier') return { kind: 'type', name: typeNode.text };
  if (typeNode.type === 'qualified_type') {
    const pkg = typeNode.childForFieldName('package')?.text;
    const name = typeNode.childForFieldName('name')?.text;
    return pkg && name ? { kind: 'type', name, qualifier: pkg } : undefined;
  }
  return undefined;
}

/** Receiver hint for the value a name was assigned. */
function valueHint(value: SyntaxNode): RouteHandlerReceiver | undefined {
  if (value.type === 'unary_expression' && value.childForFieldName('operator')?.text === '&') {
    const operand = value.childForFieldName('operand');
    return operand ? valueHint(operand) : undefined;
  }
  if (value.type === 'composite_literal') return typeHint(value.childForFieldName('type'));
  if (value.type === 'call_expression') {
    const fn = value.childForFieldName('function');
    if (fn?.type === 'identifier') return { kind: 'constructor', name: fn.text };
    if (fn?.type === 'selector_expression') {
      const operand = fn.childForFieldName('operand');
      const field = fn.childForFieldName('field');
      if (operand?.type === 'identifier' && field) {
        return { kind: 'constructor', name: field.text, qualifier: operand.text };
      }
    }
  }
  return undefined;
}

const sameHint = (a: RouteHandlerReceiver, b: RouteHandlerReceiver): boolean =>
  a.kind === b.kind && a.name === b.name && a.qualifier === b.qualifier;

/** One function body's bindings: what each local name was assigned, in any order. */
interface Bindings {
  /** name → every value expression assigned to it (null = unreadable write). */
  readonly values: Map<string, (SyntaxNode | null)[]>;
  /** name → declared type hints from parameters and `var x T`. */
  readonly declared: Map<string, (RouteHandlerReceiver | null)[]>;
  /** parameters declared as the framework engine. */
  readonly engineParams: Set<string>;
}

function collectBindings(fn: SyntaxNode, nodes: readonly SyntaxNode[], fw: Framework): Bindings {
  const values = new Map<string, (SyntaxNode | null)[]>();
  const declared = new Map<string, (RouteHandlerReceiver | null)[]>();
  const engineParams = new Set<string>();
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  const params = [
    fn.childForFieldName('receiver'),
    fn.childForFieldName('parameters'),
    fn.childForFieldName('result'),
  ].filter((n): n is SyntaxNode => n !== null);
  for (const list of params) {
    for (const decl of list.namedChildren) {
      if (decl.type !== 'parameter_declaration' && decl.type !== 'variadic_parameter_declaration')
        continue;
      const type = decl.childForFieldName('type');
      const hint = typeHint(type);
      const isEngine =
        decl.type === 'parameter_declaration' &&
        list.id !== fn.childForFieldName('result')?.id &&
        hint?.kind === 'type' &&
        hint.qualifier === fw.alias &&
        hint.name === fw.engineType;
      for (const name of decl.childrenForFieldName('name')) {
        if (isEngine) engineParams.add(name.text);
        push(declared, name.text, hint ?? null);
      }
    }
  }

  for (const node of nodes) {
    if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
      const left = node.childForFieldName('left')?.namedChildren ?? [];
      const right = node.childForFieldName('right')?.namedChildren ?? [];
      left.forEach((lhs, i) => {
        if (lhs.type !== 'identifier' || lhs.text === '_') return;
        // `a, b := f()` pairs only the first name with the call's value.
        const value = right.length === left.length ? right[i] : i === 0 ? right[0] : undefined;
        push(values, lhs.text, value ?? null);
      });
    } else if (node.type === 'var_spec' || node.type === 'const_spec') {
      const names = node.childrenForFieldName('name');
      const right = node.childForFieldName('value')?.namedChildren ?? [];
      const hint = typeHint(node.childForFieldName('type'));
      names.forEach((name, i) => {
        if (right.length > 0) {
          push(values, name.text, (right.length === names.length ? right[i] : null) ?? null);
        } else {
          push(declared, name.text, hint ?? null);
        }
      });
    } else if (
      node.type === 'range_clause' ||
      node.type === 'receive_statement' ||
      node.type === 'type_switch_statement'
    ) {
      const left = node.childForFieldName(node.type === 'type_switch_statement' ? 'alias' : 'left');
      for (const name of left?.namedChildren ?? []) {
        if (name.type === 'identifier' && name.text !== '_') push(values, name.text, null);
      }
    } else if (node.type === 'type_spec' || node.type === 'type_alias') {
      const name = node.childForFieldName('name');
      if (name) push(declared, name.text, null);
    }
  }
  return { values, declared, engineParams };
}

class RouterPrefixes {
  private readonly memo = new Map<string, string | null>();
  private readonly visiting = new Set<string>();

  constructor(
    private readonly bindings: Bindings,
    private readonly fw: Framework,
    private readonly frameworkAliasShadowed: boolean,
  ) {}

  /** Proven prefix of a router expression, or null when it cannot be proven. */
  of(node: SyntaxNode): string | null {
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChild(0);
      return inner ? this.of(inner) : null;
    }
    if (node.type === 'identifier') return this.ofName(node.text);
    if (node.type !== 'call_expression') return null;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'selector_expression') return null;
    const operand = fn.childForFieldName('operand');
    const field = fn.childForFieldName('field')?.text;
    if (!operand || !field) return null;
    if (operand.type === 'identifier' && operand.text === this.fw.alias) {
      return !this.frameworkAliasShadowed && this.fw.constructors.has(field) ? '' : null;
    }
    if (field !== 'Group') return null;
    const path = stringLiteral(node.childForFieldName('arguments')?.namedChild(0));
    if (path === null) return null;
    const base = this.of(operand);
    return base === null ? null : normalizeExtractedRoutePath(path, base);
  }

  private ofName(name: string): string | null {
    const cached = this.memo.get(name);
    if (cached !== undefined) return cached;
    if (this.visiting.has(name)) return null;
    this.visiting.add(name);
    const result = this.compute(name);
    this.visiting.delete(name);
    this.memo.set(name, result);
    return result;
  }

  private compute(name: string): string | null {
    const candidates: (string | null)[] = [];
    if (this.bindings.engineParams.has(name)) candidates.push('');
    else if (this.bindings.declared.has(name)) candidates.push(null);
    for (const value of this.bindings.values.get(name) ?? []) {
      candidates.push(value === null ? null : this.of(value));
    }
    if (candidates.length === 0) return null;
    const first = candidates[0];
    if (first === null || first === undefined) return null;
    return candidates.every((c) => c === first) ? first : null;
  }
}

/** Receiver hint for the local name a selector handler (`h.Method`) goes through. */
function receiverHint(
  name: string,
  bindings: Bindings,
  importNames: ReadonlySet<string>,
): RouteHandlerReceiver | undefined {
  const declared = bindings.declared.get(name) ?? [];
  const assigned = bindings.values.get(name) ?? [];
  if (declared.length === 0 && assigned.length === 0) {
    return importNames.has(name) ? { kind: 'module', qualifier: name } : undefined;
  }
  const hints = [...declared, ...assigned.map((v) => (v === null ? null : (valueHint(v) ?? null)))];
  const first = hints[0];
  if (!first) return undefined;
  return hints.every((h) => h !== null && sameHint(h, first)) ? first : undefined;
}

interface VerbRegistration {
  readonly call: SyntaxNode;
  readonly verb: string;
  readonly receiver: SyntaxNode;
  readonly args: readonly SyntaxNode[];
  readonly path: string;
}

/** `recv.VERB("<literal>", …handler)` — the shape, before its receiver is proven. */
function verbRegistration(call: SyntaxNode): VerbRegistration | null {
  if (call.type !== 'call_expression') return null;
  const callee = call.childForFieldName('function');
  if (callee?.type !== 'selector_expression') return null;
  const verb = callee.childForFieldName('field')?.text;
  const receiver = callee.childForFieldName('operand');
  if (!verb || !VERBS.has(verb) || !receiver) return null;
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  if (args.length < 2) return null;
  const path = stringLiteral(args[0]);
  return path === null ? null : { call, verb, receiver, args, path };
}

export function extractGoGinEchoRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const root = tree.rootNode;
  const { localNames, framework } = readImports(root);
  if (framework === null) return [];

  const out: ExtractedDecoratorRoute[] = [];
  const bindingsByFunction = new Map<number, Bindings>();
  const bindingsFor = (
    fn: SyntaxNode,
    body: SyntaxNode,
    nodes?: readonly SyntaxNode[],
  ): Bindings => {
    let bindings = bindingsByFunction.get(fn.id);
    if (!bindings) {
      bindings = collectBindings(fn, nodes ?? bodyNodes(body), framework);
      bindingsByFunction.set(fn.id, bindings);
    }
    return bindings;
  };
  for (const fn of root.descendantsOfType(FUNCTION_TYPE_LIST)) {
    const body = fn.childForFieldName('body');
    if (!body) continue;
    const nodes = bodyNodes(body);
    const registrations = nodes.flatMap((node) => {
      const registration = verbRegistration(node);
      return registration === null ? [] : [registration];
    });
    // Most functions in a gin-importing file register nothing; skip their bindings.
    if (registrations.length === 0) continue;
    const bindings = bindingsFor(fn, body, nodes);
    let aliasShadowed =
      bindings.values.has(framework.alias) || bindings.declared.has(framework.alias);
    // A closure can capture a shadowing name even when it declares no locals itself.
    // Like router assignments, shadowing is conservatively checked across each body.
    for (let outer = fn.parent; outer && !aliasShadowed; outer = outer.parent) {
      if (!FUNCTION_TYPES.has(outer.type)) continue;
      const outerBody = outer.childForFieldName('body');
      if (!outerBody) continue;
      const outerBindings = bindingsFor(outer, outerBody);
      aliasShadowed =
        outerBindings.values.has(framework.alias) || outerBindings.declared.has(framework.alias);
    }
    const prefixes = new RouterPrefixes(bindings, framework, aliasShadowed);

    for (const { call, verb, receiver, args, path } of registrations) {
      const prefix = prefixes.of(receiver);
      if (prefix === null) continue;

      const handler = framework.handlerArg === 'last' ? args[args.length - 1] : args[1];
      const route: ExtractedDecoratorRoute = {
        filePath,
        routePath: normalizeExtractedRoutePath(path, prefix),
        httpMethod: verb,
        decoratorName: verb,
        lineNumber: call.startPosition.row + 1 + lineOffset,
        prefix: null,
        source: framework.source,
      };
      if (handler.type === 'identifier') {
        route.handlerName = handler.text;
      } else if (handler.type === 'selector_expression') {
        const operand = handler.childForFieldName('operand');
        const field = handler.childForFieldName('field');
        if (operand?.type === 'identifier' && field) {
          route.handlerName = `${operand.text}.${field.text}`;
          const hint = receiverHint(operand.text, bindings, localNames);
          if (hint) route.handlerReceiver = hint;
        }
      }
      out.push(route);
    }
  }
  return out;
}
