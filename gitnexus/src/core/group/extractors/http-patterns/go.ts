import type Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { goImportPackageName } from '../../../ingestion/languages/go/import-package-name.js';
import { stringLiteral } from '../../../ingestion/route-extractors/go-shared.js';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Go HTTP plugin. Handles:
 *   - gin / echo framework routing — `r.GET("/path", handler)`, including
 *     prefixes from route groups bound in the same function (`r.Group("/api")`)
 *   - net/http stdlib — `http.HandleFunc("/path", handler)`
 *   - net/http consumer — `http.Get(...)`, `http.NewRequest("METHOD", ...)`
 *   - resty consumer — `client.R().Delete("/path")`
 */

// ─── Provider: framework routing ──────────────────────────────────────
// Matches `\w+\.GET(...)` etc. (gin and echo share this shape).
// Captures the receiver, the HTTP method (field name), and the path literal
// — anchored as the FIRST argument so the code can pick the handler out of
// the remaining arguments. Which argument that is depends on the framework:
// gin is `GET(path, middleware..., handler)` (last), echo is
// `GET(path, handler, middleware...)` (first) — see readFrameworkImports and
// the per-call choice in scan below.
// The handler must be an identifier, an inline func literal, or a method
// value / package-qualified function (`h.ListUsers`, `handlers.ListUsers`);
// anything else there means the call cannot be attributed to a symbol, so it
// is dropped rather than guessed (variadic-middleware over-match, #2276).
const FRAMEWORK_ROUTE_PATTERNS = compilePatterns({
  name: 'go-framework-route',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (_) @receiver
            field: (field_identifier) @http_method (#match? @http_method "^(GET|POST|PUT|DELETE|PATCH)$"))
          arguments: (argument_list
            .
            (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

/** Argument forms a route handler may take. */
const HANDLER_ARG_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'func_literal',
  'selector_expression',
]);

/**
 * The file's framework import aliases: which local qualifiers resolve to
 * echo and to gin. Matched on the import path rather than the local name, so
 * an aliased import still counts; an unaliased import is keyed by its
 * conventional package name (`goImportPackageName`). `_` and `.` imports bind
 * no qualifier this file can route through. An empty set means the file
 * proves nothing about that framework. Echo's verb calls take the handler as
 * the FIRST argument after the path (`GET(path, handler, middleware...)`),
 * gin's as the LAST (`GET(path, middleware..., handler)`) — `scan` picks the
 * rule per call from these sets.
 */
function readFrameworkImports(root: Parser.SyntaxNode): {
  echo: Set<string>;
  gin: Set<string>;
} {
  // Imports sit only at file scope; skip bodies.
  const specs = root.namedChildren
    .filter((node) => node.type === 'import_declaration')
    .flatMap((decl) => decl.descendantsOfType('import_spec'));
  const echo = new Set<string>();
  const gin = new Set<string>();
  for (const spec of specs) {
    const importPath = stringLiteral(spec.childForFieldName('path'));
    if (importPath === null) continue;
    const local = spec.childForFieldName('name')?.text ?? goImportPackageName(importPath);
    if (local === '_' || local === '.') continue;
    if (importPath.includes('labstack/echo')) echo.add(local);
    else if (importPath.includes('gin-gonic/gin')) gin.add(local);
  }
  return { echo, gin };
}

// ─── Route groups: `v1 := r.Group("/api/v1")` ─────────────────────────
// gin (`*gin.RouterGroup`) and echo (`*echo.Group`) routes registered on a
// group inherit every enclosing `Group(prefix)`. The prefix is recovered by
// walking the route's receiver back through its bindings, lexically, inside
// the enclosing function declaration only: a group handed to another
// function (`registerAdmin(v1)`) arrives as a parameter and contributes no
// prefix there, and a receiver bound to anything but a literal-prefix
// `Group(...)` call contributes none either — the route keeps its literal path.
// Statement-scoped bindings count too: an `if`/`switch` initializer, a `for`
// clause (including `range`), a type-switch guard, and declarations inside a
// switch case all scope over their statement the same way Go scopes them, so
// they shadow an outer group of the same name instead of being skipped. A
// select case's receive binding (`case g := <-ch:`) stops the walk entirely:
// what arrives from the channel is statically unknown, so the route keeps its
// literal path rather than inheriting an outer group.

const MAX_GROUP_DEPTH = 32;

function joinRoutePath(prefix: string, relative: string): string {
  let joined = relative;
  if (prefix && relative) {
    joined = `${prefix.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
  } else if (prefix) {
    joined = prefix;
  }
  // Collapse duplicate slashes on the FINAL result — every return branch, not
  // just the join — because ingestion's normalizeExtractedRoutePath collapses
  // all "//" while the downstream contract-id normalizer does not: a path
  // that keeps "//" would split into two contract ids across the strategies.
  const collapsed = joined.replace(/\/+/g, '/');
  // Force a leading "/" for the same reason: ingestion's
  // normalizeExtractedRoutePath always adds one, while normalizeHttpPath (the
  // shared contract-id normalizer) does not — a literal "x" or a slashless
  // Group("api") prefix would emit `...::x` here and `...::/x` there. Gin
  // also refuses a registration path that does not start with "/".
  return collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
}

/** `parent.Group("/p", mw...)` → its receiver and literal prefix; null otherwise. */
function asGroupCall(
  node: Parser.SyntaxNode,
): { parent: Parser.SyntaxNode; prefix: string } | null {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'selector_expression' || fn.childForFieldName('field')?.text !== 'Group') {
    return null;
  }
  const parent = fn.childForFieldName('operand');
  const first = node.childForFieldName('arguments')?.namedChildren[0];
  // Only a string literal carries a prefix, and it must decode to the text
  // the runtime registers: stringLiteral applies Go unescaping (both `"…"`
  // with escapes and raw `` `…` `` strings). A non-literal argument (a
  // variable, concatenation) or an undecodable string contributes no prefix.
  const prefix = first ? stringLiteral(first) : null;
  if (!parent || prefix === null) return null;
  return { parent, prefix };
}

/** The expression `name` is assigned by `stmt` (`:=`, `=`, or `var`), if any. */
function boundValue(stmt: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null | undefined {
  const pick = (
    names: Parser.SyntaxNode[],
    values: Parser.SyntaxNode | null,
  ): Parser.SyntaxNode | null | undefined => {
    const i = names.findIndex((n) => n.type === 'identifier' && n.text === name);
    if (i < 0) return undefined;
    return values?.namedChildren[i] ?? null;
  };
  switch (stmt.type) {
    case 'short_var_declaration':
    case 'assignment_statement':
      return pick(
        stmt.childForFieldName('left')?.namedChildren ?? [],
        stmt.childForFieldName('right'),
      );
    case 'var_declaration': {
      const specs = stmt.namedChildren.flatMap((c) =>
        c.type === 'var_spec_list' ? c.namedChildren : [c],
      );
      for (const spec of specs) {
        if (spec.type !== 'var_spec') continue;
        const value = pick(spec.childrenForFieldName('name'), spec.childForFieldName('value'));
        if (value !== undefined) return value;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Whether an identifier or expression_list (e.g. a range left side) declares `name`. */
function declaresName(node: Parser.SyntaxNode | null, name: string): boolean {
  if (!node) return false;
  if (node.type === 'identifier') return node.text === name;
  return node.namedChildren.some((n) => n.type === 'identifier' && n.text === name);
}

/**
 * The value last bound to identifier `ident` before its use: the nearest
 * binding site in the enclosing scopes, walking outward — preceding statements
 * in blocks and switch/select cases (`expression_case`/`type_case`/
 * `communication_case`/`default_case` act as statement containers), then
 * statement-scoped bindings (`if`/`switch` initializers, `for` clauses
 * including `range`, type-switch guards), up to the enclosing function
 * declaration. Returns null when the name is a parameter, is bound without a
 * value, is received from a channel by a select case head (the received value
 * is statically unknown, so the walk stops instead of escaping to an outer
 * group), or is not bound in scope.
 */
function findBinding(ident: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const name = ident.text;
  let child: Parser.SyntaxNode = ident;
  for (let node = ident.parent; node; child = node, node = node.parent) {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') return null;
    if (node.type === 'func_literal') {
      const params = node.childForFieldName('parameters')?.descendantsOfType('identifier') ?? [];
      if (params.some((p) => p.text === name)) return null;
      continue;
    }
    if (
      node.type === 'block' ||
      node.type === 'expression_case' ||
      node.type === 'type_case' ||
      node.type === 'communication_case' ||
      node.type === 'default_case'
    ) {
      // A select case head can rebind the name (`case g := <-ch:` or
      // `case g = <-ch:`); the received value is statically unknown, so the
      // walk must STOP with no traceable value — the same decline the
      // ingestion-side route bindings record (value null) — instead of
      // escaping to an outer group of the same name.
      if (node.type === 'communication_case') {
        for (const head of node.children) {
          if (
            head.type === 'receive_statement' &&
            declaresName(head.childForFieldName('left'), name)
          ) {
            return null;
          }
        }
      }
      const stmts = node.namedChildren;
      const useIndex = stmts.findIndex((s) => s.id === child.id);
      for (const stmt of stmts.slice(0, useIndex).reverse()) {
        const value = boundValue(stmt, name);
        if (value !== undefined) return value;
      }
      continue;
    }
    // Statement-scoped bindings enclose the use the same way Go scopes them.
    if (node.type === 'if_statement' || node.type === 'expression_switch_statement') {
      const init = node.childForFieldName('initializer');
      if (init) {
        const value = boundValue(init, name);
        if (value !== undefined) return value;
      }
      continue;
    }
    if (node.type === 'for_statement') {
      const clause = node.namedChildren[0];
      if (clause?.type === 'for_clause') {
        // Only the initializer runs before the body: `condition` and
        // `update` (`g = r.Group("/post")` in the post slot) evaluate after
        // it, so they must not shadow what the body sees on entry. An absent
        // initializer (`for ; c; i++`) binds nothing.
        const init = clause.childForFieldName('initializer');
        if (init) {
          const value = boundValue(init, name);
          if (value !== undefined) return value;
        }
      } else if (clause?.type === 'range_clause') {
        if (declaresName(clause.childForFieldName('left'), name)) {
          return clause.childForFieldName('right') ?? null;
        }
      }
      continue;
    }
    if (node.type === 'type_switch_statement') {
      // `switch g := x.(type)` — the guard list is the `alias` field, which
      // only the `:=` form has (bare `switch x.(type)` parses with none),
      // matching how the ingestion-side route-bindings read it. The switched
      // value is the operand right after the guard list.
      const guard = node.childForFieldName('alias');
      if (guard?.type === 'expression_list' && declaresName(guard, name)) {
        return node.namedChildren[1] ?? null;
      }
      continue;
    }
  }
  return null;
}

/**
 * Whether a mixed-import file's route receiver traces back to echo's
 * constructor — `e := echo.New()` / `echo.Default()` with `echo` resolving to
 * one of the file's verified echo import aliases — either directly or through
 * enclosing `Group(...)` calls (`users := api.Group(…)` ← `api := e.Group(…)`
 * ← `echo.New()`), the normal shape of grouped routes (review #7, #10).
 * Provenance must still END at a constructor: parameters, unrelated packages'
 * `New()`, a local that shadows the echo import name, and anything else return
 * false so the caller keeps the conservative last-argument fallback instead of
 * guessing. Returns null when the Group chain exceeds MAX_GROUP_DEPTH: the
 * framework is then unprovable either way, so the caller declines the route.
 */
function receiverBindsToEchoConstructor(
  receiver: Parser.SyntaxNode,
  echoAliases: ReadonlySet<string>,
  depth = 0,
): boolean | null {
  if (depth > MAX_GROUP_DEPTH) return null;
  // An identifier resolves through its binding; a chained `X.Group(…).Group(…)`
  // operand is already a call and is inspected as-is.
  const value = receiver.type === 'identifier' ? findBinding(receiver) : receiver;
  if (value?.type !== 'call_expression') return false;
  const fn = value.childForFieldName('function');
  if (fn?.type !== 'selector_expression') return false;
  const field = fn.childForFieldName('field')?.text;
  const operand = fn.childForFieldName('operand');
  if (!operand) return false;
  if (field === 'New' || field === 'Default') {
    return operand.type === 'identifier' && echoAliases.has(operand.text) && !isLocalName(operand);
  }
  if (field === 'Group') {
    return receiverBindsToEchoConstructor(operand, echoAliases, depth + 1);
  }
  return false;
}

/**
 * Whether `ident` names a local value rather than an imported package: a
 * binding in scope or a parameter/receiver of an enclosing function. Go lets
 * either shadow a package qualifier (`func f(echo *Factory) { echo.New() }`).
 */
function isLocalName(ident: Parser.SyntaxNode): boolean {
  if (findBinding(ident) !== null) return true;
  for (let node = ident.parent; node; node = node.parent) {
    if (
      node.type !== 'func_literal' &&
      node.type !== 'function_declaration' &&
      node.type !== 'method_declaration'
    ) {
      continue;
    }
    const lists = [node.childForFieldName('parameters'), node.childForFieldName('receiver')];
    for (const list of lists) {
      if (list?.descendantsOfType('identifier').some((p) => p.text === ident.text)) return true;
    }
    if (node.type !== 'func_literal') return false;
  }
  return false;
}

/**
 * Joined `Group(...)` prefix of a route receiver; '' when it cannot be traced.
 * Returns null when the chain exceeds MAX_GROUP_DEPTH: a partial prefix would
 * silently drop the inner groups, so the caller declines the route instead.
 */
function groupPrefix(receiver: Parser.SyntaxNode, depth = 0): string | null {
  if (depth > MAX_GROUP_DEPTH) return null;
  const value = receiver.type === 'identifier' ? findBinding(receiver) : receiver;
  const group = value ? asGroupCall(value) : null;
  if (!group) return '';
  const outer = groupPrefix(group.parent, depth + 1);
  return outer === null ? null : joinRoutePath(outer, group.prefix);
}

// ─── Provider: net/http `http.HandleFunc("/p", handler)` ─────────────
const HANDLE_FUNC_PATTERNS = compilePatterns({
  name: 'go-handle-func',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#eq? @fn "HandleFunc"))
          arguments: (argument_list
            (interpreted_string_literal) @path
            [(identifier) (func_literal)] @handler
            .))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: net/http stdlib Get / Post / Head ─────────────────────
const HTTP_CLIENT_METHOD_TO_HTTP: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Head: 'GET', // HEAD has no body semantics we care about — treat as GET for contract matching
};

const HTTP_CLIENT_PATTERNS = compilePatterns({
  name: 'go-http-client',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#match? @fn "^(Get|Post|Head)$"))
          arguments: (argument_list . (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: net/http `http.NewRequest("METHOD", "/path", ...)` ────
const NEW_REQUEST_PATTERNS = compilePatterns({
  name: 'go-new-request',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#eq? @fn "NewRequest"))
          arguments: (argument_list
            .
            (interpreted_string_literal) @http_method
            (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: resty `client.R().Delete("/path")` ─────────────────────
// Matches any chained call whose receiver is `something.R()` and whose
// method name is an HTTP verb. This is how go-resty's fluent API looks.
const RESTY_PATTERNS = compilePatterns({
  name: 'go-resty',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (call_expression
              function: (selector_expression
                field: (field_identifier) @r (#eq? @r "R")))
            field: (field_identifier) @http_method (#match? @http_method "^(Get|Post|Put|Delete|Patch)$"))
          arguments: (argument_list . (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const GO_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'go-http',
  language: Go,
  scan(tree) {
    const out: HttpDetection[] = [];

    // Framework providers: r.GET/POST/... on an engine or (nested) route group
    const imports = readFrameworkImports(tree.rootNode);
    const echoOnly = imports.echo.size > 0 && imports.gin.size === 0;
    const mixed = imports.echo.size > 0 && imports.gin.size > 0;
    for (const match of runCompiledPatterns(FRAMEWORK_ROUTE_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      const receiverNode = match.captures.receiver;
      if (!methodNode || !pathNode) continue;
      const literalPath = stringLiteral(pathNode);
      if (literalPath === null) continue;
      const argList = pathNode.parent;
      if (argList?.type !== 'argument_list') continue;
      // The path is anchored first, so everything after it is a handler or
      // middleware candidate: echo's verb calls take the FIRST of those, gin's
      // the LAST (see FRAMEWORK_ROUTE_PATTERNS / readFrameworkImports). The
      // rule is chosen per call: an echo-only file is unambiguous; a
      // mixed-import file takes the first argument only when the receiver
      // provably traces to echo's constructor (directly or through enclosing
      // Group() calls) — everything else keeps the last-argument anchor,
      // gin's order and the safer default when the file proves nothing.
      const rest = argList.namedChildren.slice(1);
      if (rest.length === 0) continue;
      const echoOrder = mixed
        ? receiverNode
          ? receiverBindsToEchoConstructor(receiverNode, imports.echo)
          : false
        : echoOnly;
      // A Group chain deeper than MAX_GROUP_DEPTH proves neither the full
      // prefix nor the framework order: decline rather than emit a guess.
      if (echoOrder === null) continue;
      const prefix = receiverNode ? groupPrefix(receiverNode) : '';
      if (prefix === null) continue;
      const handlerNode = echoOrder ? rest[0] : rest[rest.length - 1];
      if (!HANDLER_ARG_TYPES.has(handlerNode.type)) continue;
      const path = receiverNode ? joinRoutePath(prefix, literalPath) : literalPath;
      // An inline `func(){…}` handler has no name → emit `name: null` and a
      // `line` so it resolves to its containing/closure symbol by line-span
      // containment (like a consumer). A named handler keeps its name and
      // resolves by name; `line` is harmless there. For a method value or a
      // package-qualified function (`h.List`, `pkg.List`) that name is the
      // field: the group layer resolves handlers by name alone, and the
      // operand is usually a local variable rather than the receiver type.
      const isInlineHandler = handlerNode?.type === 'func_literal';
      const handlerName =
        handlerNode?.type === 'selector_expression'
          ? (handlerNode.childForFieldName('field')?.text ?? null)
          : (handlerNode?.text ?? null);
      out.push({
        role: 'provider',
        framework: 'go-framework',
        method: methodNode.text.toUpperCase(),
        path,
        name: isInlineHandler ? null : handlerName,
        line: (handlerNode ?? pathNode).startPosition.row + 1,
        confidence: 0.8,
      });
    }

    // net/http HandleFunc: default method GET
    for (const match of runCompiledPatterns(HANDLE_FUNC_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      const handlerNode = match.captures.handler;
      if (!pathNode) continue;
      const path = stringLiteral(pathNode);
      if (path === null) continue;
      // Inline `func(){…}` handler → resolve by containment (see go-framework
      // note above); a named handler resolves by name.
      const isInlineHandler = handlerNode?.type === 'func_literal';
      out.push({
        role: 'provider',
        framework: 'go-stdlib',
        method: 'GET',
        path,
        name: isInlineHandler ? null : (handlerNode?.text ?? null),
        line: (handlerNode ?? pathNode).startPosition.row + 1,
        confidence: 0.8,
      });
    }

    // net/http client: http.Get/Post/Head
    for (const match of runCompiledPatterns(HTTP_CLIENT_PATTERNS, tree)) {
      const fnNode = match.captures.fn;
      const pathNode = match.captures.path;
      if (!fnNode || !pathNode) continue;
      const httpMethod = HTTP_CLIENT_METHOD_TO_HTTP[fnNode.text];
      if (!httpMethod) continue;
      const path = stringLiteral(pathNode);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-stdlib',
        method: httpMethod,
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // net/http NewRequest
    for (const match of runCompiledPatterns(NEW_REQUEST_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const method = stringLiteral(methodNode);
      const path = stringLiteral(pathNode);
      if (method === null || path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-stdlib',
        method: method.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // resty
    for (const match of runCompiledPatterns(RESTY_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = stringLiteral(pathNode);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-resty',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    return out;
  },
};
