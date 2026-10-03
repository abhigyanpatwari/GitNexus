import type Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
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
// `GET(path, handler, middleware...)` (first) — see importsEchoOnly below.
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
 * Whether the file's imports say it routes with echo and not gin: echo
 * verb calls take the handler as the FIRST argument after the path
 * (`GET(path, handler, middleware...)`), gin's as the LAST
 * (`GET(path, middleware..., handler)`). Matched on the import path rather
 * than the local name, so an aliased import still counts. Both frameworks
 * or neither → not echo-only → callers keep the last-argument anchor, which
 * is gin's order and the safer default when the file proves nothing.
 */
function importsEchoOnly(root: Parser.SyntaxNode): boolean {
  // Imports sit only at file scope; skip bodies.
  const specs = root.namedChildren
    .filter((node) => node.type === 'import_declaration')
    .flatMap((decl) => decl.descendantsOfType('import_spec'));
  let echo = false;
  let gin = false;
  for (const spec of specs) {
    const importPath = stringLiteral(spec.childForFieldName('path'));
    if (importPath === null) continue;
    // `_` and `.` imports bind no qualifier this file can route through.
    const local = spec.childForFieldName('name')?.text;
    if (local === '_' || local === '.') continue;
    if (importPath.includes('labstack/echo')) echo = true;
    else if (importPath.includes('gin-gonic/gin')) gin = true;
  }
  return echo && !gin;
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
// they shadow an outer group of the same name instead of being skipped.

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
  return joined.replace(/\/+/g, '/');
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
 * in blocks and switch cases (`expression_case`/`type_case` act as statement
 * containers), then statement-scoped bindings (`if`/`switch` initializers,
 * `for` clauses including `range`, type-switch guards), up to the enclosing
 * function declaration. Returns null when the name is a parameter, is bound
 * without a value, or is not bound in scope.
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
    if (node.type === 'block' || node.type === 'expression_case' || node.type === 'type_case') {
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
      // `switch v := x.(type)` — the guard list is the first named child and
      // only present when a `:=` follows it (bare `switch x.(type)` has none).
      const guard = node.namedChildren[0];
      if (guard?.type === 'expression_list' && node.children.some((c) => c.type === ':=')) {
        if (declaresName(guard, name)) return node.namedChildren[1] ?? null;
      }
      continue;
    }
  }
  return null;
}

/** Joined `Group(...)` prefix of a route receiver; '' when it cannot be traced. */
function groupPrefix(receiver: Parser.SyntaxNode, depth = 0): string {
  if (depth > MAX_GROUP_DEPTH) return '';
  const value = receiver.type === 'identifier' ? findBinding(receiver) : receiver;
  const group = value ? asGroupCall(value) : null;
  if (!group) return '';
  return joinRoutePath(groupPrefix(group.parent, depth + 1), group.prefix);
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
    const echoOnly = importsEchoOnly(tree.rootNode);
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
      // middleware candidate: an echo-only file takes the first of those,
      // any other file the last (see FRAMEWORK_ROUTE_PATTERNS / importsEchoOnly).
      const rest = argList.namedChildren.slice(1);
      if (rest.length === 0) continue;
      const handlerNode = echoOnly ? rest[0] : rest[rest.length - 1];
      if (!HANDLER_ARG_TYPES.has(handlerNode.type)) continue;
      const path = receiverNode
        ? joinRoutePath(groupPrefix(receiverNode), literalPath)
        : literalPath;
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
