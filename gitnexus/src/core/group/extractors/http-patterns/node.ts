import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type CompiledPatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin, HttpScanContext } from './types.js';

/**
 * Node.js / TypeScript HTTP plugin family. Handles:
 *   - NestJS `@Controller('prefix')` classes with `@Get(':id')` methods
 *   - Express `router.get(...)` / `app.post(...)` providers
 *   - Next.js App Router `app/.../route.ts` exported verb handlers
 *   - `fetch(url)` / `fetch(url, { method: 'POST' })` consumers
 *   - `axios.get(url)` / `axios.delete(url)` consumers
 *   - likely custom HTTP clients, e.g. `apiClient.post(url)` consumers
 *   - `axios({ method, url })` object-form consumers
 *   - jQuery `$.get(url)` / `$.post(url, ...)` shorthand consumers
 *   - jQuery `$.ajax({ url, method | type })` consumers
 *
 * Because the JavaScript and TypeScript tree-sitter grammars share
 * node type names for every construct we query, pattern sources are
 * defined once and compiled against each grammar variant. The plugin
 * exports three `HttpLanguagePlugin`s (JS, TS, TSX) that share the
 * same `scan` function but bind to different grammars.
 */

// ─── Provider: NestJS — class-level @Controller('prefix') ────────────
// In tree-sitter-typescript decorators are NOT children of
// class_declaration / method_definition — they're siblings in the
// surrounding class_body / program node. We therefore match the
// decorator standalone and walk to its related class/method in JS.
const NEST_CONTROLLER_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#eq? @dec "Controller")
        arguments: (arguments . [(string) (template_string)] @prefix))) @ctrl_decorator
  `,
};

// ─── Provider: NestJS — method-level @Get/@Post/... decorators ───────
// Matches either `@Get('path')` or `@Get()`. The `@path` capture is
// optional — when the first argument isn't a string, the plugin falls
// back to '/' for the method-level path.
const NEST_METHOD_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#match? @dec "^(Get|Post|Put|Delete|Patch|Head|Options)$")
        arguments: (arguments) @args)) @method_decorator
  `,
};

// ─── Provider: Express — router.get/app.post/... ─────────────────────
const EXPRESS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#match? @obj "^(router|app)$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch|head|options)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: fetch(url) with NO options ─────────────────────────────
const FETCH_NO_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments . [(string) (template_string)] @path .))
  `,
};

// ─── Consumer: fetch(url, { method: 'X', ... }) ──────────────────────
const FETCH_WITH_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments
        . [(string) (template_string)] @path
        (object) @options))
  `,
};

// ─── Consumer: axios.get/post/... ────────────────────────────────────
const AXIOS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "axios")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch|head|options)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: jQuery shorthand $.get(url) / $.post(url, ...) ────────
// Custom HTTP clients such as `apiClient.post('/api/orders')`.
const HTTP_CLIENT_MEMBER_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch|head|options)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// jQuery shorthand $.get(url) / $.post(url, ...).
const JQUERY_SHORTHAND_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: jQuery $.ajax({ url, method|type }) ───────────────────
// The query captures the options object only; key/value pairs are read
// programmatically via `readStringProp` below, which tolerates any key
// order and accepts either `method:` or `type:` (jQuery supports both).
const JQUERY_AJAX_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @fn (#eq? @fn "ajax"))
      arguments: (arguments (object) @options))
  `,
};

// ─── Consumer: axios({ method, url }) object form ────────────────────
// Distinct from AXIOS_SPEC above because the call target is an identifier
// (`axios`) rather than a member expression (`axios.get`). As with the
// jQuery ajax form, option keys are resolved programmatically.
const AXIOS_OBJECT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "axios")
      arguments: (arguments (object) @options))
  `,
};

interface NodePatternBundle {
  controller: CompiledPatterns<Record<string, never>>;
  methodDecorator: CompiledPatterns<Record<string, never>>;
  express: CompiledPatterns<Record<string, never>>;
  fetchNoOptions: CompiledPatterns<Record<string, never>>;
  fetchWithOptions: CompiledPatterns<Record<string, never>>;
  axios: CompiledPatterns<Record<string, never>>;
  httpClientMember: CompiledPatterns<Record<string, never>>;
  jqueryShorthand: CompiledPatterns<Record<string, never>>;
  jqueryAjax: CompiledPatterns<Record<string, never>>;
  axiosObject: CompiledPatterns<Record<string, never>>;
}

function compileBundle(language: unknown, name: string): NodePatternBundle {
  const mk = (spec: PatternSpec<Record<string, never>>, suffix: string) =>
    compilePatterns({
      name: `${name}-${suffix}`,
      language,
      patterns: [spec],
    } satisfies LanguagePatterns<Record<string, never>>);
  return {
    controller: mk(NEST_CONTROLLER_SPEC, 'nest-controller'),
    methodDecorator: mk(NEST_METHOD_SPEC, 'nest-method-decorator'),
    express: mk(EXPRESS_SPEC, 'express'),
    fetchNoOptions: mk(FETCH_NO_OPTIONS_SPEC, 'fetch-no-options'),
    fetchWithOptions: mk(FETCH_WITH_OPTIONS_SPEC, 'fetch-with-options'),
    axios: mk(AXIOS_SPEC, 'axios'),
    httpClientMember: mk(HTTP_CLIENT_MEMBER_SPEC, 'http-client-member'),
    jqueryShorthand: mk(JQUERY_SHORTHAND_SPEC, 'jquery-shorthand'),
    jqueryAjax: mk(JQUERY_AJAX_SPEC, 'jquery-ajax'),
    axiosObject: mk(AXIOS_OBJECT_SPEC, 'axios-object'),
  };
}

const JAVASCRIPT_BUNDLE = compileBundle(JavaScript, 'javascript-http');
const TYPESCRIPT_BUNDLE = compileBundle(TypeScript.typescript, 'typescript-http');
const TSX_BUNDLE = compileBundle(TypeScript.tsx, 'tsx-http');

const NEST_DECORATOR_TO_HTTP: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const RESERVED_HTTP_CLIENT_NAMES = new Set(['$', 'app', 'router', 'server', 'express', 'axios']);
const EXACT_HTTP_CLIENT_NAMES = new Set([
  'api',
  'client',
  'http',
  'request',
  'requests',
  'ky',
  'got',
  'apiclient',
  'httpclient',
  'requestclient',
]);

/**
 * Find the nearest enclosing class_declaration for a node, or null.
 */
function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

function joinPath(prefix: string, sub: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = sub.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`;
  return `/${cleanPrefix}/${cleanSub}`;
}

function methodFromIdentifier(name: string | undefined): string | null {
  const method = (name ?? '').toUpperCase();
  return HTTP_METHODS.has(method) ? method : null;
}

function normalizeNextRouteSegment(segment: string): string | null {
  if (!segment || segment.startsWith('@')) return null;
  if (/^\([^)]+\)$/.test(segment)) return null;
  const withoutInterceptMarker = segment.replace(/^\((?:\.|\.\.|\.\.\.)\)/, '');
  return withoutInterceptMarker || null;
}

function pathFromNextRouteFile(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?app\/(?:(.*)\/)?route\.(?:js|jsx|ts|tsx)$/i);
  if (!match) return null;
  const routePart = match[1] ?? '';
  const segments = routePart
    .split('/')
    .map((segment) => normalizeNextRouteSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/';
}

function walkNamed(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    visit(child);
    walkNamed(child, visit);
  }
}

function isExportedTopLevel(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'export_statement') return true;
    if (cur.type === 'program' || cur.type === 'statement_block' || cur.type === 'class_body') {
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

function isLikelyNextHandlerValue(node: Parser.SyntaxNode | null): boolean {
  if (!node) return false;
  return [
    'arrow_function',
    'function_expression',
    'identifier',
    'call_expression',
    'await_expression',
  ].includes(node.type);
}

function scanNextAppRouteHandlers(tree: Parser.Tree, routePath: string): HttpDetection[] {
  const out: HttpDetection[] = [];
  const seen = new Set<string>();

  walkNamed(tree.rootNode, (node) => {
    let method: string | null = null;

    if (node.type === 'function_declaration') {
      method = methodFromIdentifier(node.childForFieldName('name')?.text);
      if (!method || !isExportedTopLevel(node)) return;
    } else if (node.type === 'variable_declarator') {
      method = methodFromIdentifier(node.childForFieldName('name')?.text);
      if (!method || !isExportedTopLevel(node)) return;
      if (!isLikelyNextHandlerValue(node.childForFieldName('value'))) return;
    } else {
      return;
    }

    const key = `${method}:${routePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      role: 'provider',
      framework: 'next-app-router',
      method,
      path: routePath,
      name: method,
      confidence: 0.82,
    });
  });

  return out;
}

function isLikelyHttpUrl(path: string): boolean {
  return /^(\/|https?:\/\/)/i.test(path.trim());
}

function isLikelyHttpClientName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized || RESERVED_HTTP_CLIENT_NAMES.has(normalized)) return false;
  if (EXACT_HTTP_CLIENT_NAMES.has(normalized)) return true;
  if (normalized.startsWith('api') || normalized.startsWith('http')) return true;
  if (normalized.endsWith('api')) return true;
  return normalized.endsWith('client') && /(api|http|request)/.test(normalized);
}

/**
 * Walk `pair` children of an `object` literal and return the unquoted
 * string/template_string value for the first pair whose key matches one
 * of `keyNames`. Returns null when no matching pair is present or the
 * value is not a string literal. Used by the jQuery ajax / axios object
 * consumers to resolve `url` / `method` / `type` keys in any order.
 */
function readStringProp(objectNode: Parser.SyntaxNode, keyNames: readonly string[]): string | null {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const pair = objectNode.namedChild(i);
    if (!pair || pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    const key = unquoteLiteral(keyNode.text) ?? keyNode.text;
    if (!keyNames.includes(key)) continue;
    if (valueNode.type !== 'string' && valueNode.type !== 'template_string') continue;
    const lit = unquoteLiteral(valueNode.text);
    if (lit !== null) return lit;
  }
  return null;
}

/**
 * For a standalone `decorator` node (child of class_body / program),
 * find the related `class_declaration` node that it decorates. In
 * tree-sitter-typescript the decorator is placed before the class
 * declaration as a sibling (when decorating a class) or inside the
 * class_body before a method_definition (when decorating a method);
 * we walk the parent chain until we find the enclosing class.
 */
function findDecoratedClass(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const parent = decoratorNode.parent;
  if (!parent) return null;
  // Case 1: decorator is a sibling of the class_declaration at program /
  // export_statement level. Walk forward through siblings until we find
  // the class_declaration this decorator belongs to.
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && child.id === decoratorNode.id) {
      for (let j = i + 1; j < parent.namedChildCount; j++) {
        const next = parent.namedChild(j);
        if (!next) continue;
        if (next.type === 'decorator') continue; // adjacent decorators stack
        if (next.type === 'class_declaration') return next;
        if (next.type === 'export_statement') {
          // `export class Foo { ... }` wraps the declaration.
          for (let k = 0; k < next.namedChildCount; k++) {
            const inner = next.namedChild(k);
            if (inner?.type === 'class_declaration') return inner;
          }
        }
        break;
      }
      break;
    }
  }
  // Case 2: decorator is inside a class_body (decorating a method) —
  // walk up to the enclosing class_declaration.
  return findEnclosingClass(decoratorNode);
}

/**
 * For a method-level decorator node (child of class_body before a
 * method_definition), find the method_definition it decorates.
 */
function findDecoratedMethod(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const parent = decoratorNode.parent;
  if (!parent || parent.type !== 'class_body') return null;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && child.id === decoratorNode.id) {
      for (let j = i + 1; j < parent.namedChildCount; j++) {
        const next = parent.namedChild(j);
        if (!next) continue;
        if (next.type === 'decorator') continue;
        if (next.type === 'method_definition') return next;
        return null;
      }
      return null;
    }
  }
  return null;
}

function scanBundle(
  bundle: NodePatternBundle,
  tree: Parser.Tree,
  context?: HttpScanContext,
): HttpDetection[] {
  const out: HttpDetection[] = [];

  const nextRoutePath = pathFromNextRouteFile(context?.filePath);
  if (nextRoutePath) {
    out.push(...scanNextAppRouteHandlers(tree, nextRoutePath));
  }

  // NestJS: collect `@Controller('prefix')` class decorators, keyed by
  // the `class_declaration` they decorate.
  const prefixByClassId = new Map<number, string>();
  for (const match of runCompiledPatterns(bundle.controller, tree)) {
    const prefixNode = match.captures.prefix;
    const decoratorNode = match.captures.ctrl_decorator;
    if (!prefixNode || !decoratorNode) continue;
    const prefix = unquoteLiteral(prefixNode.text);
    if (prefix === null) continue;
    const classNode = findDecoratedClass(decoratorNode);
    if (!classNode) continue;
    prefixByClassId.set(classNode.id, prefix);
  }

  // NestJS: method-level @Get/@Post/... decorators. The decorator's
  // arguments list may be empty (`@Get()`), a string (`@Get('path')`),
  // or something else (which we skip).
  for (const match of runCompiledPatterns(bundle.methodDecorator, tree)) {
    const decNode = match.captures.dec;
    const argsNode = match.captures.args;
    const decoratorNode = match.captures.method_decorator;
    if (!decNode || !argsNode || !decoratorNode) continue;
    const httpMethod = NEST_DECORATOR_TO_HTTP[decNode.text];
    if (!httpMethod) continue;
    const methodNode = findDecoratedMethod(decoratorNode);
    if (!methodNode) continue;
    const enclosingClass = findEnclosingClass(methodNode);
    // Only emit NestJS detections when the class actually has a
    // @Controller decorator — without it, the match is almost certainly
    // something else (e.g. an unrelated library using similar names).
    if (!enclosingClass || !prefixByClassId.has(enclosingClass.id)) continue;
    const prefix = prefixByClassId.get(enclosingClass.id) ?? '';

    let rawPath = '/';
    const firstArg = argsNode.namedChild(0);
    if (firstArg && (firstArg.type === 'string' || firstArg.type === 'template_string')) {
      const unquoted = unquoteLiteral(firstArg.text);
      if (unquoted !== null) rawPath = unquoted;
    }

    // Get the method name from the decorated method_definition.
    const methodNameNode = methodNode.childForFieldName('name');
    const name = methodNameNode?.text ?? null;

    out.push({
      role: 'provider',
      framework: 'nest',
      method: httpMethod,
      path: joinPath(prefix, rawPath),
      name,
      confidence: 0.8,
    });
  }

  // Express: router/app.<verb>(...)
  for (const match of runCompiledPatterns(bundle.express, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'provider',
      framework: 'express',
      method: methodNode.text.toUpperCase(),
      path,
      name: 'handler',
      confidence: 0.8,
    });
  }

  // Consumer: fetch with options { method: 'X' }
  const fetchSeen = new Set<number>();
  for (const match of runCompiledPatterns(bundle.fetchWithOptions, tree)) {
    const pathNode = match.captures.path;
    const optionsNode = match.captures.options;
    if (!pathNode || !optionsNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    fetchSeen.add(pathNode.id);
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: plain fetch(path) — default GET. Skip path nodes we already
  // matched with the options variant so we don't double-emit.
  for (const match of runCompiledPatterns(bundle.fetchNoOptions, tree)) {
    const pathNode = match.captures.path;
    if (!pathNode) continue;
    if (fetchSeen.has(pathNode.id)) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method: 'GET',
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: axios.<verb>(url)
  for (const match of runCompiledPatterns(bundle.axios, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'axios',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: custom HTTP clients like apiClient.post(url) or http.get(url).
  for (const match of runCompiledPatterns(bundle.httpClientMember, tree)) {
    const objectNode = match.captures.obj;
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!objectNode || !methodNode || !pathNode) continue;
    if (!isLikelyHttpClientName(objectNode.text)) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null || !isLikelyHttpUrl(path)) continue;
    out.push({
      role: 'consumer',
      framework: 'http-client',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      confidence: 0.68,
    });
  }

  // Consumer: jQuery shorthand $.get(url) / $.post(url, ...)
  for (const match of runCompiledPatterns(bundle.jqueryShorthand, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: jQuery $.ajax({ url, method|type }). jQuery accepts either
  // `method:` or `type:`; both default to GET when absent.
  for (const match of runCompiledPatterns(bundle.jqueryAjax, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method', 'type']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: axios({ method, url }) object form. Structurally distinct
  // from axios.<verb>(url) (identifier vs member_expression call), so no
  // dedup against the member-form loop above is required.
  for (const match of runCompiledPatterns(bundle.axiosObject, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    out.push({
      role: 'consumer',
      framework: 'axios',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  return out;
}

export const JAVASCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'javascript-http',
  language: JavaScript,
  scan: (tree, context) => scanBundle(JAVASCRIPT_BUNDLE, tree, context),
};

export const TYPESCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'typescript-http',
  language: TypeScript.typescript,
  scan: (tree, context) => scanBundle(TYPESCRIPT_BUNDLE, tree, context),
};

export const TSX_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'tsx-http',
  language: TypeScript.tsx,
  scan: (tree, context) => scanBundle(TSX_BUNDLE, tree, context),
};
