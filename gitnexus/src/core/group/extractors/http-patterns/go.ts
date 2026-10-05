import type Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { goImportPackageName } from '../../../ingestion/languages/go/import-package-name.js';
import {
  isEchoImportPath,
  isGinImportPath,
  stringLiteral,
} from '../../../ingestion/route-extractors/go-shared.js';
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
// (either Go string form; stringLiteral decodes both, as ingestion does). The
// query does not anchor the path with `.`: tree-sitter counts comments as
// named children, so `GET(/* c */ "/p", h)` would fail the anchor. scan instead
// requires the path to be the first argument in code (comments skipped) and
// picks the handler out of the remaining code arguments. Which argument that is depends on the framework:
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
            [(interpreted_string_literal) (raw_string_literal)] @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

/** Named children that are code, not comments (tree-sitter names comments). */
function codeChildren(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode[] {
  return node ? node.namedChildren.filter((c) => c.type !== 'comment') : [];
}

/** Argument forms a route handler may take. */
const HANDLER_ARG_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'func_literal',
  'selector_expression',
]);

/**
 * The file's framework import aliases: which local qualifiers resolve to
 * echo and to gin. Matched on the EXACT import path (shared with ingestion via
 * go-shared.ts) rather than the local name, so
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
    if (isEchoImportPath(importPath)) echo.add(local);
    else if (isGinImportPath(importPath)) gin.add(local);
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
  const first = codeChildren(node.childForFieldName('arguments'))[0];
  // Only a string literal carries a prefix, and it must decode to the text
  // the runtime registers: stringLiteral applies Go unescaping (both `"…"`
  // with escapes and raw `` `…` `` strings). A non-literal argument (a
  // variable, concatenation) or an undecodable string contributes no prefix.
  const prefix = first ? stringLiteral(first) : null;
  if (!parent || prefix === null) return null;
  return { parent, prefix };
}

/** The `var_spec`s of a `var_declaration`, flattened out of a grouped `var (…)`. */
function varSpecs(decl: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return decl.namedChildren
    .flatMap((c) => (c.type === 'var_spec_list' ? c.namedChildren : [c]))
    .filter((spec) => spec.type === 'var_spec');
}

/** The expression `name` is assigned by `stmt` (`:=`, `=`, or `var`), if any. */
function boundValue(stmt: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null | undefined {
  const pick = (
    names: Parser.SyntaxNode[],
    values: Parser.SyntaxNode | null,
  ): Parser.SyntaxNode | null | undefined => {
    // Go carries an assignment out left to right, so a repeated target leaves
    // the LAST one in place (`g, g = a, b` ends with g == b).
    let i = -1;
    for (let k = 0; k < names.length; k++) {
      if (names[k].type === 'identifier' && names[k].text === name) i = k;
    }
    if (i < 0) return undefined;
    return codeChildren(values)[i] ?? null;
  };
  switch (stmt.type) {
    case 'short_var_declaration':
    case 'assignment_statement':
      return pick(codeChildren(stmt.childForFieldName('left')), stmt.childForFieldName('right'));
    case 'var_spec':
      return pick(stmt.childrenForFieldName('name'), stmt.childForFieldName('value'));
    case 'var_declaration': {
      for (const spec of varSpecs(stmt)) {
        const value = pick(spec.childrenForFieldName('name'), spec.childForFieldName('value'));
        if (value !== undefined) return value;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A binding whose value cannot be established statically: an earlier
 * statement writes the name inside a nested scope (`{ g = r.Group("/new") }`,
 * a branch or loop body), so which value reaches the use depends on control
 * flow. Callers decline the route instead of picking the older binding.
 */
const CONFLICT = Symbol('conflicting-binding');
/** The name is a parameter (or method receiver): its declaration carries a static type. */
interface ParamBinding {
  param: Parser.SyntaxNode;
}
type Binding = Parser.SyntaxNode | null | undefined | typeof CONFLICT | ParamBinding;

function isParamBinding(b: Binding): b is ParamBinding {
  return typeof b === 'object' && b !== null && 'param' in b;
}

/** The parameter_declaration of `fn` (parameters or method receiver) declaring `name`. */
function paramDeclaring(fn: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const list of [fn.childForFieldName('parameters'), fn.childForFieldName('receiver')]) {
    for (const decl of codeChildren(list)) {
      if (decl.type !== 'parameter_declaration' && decl.type !== 'variadic_parameter_declaration') {
        continue;
      }
      if (decl.childrenForFieldName('name').some((n) => n.text === name)) return decl;
    }
  }
  return null;
}

/** Whether `inner` lies within `outer`'s source span. */
function within(outer: Parser.SyntaxNode | null, inner: Parser.SyntaxNode): boolean {
  return !!outer && outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * Whether `stmt` writes `name` with a plain assignment somewhere inside it
 * (`g = …` in a nested block, branch, loop, or closure body). The `=` forms of
 * a range clause (`for _, g = range xs`) and a select receive
 * (`case g = <-ch`) write the existing name too, but tree-sitter parses them
 * as `range_clause` / `receive_statement`, not `assignment_statement`. A
 * nested `:=` declares a new variable — loop- or case-local — and is not a
 * write to the outer one.
 */
function writesNameInside(stmt: Parser.SyntaxNode, name: string): boolean {
  if (
    [stmt, ...stmt.descendantsOfType('assignment_statement')].some(
      (a) => a.type === 'assignment_statement' && declaresName(a.childForFieldName('left'), name),
    )
  ) {
    return true;
  }
  return [
    ...stmt.descendantsOfType('range_clause'),
    ...stmt.descendantsOfType('receive_statement'),
  ].some((w) => assignsExistingName(w) && declaresName(w.childForFieldName('left'), name));
}

/** A range clause or receive that assigns (`=`) rather than declares (`:=`). */
function assignsExistingName(clause: Parser.SyntaxNode): boolean {
  return !clause.children.some((c) => c.type === ':=');
}

/**
 * Whether the initializer of the declaration that brings `name` into scope in
 * a block writes the OUTER `name`. The right-hand side runs before the new
 * variable exists, so `g := func(){ g = … }()` still writes the binding the
 * use outside the block would inherit. Grouped `var` specs up to and including
 * the declaring one are scanned; later specs read the new local.
 */
function initializerWritesName(decl: Parser.SyntaxNode, name: string): boolean {
  if (decl.type === 'short_var_declaration') {
    const values = decl.childForFieldName('right');
    return !!values && writesNameInside(values, name);
  }
  if (decl.type === 'var_declaration') {
    for (const spec of varSpecs(decl)) {
      const value = spec.childForFieldName('value');
      if (value && writesNameInside(value, name)) return true;
      if (boundValue(spec, name) !== undefined) return false;
    }
  }
  return false;
}

/**
 * Whether `stmt` holds a function literal that writes `name`. Such a literal
 * can run after any later direct assignment (`reset := func(){ g = … };
 * g = …; reset()`), so captured writes are found independently of statement
 * order instead of being lost behind the last-assignment return.
 */
function closureWritesName(stmt: Parser.SyntaxNode, name: string): boolean {
  const literals =
    stmt.type === 'func_literal'
      ? [stmt, ...stmt.descendantsOfType('func_literal')]
      : stmt.descendantsOfType('func_literal');
  return literals.some((fn) => writesNameInside(fn, name));
}

/**
 * The effect a bare `{ … }` block placed before the use has on the outer
 * `name`. A bare block always runs, so its last top-level `name = v` is the
 * value that reaches the use (`{ g = r.Group("/new") }` → `/new`); a write
 * nested in a branch, loop, or closure inside it is CONFLICT. A `:=` or `var`
 * of `name` in the block starts a new variable, so only the statements before
 * it touch the outer one — but the declaring statement's initializer still
 * does, because it evaluates before the new variable is in scope. undefined
 * when the block leaves `name` alone.
 */
function bareBlockWrite(block: Parser.SyntaxNode, name: string): Binding {
  const stmts = codeChildren(block);
  const declIndex = stmts.findIndex(
    (s) =>
      (s.type === 'short_var_declaration' || s.type === 'var_declaration') &&
      boundValue(s, name) !== undefined,
  );
  const outerRegion = declIndex < 0 ? stmts : stmts.slice(0, declIndex);
  if (declIndex >= 0 && initializerWritesName(stmts[declIndex], name)) return CONFLICT;
  if (outerRegion.some((stmt) => closureWritesName(stmt, name))) return CONFLICT;
  for (const stmt of outerRegion.reverse()) {
    if (stmt.type === 'assignment_statement') {
      const value = boundValue(stmt, name);
      if (value !== undefined) return value;
    }
    if (stmt.type === 'block') {
      const inner = bareBlockWrite(stmt, name);
      if (inner !== undefined) return inner;
      continue;
    }
    if (writesNameInside(stmt, name)) return CONFLICT;
  }
  return undefined;
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
function findBinding(ident: Parser.SyntaxNode): Parser.SyntaxNode | null | typeof CONFLICT {
  const binding = lookupBinding(ident);
  return isParamBinding(binding) ? null : (binding ?? null);
}

/**
 * findBinding's walk, keeping "declared without a traceable value" (null: a
 * `func` literal parameter, `var x T`, a select receive) apart from "not
 * declared before reaching the enclosing function declaration" (undefined).
 * CONFLICT means a preceding statement writes the name in a nested scope, so
 * the value at the use is control-flow dependent. A parameter or method
 * receiver of the enclosing function returns its declaration (ParamBinding):
 * no value, but a static type.
 */
function lookupBinding(ident: Parser.SyntaxNode): Binding {
  const name = ident.text;
  let child: Parser.SyntaxNode = ident;
  for (let node = ident.parent; node; child = node, node = node.parent) {
    if (
      node.type === 'function_declaration' ||
      node.type === 'method_declaration' ||
      node.type === 'func_literal'
    ) {
      const param = paramDeclaring(node, name);
      if (param) return { param };
      if (node.type === 'func_literal') continue;
      return undefined;
    }
    // Inside a grouped `var ( a = …; b = a.Group(…) )`, the specs before the
    // one holding the use are already in scope; the current and later specs
    // are not (`var g = g.Group(…)` reads the outer g).
    if (node.type === 'var_spec_list') {
      const specs = codeChildren(node);
      const useIndex = specs.findIndex((s) => s.id === child.id);
      for (const spec of specs.slice(0, useIndex).reverse()) {
        const value = boundValue(spec, name);
        if (value !== undefined) return value;
      }
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
      const stmts = codeChildren(node);
      const useIndex = stmts.findIndex((s) => s.id === child.id);
      for (const stmt of stmts.slice(0, useIndex).reverse()) {
        const value = boundValue(stmt, name);
        if (value !== undefined) return value;
        // A bare block always runs: its unconditional writes are bindings.
        if (stmt.type === 'block') {
          const written = bareBlockWrite(stmt, name);
          if (written !== undefined) return written;
          continue;
        }
        // A write nested in an earlier branch, loop, or closure may or may
        // not run before the use: the reaching value is unprovable.
        if (writesNameInside(stmt, name)) return CONFLICT;
      }
      continue;
    }
    // Statement-scoped bindings enclose the use the same way Go scopes them.
    if (node.type === 'if_statement' || node.type === 'expression_switch_statement') {
      // A use inside the initializer itself (`if g := g.Group(…); …`) reads
      // the OUTER binding: the new one only scopes over what follows it.
      const init = node.childForFieldName('initializer');
      if (init && !within(init, ident)) {
        const value = boundValue(init, name);
        if (value !== undefined) return value;
      }
      continue;
    }
    if (node.type === 'for_statement') {
      const clause = codeChildren(node)[0];
      // A write in the loop's post statement, condition, or body runs between
      // iterations, so from the second pass on the body sees that value
      // instead of the one it entered with (`for ; c; g = r.Group("/post")`):
      // the prefix is control-flow dependent, so decline it.
      if (within(node.childForFieldName('body'), ident)) {
        const loopParts = [
          node.childForFieldName('body'),
          clause?.type === 'for_clause' ? clause.childForFieldName('update') : null,
          clause?.type === 'for_clause' ? clause.childForFieldName('condition') : null,
        ];
        if (loopParts.some((part) => part && writesNameInside(part, name))) return CONFLICT;
      }
      if (clause?.type === 'for_clause') {
        // Only the initializer binds before the body; an absent initializer
        // (`for ; c; i++`) binds nothing.
        const init = clause.childForFieldName('initializer');
        if (init && !within(init, ident)) {
          const value = boundValue(init, name);
          if (value !== undefined) return value;
        }
      } else if (clause?.type === 'range_clause') {
        if (
          declaresName(clause.childForFieldName('left'), name) &&
          !within(clause.childForFieldName('right'), ident)
        ) {
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
      const switched = codeChildren(node)[1] ?? null;
      if (
        guard?.type === 'expression_list' &&
        declaresName(guard, name) &&
        !within(switched, ident)
      ) {
        return switched;
      }
      continue;
    }
  }
  return undefined;
}

/**
 * Whether a mixed-import file's route receiver traces back to echo's
 * constructor — `e := echo.New()` / `echo.Default()` with `echo` resolving to
 * one of the file's verified echo import aliases — either directly or through
 * enclosing `Group(...)` calls (`users := api.Group(…)` ← `api := e.Group(…)`
 * ← `echo.New()`), the normal shape of grouped routes (review #7, #10).
 * A parameter or method receiver counts by its declared type instead:
 * `e *echo.Echo` / `g *echo.Group` (with `echo` one of those aliases) proves
 * echo; any other type — gin's, or one the file cannot tie to echo — does not.
 * Unrelated packages' `New()`, a local that shadows the echo import name, and
 * anything else return false so the caller keeps the conservative
 * last-argument fallback instead of guessing. Returns null when the Group chain exceeds MAX_GROUP_DEPTH or a
 * binding on it is control-flow dependent (CONFLICT): the framework is then
 * unprovable either way, so the caller declines the route.
 */
function receiverBindsToEchoConstructor(
  receiver: Parser.SyntaxNode,
  echoAliases: ReadonlySet<string>,
  depth = 0,
): boolean | null {
  if (depth > MAX_GROUP_DEPTH) return null;
  // An identifier resolves through its binding; a chained `X.Group(…).Group(…)`
  // operand is already a call and is inspected as-is.
  const value = receiver.type === 'identifier' ? lookupBinding(receiver) : receiver;
  if (value === CONFLICT) return null;
  if (isParamBinding(value))
    return isEchoRouterType(value.param.childForFieldName('type'), echoAliases);
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

/** `*echo.Echo` / `echo.Echo` / `*echo.Group` with `echo` a verified echo import alias. */
function isEchoRouterType(
  type: Parser.SyntaxNode | null,
  echoAliases: ReadonlySet<string>,
): boolean {
  const named = type?.type === 'pointer_type' ? codeChildren(type)[0] : type;
  if (named?.type !== 'qualified_type') return false;
  const pkg = named.childForFieldName('package')?.text;
  const typeName = named.childForFieldName('name')?.text;
  return !!pkg && echoAliases.has(pkg) && (typeName === 'Echo' || typeName === 'Group');
}

/**
 * Whether `ident` names a local value rather than an imported package: a
 * declaration in scope (with or without a value — `var echo Factory` shadows
 * too) or a parameter/receiver of an enclosing function. Go lets either
 * shadow a package qualifier (`func f(echo *Factory) { echo.New() }`).
 */
function isLocalName(ident: Parser.SyntaxNode): boolean {
  // lookupBinding covers parameters and receivers too (ParamBinding).
  return lookupBinding(ident) !== undefined;
}

/**
 * Joined `Group(...)` prefix of a route receiver; '' when it cannot be traced.
 * Returns null when the chain exceeds MAX_GROUP_DEPTH, or when a binding on it
 * is control-flow dependent (CONFLICT): a partial or stale prefix would emit
 * a wrong path, so the caller declines the route instead.
 */
function groupPrefix(receiver: Parser.SyntaxNode, depth = 0): string | null {
  if (depth > MAX_GROUP_DEPTH) return null;
  const value = receiver.type === 'identifier' ? findBinding(receiver) : receiver;
  if (value === CONFLICT) return null;
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
    // Handler names declared more than once in this file (`(h *A) List` and
    // `(o *B) List`): the emitted name is field-only, so these must resolve
    // only when unique in the file instead of taking the first same-named row.
    const declaredNames = new Map<string, number>();
    for (const decl of tree.rootNode.descendantsOfType([
      'function_declaration',
      'method_declaration',
    ])) {
      const declName = decl.childForFieldName('name')?.text;
      if (declName) declaredNames.set(declName, (declaredNames.get(declName) ?? 0) + 1);
    }
    for (const match of runCompiledPatterns(FRAMEWORK_ROUTE_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      const receiverNode = match.captures.receiver;
      if (!methodNode || !pathNode) continue;
      const literalPath = stringLiteral(pathNode);
      if (literalPath === null) continue;
      const argList = pathNode.parent;
      if (argList?.type !== 'argument_list') continue;
      const args = codeChildren(argList);
      if (args[0]?.id !== pathNode.id) continue;
      // The path is the first code argument, so everything after it is a handler or
      // middleware candidate: echo's verb calls take the FIRST of those, gin's
      // the LAST (see FRAMEWORK_ROUTE_PATTERNS / readFrameworkImports). The
      // rule is chosen per call: an echo-only file is unambiguous; a
      // mixed-import file takes the first argument only when the receiver
      // provably traces to echo's constructor (directly or through enclosing
      // Group() calls) — everything else keeps the last-argument anchor,
      // gin's order and the safer default when the file proves nothing.
      const rest = args.slice(1);
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
      // field, and the operand (usually a local variable, not the receiver
      // type) does not prove where `List` is declared — so the detection is
      // marked qualifiedHandler: resolve only to a repo-wide unique `List`,
      // never to a same-named local method that merely shares the name.
      const isInlineHandler = handlerNode?.type === 'func_literal';
      const isQualified = handlerNode?.type === 'selector_expression';
      const handlerName = isQualified
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
        ...(isQualified ? { qualifiedHandler: true } : {}),
        // A bare name declared more than once in this file (a function and a
        // method of the same name) resolves only when the file holds exactly
        // one match, rather than binding to whichever row the graph lists first.
        ...(!isQualified &&
        !isInlineHandler &&
        handlerName &&
        (declaredNames.get(handlerName) ?? 0) > 1
          ? { strictHandlerResolution: true }
          : {}),
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
