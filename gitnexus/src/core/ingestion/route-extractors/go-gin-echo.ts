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
import { GoRouteBindings, type GoRouteBinding } from '../languages/go/route-bindings.js';
import { isEchoImportPath, isGinImportPath, stringLiteral } from './go-shared.js';
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

/** The framework this file routes with, when exactly one is imported. */
function readImports(root: SyntaxNode): {
  readonly framework: Framework | null;
  /** Every qualifier this file can call through, local name → import path. */
  readonly imports: ReadonlyMap<string, string>;
} {
  const imports = new Map<string, string>();
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
    imports.set(local, importPath);
    if (isGinImportPath(importPath)) gin = local;
    if (isEchoImportPath(importPath)) echo = local;
  }
  // Both, or neither: no way to tell which argument is the handler.
  if (gin !== null && echo === null) {
    return {
      imports,
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
      imports,
      framework: {
        source: ECHO_ROUTE_SOURCE,
        alias: echo,
        engineType: 'Echo',
        constructors: new Set(['New']),
        handlerArg: 'second',
      },
    };
  }
  return { imports, framework: null };
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
function typeHint(
  typeNode: SyntaxNode | null | undefined,
  bindings: GoRouteBindings,
): RouteHandlerReceiver | undefined {
  if (!typeNode) return undefined;
  if (typeNode.type === 'pointer_type') return typeHint(typeNode.namedChild(0), bindings);
  if (typeNode.type === 'type_identifier') {
    return bindings.lookup(typeNode) ? undefined : { kind: 'type', name: typeNode.text };
  }
  if (typeNode.type === 'qualified_type') {
    const packageNode = typeNode.childForFieldName('package');
    if (packageNode && bindings.lookup(packageNode)) return undefined;
    const pkg = packageNode?.text;
    const name = typeNode.childForFieldName('name')?.text;
    return pkg && name ? { kind: 'type', name, qualifier: pkg } : undefined;
  }
  return undefined;
}

/** Receiver hint for the value a name was assigned. */
function valueHint(value: SyntaxNode, bindings: GoRouteBindings): RouteHandlerReceiver | undefined {
  if (value.type === 'unary_expression' && value.childForFieldName('operator')?.text === '&') {
    const operand = value.childForFieldName('operand');
    return operand ? valueHint(operand, bindings) : undefined;
  }
  if (value.type === 'composite_literal')
    return typeHint(value.childForFieldName('type'), bindings);
  if (value.type === 'call_expression') {
    const fn = value.childForFieldName('function');
    if (fn?.type === 'identifier') {
      return bindings.lookup(fn) ? undefined : { kind: 'constructor', name: fn.text };
    }
    if (fn?.type === 'selector_expression') {
      const operand = fn.childForFieldName('operand');
      const field = fn.childForFieldName('field');
      if (operand?.type === 'identifier' && field && !bindings.lookup(operand)) {
        return { kind: 'constructor', name: field.text, qualifier: operand.text };
      }
    }
  }
  return undefined;
}

const sameHint = (a: RouteHandlerReceiver, b: RouteHandlerReceiver): boolean =>
  a.kind === b.kind && a.name === b.name && a.qualifier === b.qualifier;

/** What proves a router root: an engine constructor call or an engine-typed parameter. */
interface RouterRoot {
  /** Import local name the constructors are reached through; null when none apply. */
  readonly alias: string | null;
  readonly constructors: ReadonlySet<string>;
  readonly isRootParameterType: (hint: RouteHandlerReceiver | undefined) => boolean;
}

const frameworkRoot = (fw: Framework): RouterRoot => ({
  alias: fw.alias,
  constructors: fw.constructors,
  isRootParameterType: (hint) =>
    hint?.kind === 'type' && hint.qualifier === fw.alias && hint.name === fw.engineType,
});

class RouterPrefixes {
  private readonly memo = new Map<GoRouteBinding, string | null>();
  private readonly visiting = new Set<GoRouteBinding>();

  constructor(
    private readonly bindings: GoRouteBindings,
    private readonly root: RouterRoot,
    private readonly fn: SyntaxNode,
  ) {}

  /** Proven prefix of a router expression, or null when it cannot be proven. */
  of(node: SyntaxNode): string | null {
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChild(0);
      return inner ? this.of(inner) : null;
    }
    if (node.type === 'identifier') {
      const binding = this.bindings.lookup(node);
      return binding ? this.ofBinding(binding) : null;
    }
    if (node.type !== 'call_expression') return null;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'selector_expression') return null;
    const operand = fn.childForFieldName('operand');
    const field = fn.childForFieldName('field')?.text;
    if (!operand || !field) return null;
    if (
      operand.type === 'identifier' &&
      operand.text === this.root.alias &&
      !this.bindings.lookup(operand)
    ) {
      return this.root.constructors.has(field) ? '' : null;
    }
    if (field !== 'Group') return null;
    const path = stringLiteral(node.childForFieldName('arguments')?.namedChild(0));
    if (path === null) return null;
    const base = this.of(operand);
    return base === null ? null : normalizeExtractedRoutePath(path, base);
  }

  private ofBinding(binding: GoRouteBinding): string | null {
    // Captured routers remain outside this extractor's supported route forms.
    if (binding.ownerFunction.id !== this.fn.id || binding.capturedWrite) return null;
    const cached = this.memo.get(binding);
    if (cached !== undefined) return cached;
    if (this.visiting.has(binding)) return null;
    this.visiting.add(binding);
    const hint = typeHint(binding.type, this.bindings);
    const candidates: (string | null)[] = [];
    if (binding.isInputParameter && this.root.isRootParameterType(hint)) {
      candidates.push('');
    } else if (binding.isInputParameter || binding.values.length === 0) {
      candidates.push(null);
    }
    for (const value of binding.values) candidates.push(value === null ? null : this.of(value));
    const first = candidates[0] ?? null;
    const result = candidates.every((candidate) => candidate === first) ? first : null;
    this.visiting.delete(binding);
    this.memo.set(binding, result);
    return result;
  }
}

/** Hints refer only to visible declarations; unsupported local types decline. */
function receiverHint(
  node: SyntaxNode,
  bindings: GoRouteBindings,
  memo: Map<GoRouteBinding, RouteHandlerReceiver | undefined>,
): RouteHandlerReceiver | undefined {
  const binding = bindings.lookup(node);
  // Workspace resolution checks the actual imported package's declared name.
  if (!binding) return { kind: 'module', qualifier: node.text };
  if (memo.has(binding)) return memo.get(binding);
  if (binding.capturedWrite) return undefined;
  const hints = binding.values.map((value) =>
    value === null ? undefined : valueHint(value, bindings),
  );
  if (binding.isInputParameter || binding.values.length === 0) {
    hints.push(typeHint(binding.type, bindings));
  }
  const first = hints[0];
  const result =
    first && hints.every((hint) => hint !== undefined && sameHint(hint, first)) ? first : undefined;
  memo.set(binding, result);
  return result;
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

/** The handler a registration names, read from one argument of the verb call. */
export interface GoRouteHandlerFact {
  handlerName?: string;
  handlerReceiver?: RouteHandlerReceiver;
  /**
   * `wrap(inner, …)` in the handler slot: the call's callee designator and the
   * inner argument's handler. Only a configured wrapper is unwrapped (by the Go
   * provider's `resolveRouteHandler`); the worker never decides that.
   */
  handlerWrapper?: { callee: string; handlerName: string; handlerReceiver?: RouteHandlerReceiver };
}

/** A handler designator: a bare package function or a `x.Member` selector. */
function handlerDesignator(
  node: SyntaxNode,
  bindings: GoRouteBindings,
  hints: Map<GoRouteBinding, RouteHandlerReceiver | undefined>,
): { handlerName: string; handlerReceiver?: RouteHandlerReceiver } | undefined {
  if (node.type === 'identifier') {
    return bindings.lookup(node) ? undefined : { handlerName: node.text };
  }
  if (node.type !== 'selector_expression') return undefined;
  const operand = node.childForFieldName('operand');
  const field = node.childForFieldName('field');
  if (operand?.type !== 'identifier' || !field) return undefined;
  const hint = receiverHint(operand, bindings, hints);
  return hint
    ? { handlerName: `${operand.text}.${field.text}`, handlerReceiver: hint }
    : { handlerName: `${operand.text}.${field.text}` };
}

/** `pkg.Wrap(h.Method, …)` / `Wrap(Func)` — a package-level callee wrapping a designator. */
function wrappedHandler(
  node: SyntaxNode,
  bindings: GoRouteBindings,
  hints: Map<GoRouteBinding, RouteHandlerReceiver | undefined>,
): GoRouteHandlerFact['handlerWrapper'] {
  if (node.type !== 'call_expression') return undefined;
  const callee = node.childForFieldName('function');
  if (!callee) return undefined;
  if (callee.type === 'identifier') {
    if (bindings.lookup(callee)) return undefined;
  } else if (callee.type === 'selector_expression') {
    const operand = callee.childForFieldName('operand');
    // A local value's method (`m.Wrap`) has no stable designator to configure.
    if (operand?.type !== 'identifier' || bindings.lookup(operand)) return undefined;
  } else {
    return undefined;
  }
  const inner = node.childForFieldName('arguments')?.namedChildren[0];
  const designator = inner ? handlerDesignator(inner, bindings, hints) : undefined;
  return designator ? { callee: callee.text, ...designator } : undefined;
}

function handlerFact(
  node: SyntaxNode,
  bindings: GoRouteBindings,
  hints: Map<GoRouteBinding, RouteHandlerReceiver | undefined>,
): GoRouteHandlerFact {
  const designator = handlerDesignator(node, bindings, hints);
  if (designator) return designator;
  const handlerWrapper = wrappedHandler(node, bindings, hints);
  return handlerWrapper ? { handlerWrapper } : {};
}

/** Verb registrations of every function that has some, with the file's bindings. */
function* functionRegistrations(
  root: SyntaxNode,
): Generator<{ fn: SyntaxNode; registrations: VerbRegistration[]; bindings: GoRouteBindings }> {
  let bindings: GoRouteBindings | undefined;
  for (const fn of root.descendantsOfType(FUNCTION_TYPE_LIST)) {
    const body = fn.childForFieldName('body');
    if (!body) continue;
    const registrations = bodyNodes(body).flatMap((node) => {
      const registration = verbRegistration(node);
      return registration === null ? [] : [registration];
    });
    // Most functions register nothing; skip their bindings.
    if (registrations.length === 0) continue;
    bindings ??= new GoRouteBindings(root);
    yield { fn, registrations, bindings };
  }
}

export function extractGoGinEchoRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const root = tree.rootNode;
  const { framework } = readImports(root);
  if (framework === null) return [];

  const out: ExtractedDecoratorRoute[] = [];
  const handlerHints = new Map<GoRouteBinding, RouteHandlerReceiver | undefined>();
  for (const { fn, registrations, bindings } of functionRegistrations(root)) {
    const prefixes = new RouterPrefixes(bindings, frameworkRoot(framework), fn);

    for (const { call, verb, receiver, args, path } of registrations) {
      const prefix = prefixes.of(receiver);
      if (prefix === null) continue;

      const handler = framework.handlerArg === 'last' ? args[args.length - 1] : args[1];
      out.push({
        filePath,
        routePath: normalizeExtractedRoutePath(path, prefix),
        httpMethod: verb,
        decoratorName: verb,
        lineNumber: call.startPosition.row + 1 + lineOffset,
        prefix: null,
        source: framework.source,
        ...handlerFact(handler, bindings, handlerHints),
      });
    }
  }
  return out;
}

/** One verb registration whose router root is a parameter of a wrapper-package type. */
export interface GoRouteCandidate {
  readonly routePath: string;
  readonly httpMethod: string;
  readonly lineNumber: number;
  /** The handler read in gin's order (last argument). */
  readonly gin: GoRouteHandlerFact;
  /** The handler read in echo's order (second argument). */
  readonly echo: GoRouteHandlerFact;
}

/**
 * Route candidates of one file, grouped by the root parameter's declared type.
 * The worker cannot tell whether `pkg.T` is a gin/echo engine (that is user
 * configuration, applied on the main thread), so it records registrations
 * under every imported, non-framework root type; nothing here is a route yet.
 */
export interface GoRouteCandidateFacts {
  readonly roots: readonly {
    readonly importPath: string;
    readonly typeName: string;
    readonly routes: readonly GoRouteCandidate[];
  }[];
}

/** `*Q.T` / `Q.T` parameters of `fn`, where `Q` is an import of this file. */
function importedRootTypes(
  fn: SyntaxNode,
  bindings: GoRouteBindings,
  imports: ReadonlyMap<string, string>,
): { importPath: string; qualifier: string; typeName: string }[] {
  const out = new Map<string, { importPath: string; qualifier: string; typeName: string }>();
  const parameters = fn.childForFieldName('parameters');
  for (const declaration of parameters?.namedChildren ?? []) {
    if (declaration.type !== 'parameter_declaration') continue;
    const hint = typeHint(declaration.childForFieldName('type'), bindings);
    if (hint?.kind !== 'type' || !hint.qualifier || !hint.name) continue;
    const importPath = imports.get(hint.qualifier);
    // Framework packages are the direct extractor's job, not a candidate.
    if (!importPath || isGinImportPath(importPath) || isEchoImportPath(importPath)) continue;
    out.set(`${hint.qualifier}.${hint.name}`, {
      importPath,
      qualifier: hint.qualifier,
      typeName: hint.name,
    });
  }
  return [...out.values()];
}

export function extractGoRouteCandidates(
  tree: Parser.Tree,
  lineOffset = 0,
): GoRouteCandidateFacts | undefined {
  const root = tree.rootNode;
  const { imports } = readImports(root);
  const byRoot = new Map<
    string,
    { importPath: string; typeName: string; routes: GoRouteCandidate[] }
  >();
  const handlerHints = new Map<GoRouteBinding, RouteHandlerReceiver | undefined>();
  for (const { fn, registrations, bindings } of functionRegistrations(root)) {
    for (const rootType of importedRootTypes(fn, bindings, imports)) {
      const prefixes = new RouterPrefixes(
        bindings,
        {
          alias: null,
          constructors: new Set(),
          isRootParameterType: (hint) =>
            hint?.kind === 'type' &&
            hint.qualifier === rootType.qualifier &&
            hint.name === rootType.typeName,
        },
        fn,
      );
      for (const { call, verb, receiver, args, path } of registrations) {
        const prefix = prefixes.of(receiver);
        if (prefix === null) continue;
        const key = `${rootType.importPath}\u0000${rootType.typeName}`;
        let group = byRoot.get(key);
        if (!group) {
          group = { importPath: rootType.importPath, typeName: rootType.typeName, routes: [] };
          byRoot.set(key, group);
        }
        group.routes.push({
          routePath: normalizeExtractedRoutePath(path, prefix),
          httpMethod: verb,
          lineNumber: call.startPosition.row + 1 + lineOffset,
          gin: handlerFact(args[args.length - 1], bindings, handlerHints),
          echo: handlerFact(args[1], bindings, handlerHints),
        });
      }
    }
  }
  return byRoot.size === 0 ? undefined : { roots: [...byRoot.values()] };
}
