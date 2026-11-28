import type Parser from 'tree-sitter';
import { extractStringContent, findDescendant, type SyntaxNode } from '../utils/ast-helpers.js';
import { splitNamespaceUseDeclaration } from '../languages/php/import-decomposer.js';
import { normalizeQualifiedName } from '../utils/qualified-name.js';
import {
  EMPTY_ROUTE_GROUP_CONTEXT,
  expandMiddlewareTokens,
  extendRouteGroupContext,
  mergeLaravelRouteName,
  mergeLumenRouteName,
  qualifyStringActionController,
  type ComposedRouteGroupContext,
  type PhpRouteReceiverKind,
  type RouteGroupContext,
} from '../languages/php/route-group.js';

export type { RouteGroupContext, PhpRouteReceiverKind } from '../languages/php/route-group.js';

/** Group stack composed per receiver kind: Laravel and Lumen merge `as`/namespace differently. */
type ComposedGroups = Readonly<Record<PhpRouteReceiverKind, ComposedRouteGroupContext>>;

const NO_GROUPS: ComposedGroups = {
  laravel: EMPTY_ROUTE_GROUP_CONTEXT,
  lumen: EMPTY_ROUTE_GROUP_CONTEXT,
};

function extendComposedGroups(parent: ComposedGroups, ctx: RouteGroupContext): ComposedGroups {
  return {
    laravel: extendRouteGroupContext(parent.laravel, ctx, 'laravel'),
    lumen: extendRouteGroupContext(parent.lumen, ctx, 'lumen'),
  };
}

export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  routeName: string | null;
  controllerName: string | null;
  /**
   * The controller class's normalized (dot-joined) fully-qualified name when
   * the routes file disambiguates it — via a `use` import (`use App\…\X;` or
   * `use App\…\X as Y;`) or an inline qualified `::class` reference. Resolved
   * to the same key shape the type registry stores (`normalizeQualifiedName`),
   * so the emitter can `lookupClassByQualifiedName` to disambiguate
   * same-short-name controllers. `null`/undefined when only a bare short name
   * is available — the emitter then falls back to short-name resolution.
   */
  controllerQualifiedName?: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
  /** True when the handler is a string/`uses` action — group namespace applies. */
  stringAction?: boolean;
  stringActionGroupNamespace?: string | null;
  stringActionAbsoluteController?: boolean;
  /** In-file group stack used a leading-`\\` namespace that resets outers. */
  stringActionGroupNamespaceResets?: boolean;
}

/** HTTP verbs exposed on Lumen's Router (no `any` / `match` / `resource`). */
const LUMEN_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

const ROUTE_HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'any',
  'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);
const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

function getMemberObject(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName?.('object') ?? node.children?.[0] ?? null;
}

function phpVariableName(node: SyntaxNode | null | undefined): string | null {
  if (node?.type !== 'variable_name') return null;
  return node.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
}

/** Variables that hold the Lumen application in bootstrap and route files. */
const LUMEN_APP_VARIABLES = new Set(['app', 'this']);

/** `$router`, `$app->router` or `$this->router` — the Lumen router, not any `->router` property. */
function isRouterReceiver(node: SyntaxNode | null | undefined): boolean {
  if (!node) return false;
  if (phpVariableName(node) === 'router') return true;
  if (node.type === 'member_access_expression' && getRouterCallMethodName(node) === 'router') {
    const owner = phpVariableName(getMemberObject(node));
    return owner !== null && LUMEN_APP_VARIABLES.has(owner);
  }
  return false;
}

/** PHP method names are case-insensitive. Property names are not, so `$app->router` stays exact. */
function phpMethodName(node: SyntaxNode): string | null {
  const name = getRouterCallMethodName(node);
  if (name === null) return null;
  const lower = name.toLowerCase();
  // The resource set and action split keep this spelling.
  return lower === 'apiresource' ? 'apiResource' : lower;
}

export function isPhpRouterGroupCall(node: SyntaxNode): boolean {
  if (node.type !== 'member_call_expression') return false;
  if (phpMethodName(node) !== 'group') return false;
  return isRouterReceiver(getMemberObject(node));
}

function isPhpRouterHttpCall(node: SyntaxNode): boolean {
  if (node.type !== 'member_call_expression') return false;
  if (!isRouterReceiver(getMemberObject(node))) return false;
  const method = phpMethodName(node);
  return method !== null && LUMEN_HTTP_METHODS.has(method);
}

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: SyntaxNode): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
export function getRouterCallMethodName(node: SyntaxNode): string | null {
  const nameNode =
    node.childForFieldName?.('name') ?? node.children?.find((c: SyntaxNode) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
export function getRouterCallArguments(node: SyntaxNode): SyntaxNode | null {
  return node.children?.find((c: SyntaxNode) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
export function findRouteGroupClosureBody(argsNode: SyntaxNode | null): SyntaxNode | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' || inner.type === 'arrow_function') {
          return (
            inner.childForFieldName?.('body') ??
            inner.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
            null
          );
        }
      }
    }
    if (child.type === 'anonymous_function' || child.type === 'arrow_function') {
      return (
        child.childForFieldName?.('body') ??
        child.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
        null
      );
    }
  }
  return null;
}

function callArguments(argsNode: SyntaxNode | null): SyntaxNode[] {
  if (!argsNode) return [];
  const out: SyntaxNode[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      const inner = child.children?.[0];
      if (inner) out.push(inner);
    } else if (child.isNamed && child.type !== 'comment') {
      out.push(child);
    }
  }
  return out;
}

function firstCallArgument(argsNode: SyntaxNode | null): SyntaxNode | null {
  return callArguments(argsNode)[0] ?? null;
}

/**
 * Value of a leaf the caller knows (e.g. `__DIR__`): a string, `null` for
 * "not a literal", or `undefined` to let the fold handle the node.
 */
export type PhpLiteralLeaf = (node: SyntaxNode) => string | null | undefined;

const CONCAT = Symbol('concat');

/**
 * Fold a literal string or `.`-concatenation of literals; `null` otherwise.
 * Iterative, and keyed by position rather than node identity: tree-sitter
 * wrappers are not stable across reads, so identity-keyed state can miss.
 */
export function foldPhpStringLiteral(
  node: SyntaxNode | null | undefined,
  leaf?: PhpLiteralLeaf,
): string | null {
  if (!node) return null;
  const work: (SyntaxNode | typeof CONCAT)[] = [node];
  const values: (string | null)[] = [];
  while (work.length > 0) {
    const item = work.pop()!;
    if (item === CONCAT) {
      const right = values.pop() ?? null;
      const left = values.pop() ?? null;
      values.push(left !== null && right !== null ? left + right : null);
      continue;
    }
    const known = leaf?.(item);
    if (known !== undefined) {
      values.push(known);
      continue;
    }
    if (item.type === 'string' || item.type === 'encapsed_string') {
      values.push(readPhpString(item));
    } else if (item.type === 'parenthesized_expression') {
      const inner = item.namedChildren?.find((c: SyntaxNode) => c.type !== 'comment');
      if (inner) work.push(inner);
      else values.push(null);
    } else if (item.type === 'binary_expression') {
      const left = item.childForFieldName?.('left');
      const right = item.childForFieldName?.('right');
      if (item.childForFieldName?.('operator')?.type !== '.' || !left || !right) {
        values.push(null);
      } else {
        work.push(CONCAT, right, left);
      }
    } else {
      values.push(null);
    }
  }
  return values.pop() ?? null;
}

/** First route URI argument: literal string or pure literal concatenation, else null. */
export function extractRouteUriArg(
  argsNode: SyntaxNode | null,
  httpMethod?: string,
): string | null {
  const args = callArguments(argsNode);
  const uriNode = httpMethod === 'match' ? args[1] : args[0];
  return foldPhpStringLiteral(uriNode);
}

/** Extract first string argument from arguments node (legacy call sites). */
function extractFirstStringArg(argsNode: SyntaxNode | null): string | null {
  return extractRouteUriArg(argsNode);
}

function readMiddlewareTokensFromValue(
  val: SyntaxNode | null | undefined,
  kind: PhpRouteReceiverKind,
): string[] {
  if (!val) return [];
  if (val.type === 'string' || val.type === 'encapsed_string') {
    const raw = readPhpString(val);
    if (!raw) return [];
    return kind === 'lumen' ? expandMiddlewareTokens(raw) : [raw];
  }
  if (val.type === 'array_creation_expression') {
    const items: string[] = [];
    for (const el of val.children ?? []) {
      if (el.type !== 'array_element_initializer') continue;
      const str = el.children?.find(
        (c: SyntaxNode) => c.type === 'string' || c.type === 'encapsed_string',
      );
      const raw = str ? readPhpString(str) : null;
      if (!raw) continue;
      items.push(raw);
    }
    return items;
  }
  return [];
}

/** Extract middleware from arguments — handles string or array */
function extractMiddlewareArg(
  argsNode: SyntaxNode | null,
  kind: PhpRouteReceiverKind = 'laravel',
): string[] {
  if (!argsNode) return [];
  const target = firstCallArgument(argsNode);
  if (!target) return [];
  return readMiddlewareTokensFromValue(target, kind);
}

/** Extract Controller::class from arguments */
function extractClassArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

function joinRouteName(prefix: string | null, name: string | null): string | null {
  return mergeLaravelRouteName(prefix, name);
}

const ENCAPSED_LITERAL_CHILD_TYPES = new Set(['string_content', 'escape_sequence']);

function encapsedStringIsFullyLiteral(node: SyntaxNode): boolean {
  for (const child of node.children ?? []) {
    if (!child.isNamed) continue;
    if (ENCAPSED_LITERAL_CHILD_TYPES.has(child.type)) continue;
    return false;
  }
  return true;
}

const PHP_DOUBLE_QUOTED_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  v: '\v',
  e: '\x1b',
  f: '\f',
  '\\': '\\',
  $: '$',
  '"': '"',
};

/**
 * Decode one `escape_sequence` node. The grammar only emits escape nodes for
 * sequences the quote style recognizes (single-quoted: `\\` and `\'`); any
 * other backslash stays in `string_content`, matching PHP.
 */
function decodePhpEscapeSequence(esc: string, doubleQuoted: boolean): string {
  const body = esc.slice(1);
  if (!doubleQuoted) return body === '\\' || body === "'" ? body : esc;
  const simple = PHP_DOUBLE_QUOTED_SIMPLE_ESCAPES[body];
  if (simple !== undefined) return simple;
  if (/^[0-7]{1,3}$/.test(body)) return String.fromCharCode(parseInt(body, 8) & 0xff);
  const hex = /^x([0-9A-Fa-f]{1,2})$/.exec(body);
  if (hex) return String.fromCharCode(parseInt(hex[1], 16));
  const unicode = /^u\{([0-9A-Fa-f]+)\}$/.exec(body);
  if (unicode) {
    const codePoint = parseInt(unicode[1], 16);
    if (codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
  }
  return esc;
}

/** Literal value of a PHP string node; `null` when it interpolates. */
export function readPhpString(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'encapsed_string' && !encapsedStringIsFullyLiteral(node)) return null;
  if (node.type === 'string' || node.type === 'encapsed_string') {
    const doubleQuoted = node.type === 'encapsed_string';
    let out = '';
    for (const child of node.children ?? []) {
      if (child.type === 'string_content') out += child.text;
      else if (child.type === 'escape_sequence') {
        out += decodePhpEscapeSequence(child.text, doubleQuoted);
      }
    }
    return out;
  }
  return extractStringContent(node);
}

function routeNameBaseFromPath(routePath: string | null): string | null {
  const base = routePath
    ?.trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '.');
  return base || null;
}

function appendResourceActionName(base: string | null, action: string): string | null {
  if (!base) return null;
  return base.endsWith('.') ? `${base}${action}` : `${base}.${action}`;
}

/**
 * Read the controller class reference out of a `class_constant_access_expression`
 * (the `X::class` node). Returns the simple short name (for short-name fallback)
 * and, when the reference is itself namespace-qualified (`\App\Admin\X::class`),
 * its normalized dot-joined fully-qualified name (for direct disambiguation).
 */
function readControllerClassRef(classAccess: SyntaxNode): {
  simple: string | null;
  qualified: string | null;
} {
  const nameChild = classAccess.children?.find((c: SyntaxNode) => c.type === 'name');
  const qualifiedChild = classAccess.children?.find((c: SyntaxNode) => c.type === 'qualified_name');
  const qualified = qualifiedChild ? normalizeQualifiedName(qualifiedChild.text) : null;
  // When only a qualified_name is present, derive the simple short name from
  // its last segment so short-name fallback still works.
  const simple = nameChild?.text ?? (qualified ? (qualified.split('.').pop() ?? null) : null);
  return { simple, qualified };
}

function parseAssociativeRouteAction(
  handlerNode: SyntaxNode,
  kind: PhpRouteReceiverKind = 'laravel',
): {
  controller: string | null;
  controllerQualified: string | null;
  method: string | null;
  bareMethod: string | null;
  actionRouteName: string | null;
  actionMiddleware: string[];
  stringAction: boolean;
  controllerAbsolute: boolean;
} | null {
  let uses: string | null = null;
  let actionRouteName: string | null = null;
  const actionMiddleware: string[] = [];
  let keyed = false;
  for (const el of handlerNode.children ?? []) {
    if (el.type !== 'array_element_initializer') continue;
    const children = el.children ?? [];
    const arrowIdx = children.findIndex((c: SyntaxNode) => c.type === '=>');
    if (arrowIdx === -1) continue;
    keyed = true;
    const key = readPhpString(children[arrowIdx - 1]);
    const val = children[arrowIdx + 1];
    if (key === 'uses') {
      uses = val?.type === 'string' || val?.type === 'encapsed_string' ? readPhpString(val) : null;
    } else if (key === 'as') {
      actionRouteName =
        val?.type === 'string' || val?.type === 'encapsed_string' ? readPhpString(val) : null;
    } else if (key === 'middleware') {
      actionMiddleware.push(...readMiddlewareTokensFromValue(val, kind));
    }
  }
  // Positional `[Ctrl::class, 'm']` has no keys. A keyed action without a
  // string `uses` (closure, dynamic value) has no resolvable handler.
  if (!keyed) return null;
  if (!uses) {
    return {
      controller: null,
      controllerQualified: null,
      method: null,
      bareMethod: null,
      actionRouteName,
      actionMiddleware,
      stringAction: false,
      controllerAbsolute: false,
    };
  }
  if (uses.includes('@')) {
    const at = uses.indexOf('@');
    const controller = uses.slice(0, at);
    const method = uses.slice(at + 1);
    const absolute = controller.startsWith('\\');
    return {
      controller: absolute ? controller.replace(/^\\+/, '') : controller,
      controllerQualified: null,
      method,
      bareMethod: null,
      actionRouteName,
      actionMiddleware,
      stringAction: true,
      controllerAbsolute: absolute,
    };
  }
  return {
    controller: null,
    controllerQualified: null,
    method: null,
    bareMethod: uses,
    actionRouteName,
    actionMiddleware,
    stringAction: true,
    controllerAbsolute: false,
  };
}

/** Extract controller class name from common Laravel handler argument shapes. */
function extractControllerTarget(
  argsNode: SyntaxNode | null,
  kind: PhpRouteReceiverKind = 'laravel',
  httpMethod?: string,
): {
  controller: string | null;
  controllerQualified: string | null;
  method: string | null;
  bareMethod: string | null;
  actionRouteName?: string | null;
  actionMiddleware?: string[];
  stringAction: boolean;
  controllerAbsolute: boolean;
} {
  const none = {
    controller: null,
    controllerQualified: null,
    method: null,
    bareMethod: null,
    stringAction: false,
    controllerAbsolute: false,
  };
  if (!argsNode) return none;

  const args = callArguments(argsNode);
  const handlerIndex = httpMethod === 'match' ? 2 : 1;
  const handlerNode = args[handlerIndex];
  if (!handlerNode) return none;

  if (handlerNode.type === 'anonymous_function' || handlerNode.type === 'arrow_function') {
    return none;
  }

  // Array syntax: [UserController::class, 'index'] or ['uses' => 'Ctrl@method', ...]
  if (handlerNode.type === 'array_creation_expression') {
    const assoc = parseAssociativeRouteAction(handlerNode, kind);
    if (assoc) return assoc;
    let controller: string | null = null;
    let controllerQualified: string | null = null;
    let method: string | null = null;
    const elements: SyntaxNode[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        const ref = readControllerClassRef(classAccess);
        controller = ref.simple;
        controllerQualified = ref.qualified;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], 'string');
      method = str ? extractStringContent(str) : null;
    }
    return {
      controller,
      controllerQualified,
      method,
      bareMethod: null,
      stringAction: false,
      controllerAbsolute: false,
    };
  }

  // String syntax: 'UserController@index'. A bare string such as 'index'
  // becomes a method only when a surrounding Route::controller(...) group
  // supplies the controller class.
  if (handlerNode.type === 'string' || handlerNode.type === 'encapsed_string') {
    const text = readPhpString(handlerNode);
    if (text?.includes('@')) {
      const at = text.indexOf('@');
      const controller = text.slice(0, at);
      const method = text.slice(at + 1);
      const absolute = controller.startsWith('\\');
      return {
        controller: absolute ? controller.replace(/^\\+/, '') : controller,
        controllerQualified: null,
        method,
        bareMethod: null,
        stringAction: true,
        controllerAbsolute: absolute,
      };
    }
    if (text) {
      return {
        controller: null,
        controllerQualified: null,
        method: null,
        bareMethod: text,
        stringAction: true,
        controllerAbsolute: false,
      };
    }
  }

  // Class reference: UserController::class (invokable controller)
  if (handlerNode.type === 'class_constant_access_expression') {
    const ref = readControllerClassRef(handlerNode);
    return {
      controller: ref.simple,
      controllerQualified: ref.qualified,
      method: '__invoke',
      bareMethod: null,
      stringAction: false,
      controllerAbsolute: false,
    };
  }

  return none;
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: SyntaxNode | null }[];
  terminalArgs: SyntaxNode | null;
  node: SyntaxNode;
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: SyntaxNode): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = phpMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getRouterCallArguments(node);
  const attributes: { method: string; argsNode: SyntaxNode | null }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === 'member_call_expression') {
      const method = phpMethodName(current);
      const args = getRouterCallArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === 'scoped_call_expression') {
      const obj = current.childForFieldName?.('object') ?? current.children?.[0];
      if (obj?.text !== 'Route') return null;

      const method = phpMethodName(current);
      const args = getRouterCallArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse Route::group / $router->group array syntax */
export function parseRouteGroupArrayArgs(
  argsNode: SyntaxNode | null,
  kind: PhpRouteReceiverKind = 'laravel',
): RouteGroupContext {
  const ctx: RouteGroupContext = {
    middleware: [],
    prefix: null,
    namePrefix: null,
    controller: null,
    namespace: null,
  };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: SyntaxNode) => c.type === '=>');
        if (arrowIdx === -1) continue;
        const key = readPhpString(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === 'middleware') {
          ctx.middleware.push(...readMiddlewareTokensFromValue(val, kind));
        } else if (key === 'prefix') {
          ctx.prefix = readPhpString(val) ?? null;
        } else if (key === 'as' || key === 'name') {
          ctx.namePrefix = readPhpString(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            const raw = val.text.replace(/\s+/g, '').replace(/::class$/i, '');
            ctx.controller = raw || null;
          }
        } else if (key === 'namespace') {
          const ns = readPhpString(val);
          if (ns !== null) {
            ctx.namespaceResets = ns.startsWith('\\');
            ctx.namespace = kind === 'lumen' ? ns : ns.replace(/^\\+|\\+$/g, '');
          }
        }
      }
    }
  }
  return ctx;
}

/**
 * Build the routes file's `use`-import alias map: local name (alias, else the
 * imported short name) → the class's normalized dot-joined fully-qualified name.
 * Reuses the PHP `use`-declaration decomposer so grouped (`use Foo\{A, B}`) and
 * aliased (`use Foo\Bar as Baz;`) forms are handled across grammar versions.
 * `use` statements are file-/namespace-scoped, so a shallow walk over the
 * routes file's structural nodes finds them all.
 */
function buildUseAliasMap(root: SyntaxNode): Map<string, string> {
  const aliasMap = new Map<string, string>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'namespace_use_declaration') {
      for (const match of splitNamespaceUseDeclaration(node)) {
        const source = match['@import.source']?.text;
        if (source === undefined) continue;
        const local = match['@import.alias']?.text ?? match['@import.name']?.text;
        if (local === undefined || local === '') continue;
        aliasMap.set(local, normalizeQualifiedName(source));
      }
      continue;
    }
    // Only descend through file/namespace structure where `use` can appear —
    // not into function bodies or expressions.
    if (
      node.type === 'program' ||
      node.type === 'namespace_definition' ||
      node.type === 'declaration_list' ||
      node.type === 'compound_statement'
    ) {
      for (const child of node.namedChildren ?? []) stack.push(child);
    }
  }
  return aliasMap;
}

/**
 * Resolve a route's controller to its normalized fully-qualified name when the
 * routes file disambiguates it: an inline qualified `::class` wins, else the
 * `use`-import alias map for the short/local name, else `null` (the emitter
 * falls back to short-name resolution).
 */
function resolveControllerQualifiedName(
  inlineQualified: string | null,
  controllerName: string | null,
  aliasMap: Map<string, string>,
  groupNamespace: string | null,
  stringAction: boolean,
  controllerAbsolute: boolean,
): string | null {
  if (inlineQualified) return inlineQualified;
  if (!controllerName) return null;
  if (!stringAction) {
    return aliasMap.get(controllerName) ?? null;
  }
  return qualifyStringActionController(
    controllerName,
    groupNamespace,
    controllerAbsolute,
    aliasMap.get(controllerName) ?? null,
  );
}

export function extractLaravelRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  const useAliasMap = buildUseAliasMap(tree.rootNode);

  function emitRoute(
    httpMethod: string,
    argsNode: SyntaxNode | null,
    lineNumber: number,
    groups: ComposedGroups,
    chainAttrs: { method: string; argsNode: SyntaxNode | null }[],
    receiverKind: PhpRouteReceiverKind,
  ) {
    const composed = groups[receiverKind];
    const effective = { ...composed, middleware: [...composed.middleware] };
    let routeName: string | null = null;

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware')
        effective.middleware.push(...extractMiddlewareArg(attr.argsNode, receiverKind));
      if (attr.method === 'prefix') {
        const p = extractFirstStringArg(attr.argsNode);
        if (p) effective.prefix = effective.prefix ? `${effective.prefix}/${p}` : p;
      }
      if (attr.method === 'controller') {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
      if (attr.method === 'name') {
        const seg = extractFirstStringArg(attr.argsNode);
        routeName =
          receiverKind === 'lumen'
            ? mergeLumenRouteName(effective.namePrefix, seg)
            : joinRouteName(effective.namePrefix, seg);
      }
    }

    const routePath = extractRouteUriArg(argsNode, httpMethod);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod) && receiverKind === 'laravel') {
      const target = extractControllerTarget(argsNode, receiverKind, httpMethod);
      const actions = httpMethod === 'apiResource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      const routeNameBase =
        routeName ?? joinRouteName(effective.namePrefix, routeNameBaseFromPath(routePath));
      for (const action of actions) {
        // A bare action inherits the group controller, which is a class
        // reference, so the route namespace must not prefix it.
        const stringAction = target.stringAction && target.controller != null;
        routes.push({
          filePath,
          httpMethod,
          routePath,
          routeName: appendResourceActionName(routeNameBase, action),
          controllerName: target.controller ?? effective.controller,
          controllerQualifiedName: resolveControllerQualifiedName(
            target.controllerQualified,
            target.controller ?? effective.controller,
            useAliasMap,
            effective.namespace,
            stringAction,
            target.controllerAbsolute,
          ),
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
          stringAction,
          stringActionGroupNamespace: stringAction ? effective.namespace : null,
          stringActionGroupNamespaceResets: stringAction ? effective.namespaceResets : false,
          stringActionAbsoluteController: target.controllerAbsolute,
        });
      }
    } else {
      const target = extractControllerTarget(argsNode, receiverKind, httpMethod);
      if (target.actionRouteName) routeName = target.actionRouteName;
      if (target.actionMiddleware?.length) {
        effective.middleware.push(...target.actionMiddleware);
      }
      if (receiverKind === 'lumen') {
        routeName = mergeLumenRouteName(effective.namePrefix, routeName);
      } else if (target.actionRouteName) {
        routeName = joinRouteName(effective.namePrefix, target.actionRouteName);
      }
      const controllerName = target.controller ?? effective.controller;
      // A bare action inherits the group controller, which is a class
      // reference, so the route namespace must not prefix it.
      const stringAction = target.stringAction && target.controller != null;
      routes.push({
        filePath,
        httpMethod,
        routePath,
        routeName,
        controllerName,
        controllerQualifiedName: resolveControllerQualifiedName(
          target.controllerQualified,
          controllerName,
          useAliasMap,
          effective.namespace,
          stringAction,
          target.controllerAbsolute,
        ),
        methodName: target.method ?? (effective.controller ? target.bareMethod : null),
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
        stringAction,
        stringActionGroupNamespace: stringAction ? effective.namespace : null,
        stringActionGroupNamespaceResets: stringAction ? effective.namespaceResets : false,
        stringActionAbsoluteController: target.controllerAbsolute,
      });
    }
  }

  // Iterative traversal using an explicit stack to avoid V8 call stack overflow
  // on deeply nested ASTs (e.g. Go stdlib, large Grafana components).
  // Each frame tracks the node and the group stack at that depth, already
  // composed, so a group level is joined once instead of once per route.
  interface WalkFrame {
    node: SyntaxNode;
    groupSnapshot: ComposedGroups;
  }

  const walkStack: WalkFrame[] = [{ node: tree.rootNode, groupSnapshot: NO_GROUPS }];

  while (walkStack.length > 0) {
    const { node, groupSnapshot } = walkStack.pop()!;

    // Case 1: Simple Route::get(...), Route::post(...), etc.
    if (isRouteStaticCall(node)) {
      const method = phpMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(
          method,
          getRouterCallArguments(node),
          node.startPosition.row,
          groupSnapshot,
          [],
          'laravel',
        );
        continue;
      }
      if (method === 'group') {
        const argsNode = getRouterCallArguments(node);
        const groupCtx = parseRouteGroupArrayArgs(argsNode, 'laravel');
        const body = findRouteGroupClosureBody(argsNode);
        if (body) {
          const childSnapshot = extendComposedGroups(groupSnapshot, groupCtx);
          const children = body.children ?? [];
          for (let i = children.length - 1; i >= 0; i--) {
            walkStack.push({ node: children[i], groupSnapshot: childSnapshot });
          }
        }
        continue;
      }
    }

    // Case 2: Fluent chain — Route::middleware(...)->group(...) or Route::middleware(...)->get(...)
    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === 'group') {
        const groupCtx: RouteGroupContext = {
          middleware: [],
          prefix: null,
          namePrefix: null,
          controller: null,
          namespace: null,
        };
        for (const attr of chain.attributes) {
          if (attr.method === 'middleware')
            groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode, 'laravel'));
          if (attr.method === 'prefix') groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'name') groupCtx.namePrefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'controller') groupCtx.controller = extractClassArg(attr.argsNode);
          if (attr.method === 'namespace') {
            const ns = extractFirstStringArg(attr.argsNode);
            if (ns !== null) {
              groupCtx.namespaceResets = ns.startsWith('\\');
              groupCtx.namespace = ns.replace(/^\\+|\\+$/g, '');
            }
          }
        }
        const body = findRouteGroupClosureBody(chain.terminalArgs);
        if (body) {
          const childSnapshot = extendComposedGroups(groupSnapshot, groupCtx);
          const children = body.children ?? [];
          for (let i = children.length - 1; i >= 0; i--) {
            walkStack.push({ node: children[i], groupSnapshot: childSnapshot });
          }
        }
        continue;
      }
      if (
        ROUTE_HTTP_METHODS.has(chain.terminalMethod) ||
        ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)
      ) {
        emitRoute(
          chain.terminalMethod,
          chain.terminalArgs,
          node.startPosition.row,
          groupSnapshot,
          chain.attributes,
          'laravel',
        );
        continue;
      }
      const chainedRouteIndex = chain.attributes.findIndex(
        (attr) => ROUTE_HTTP_METHODS.has(attr.method) || ROUTE_RESOURCE_METHODS.has(attr.method),
      );
      if (chainedRouteIndex >= 0) {
        const routeAttr = chain.attributes[chainedRouteIndex]!;
        const routeAttrs = [
          ...chain.attributes.slice(0, chainedRouteIndex),
          ...chain.attributes.slice(chainedRouteIndex + 1),
          { method: chain.terminalMethod, argsNode: chain.terminalArgs },
        ];
        emitRoute(
          routeAttr.method,
          routeAttr.argsNode,
          node.startPosition.row,
          groupSnapshot,
          routeAttrs,
          'laravel',
        );
        continue;
      }
    }

    if (isPhpRouterHttpCall(node)) {
      const method = phpMethodName(node);
      if (method) {
        emitRoute(
          method,
          getRouterCallArguments(node),
          node.startPosition.row,
          groupSnapshot,
          [],
          'lumen',
        );
      }
      continue;
    }
    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
      const body = findRouteGroupClosureBody(argsNode);
      if (body) {
        const childSnapshot = extendComposedGroups(groupSnapshot, groupCtx);
        const children = body.children ?? [];
        for (let i = children.length - 1; i >= 0; i--) {
          walkStack.push({ node: children[i], groupSnapshot: childSnapshot });
        }
      }
      continue;
    }

    // Default: push children in reverse so leftmost is processed first
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      walkStack.push({ node: children[i], groupSnapshot });
    }
  }
  return routes;
}
