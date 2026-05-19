/**
 * Extract C++ template constraint expressions for SFINAE-aware overload
 * narrowing (issue #1579). Recognizes 3 AST shapes:
 *
 *   F1 — unqualified non-type template param default:
 *        `template<class T, enable_if_t<P, int> = 0> void f(T);`
 *   F2 — `std::`-qualified variant (canonical ticket form):
 *        `template<class T, std::enable_if_t<P, int> = 0> void f(T);`
 *   F4 — C++20 leading requires-clause:
 *        `template<class T> requires P void f(T);`
 *
 * Deferred (return `{kind:'unknown'}`):
 *   F3 — void-default `typename = enable_if_t<P>` (cppref labels this
 *        `/* WRONG *\/` because adjacent overloads collapse to redeclarations)
 *   F5 — trailing requires (`void f(T) requires P;`)
 *   `requires_expression` blocks (`requires { typename T::U; }`)
 *   `decltype(...)`, fold-expressions, user-defined `_v` aliases.
 *
 * The output payload is opaque to shared code — only
 * `constraint-filter.ts` consumes it. See ISO `[temp.constr.normal]` /
 * `<https://en.cppreference.com/w/cpp/language/constraints>` for the
 * normalization the Kleene 3-valued evaluator implements.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';

export type ConstraintExpr =
  | { readonly kind: 'atomic'; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: 'and'; readonly children: readonly ConstraintExpr[] }
  | { readonly kind: 'or'; readonly children: readonly ConstraintExpr[] }
  | { readonly kind: 'not'; readonly child: ConstraintExpr }
  | { readonly kind: 'unknown' };

export interface CppConstraintPayload {
  /** Ordered template parameter names (type-params only — non-type defaults
   *  carrying enable_if predicates are folded into `expr`). */
  readonly templateParams: readonly string[];
  /**
   * Mapping from each template parameter name to the call-site argument
   * index where its deduced type lives. Computed by scanning the function's
   * parameter list for the first parameter whose type is the bare template
   * parameter name (or template-typed by it). Missing entries → 'unknown'
   * verdict at evaluation time.
   */
  readonly paramArgIndex: { readonly [paramName: string]: number };
  /** Root constraint expression. When multiple constraints (multiple
   *  enable_if defaults, requires clause, etc.) are present they are
   *  implicitly conjoined under a top-level `and` node. */
  readonly expr: ConstraintExpr;
}

/**
 * Walk a `template_declaration` AST node and extract its constraint
 * payload. Caller is responsible for passing the OUTER `template_declaration`
 * — for class-member template functions, that means the enclosing
 * template_declaration of the class OR of the method, whichever
 * directly precedes the function definition.
 *
 * Returns `undefined` when the template_declaration declares no
 * constraints worth tracking (no enable_if default, no requires clause).
 * Returns a payload whose `expr.kind === 'unknown'` when constraints are
 * present but the extractor cannot model them — monotonicity guarantees
 * the filter keeps the candidate in that case.
 */
export function extractCppTemplateConstraints(
  templateDecl: SyntaxNode,
  funcDeclarator: SyntaxNode | null,
): CppConstraintPayload | undefined {
  const paramList = childOfType(templateDecl, 'template_parameter_list');
  if (paramList === null) return undefined;

  const templateParams: string[] = [];
  const exprs: ConstraintExpr[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (param === null) continue;
    if (
      param.type === 'type_parameter_declaration' ||
      param.type === 'optional_type_parameter_declaration' ||
      param.type === 'variadic_type_parameter_declaration'
    ) {
      const id = firstDescendantOfType(param, 'type_identifier');
      if (id !== null) templateParams.push(id.text);
      continue;
    }
    // Non-type parameter — F1 / F2 default-value carries the enable_if
    // predicate. Shape: `optional_parameter_declaration` with field
    // `default_value`, whose value is a `template_type` named
    // `enable_if_t` (F1) or a qualified version (F2).
    if (param.type === 'optional_parameter_declaration') {
      const defaultVal = param.childForFieldName('default_value');
      const typeNode = param.childForFieldName('type');
      const candidate = extractEnableIfPredicate(typeNode);
      if (candidate !== undefined) {
        exprs.push(candidate);
      } else if (defaultVal !== null) {
        // Default-value-as-predicate not yet supported. Bail conservatively.
        exprs.push({ kind: 'unknown' });
      }
    }
  }

  // F4 — C++20 leading `requires` clause. Tree-sitter-cpp exposes it as a
  // `requires_clause` child of `template_declaration` (sibling of the
  // template_parameter_list).
  const requiresClause = childOfType(templateDecl, 'requires_clause');
  if (requiresClause !== null) {
    const parsed = parseRequiresClause(requiresClause);
    if (parsed !== undefined) exprs.push(parsed);
  }

  if (templateParams.length === 0 && exprs.length === 0) return undefined;

  const paramArgIndex = buildParamArgIndex(templateParams, funcDeclarator);
  const expr: ConstraintExpr =
    exprs.length === 0
      ? { kind: 'unknown' }
      : exprs.length === 1
        ? exprs[0]
        : { kind: 'and', children: exprs };

  return { templateParams, paramArgIndex, expr };
}

/**
 * Inspect a non-type template parameter's declared type to see whether
 * it's `enable_if_t<P, T>` (F1) or `std::enable_if_t<P, T>` (F2). When
 * matched, extract the predicate `P` and return it as a `ConstraintExpr`.
 *
 * Returns undefined when the parameter's type is not enable_if (so the
 * caller can decide whether to bail or ignore).
 */
function extractEnableIfPredicate(typeNode: SyntaxNode | null): ConstraintExpr | undefined {
  if (typeNode === null) return undefined;
  // Unwrap a type_descriptor wrapper (when present).
  let t: SyntaxNode | null = typeNode;
  if (t.type === 'type_descriptor') {
    t = t.childForFieldName('type') ?? firstDescendantOfType(t, 'template_type');
  }
  // F2 shape: tree-sitter-cpp models `std::enable_if_t<...>` as
  // `qualified_identifier` whose `name` field is the `template_type`.
  // F1 shape (unqualified `enable_if_t<...>`) is `template_type` directly.
  if (t !== null && t.type === 'qualified_identifier') {
    const inner = t.childForFieldName('name') ?? firstDescendantOfType(t, 'template_type');
    if (inner !== null && inner.type === 'template_type') {
      t = inner;
    }
  }
  if (t === null || t.type !== 'template_type') return undefined;

  const nameNode = t.childForFieldName('name');
  if (nameNode === null) return undefined;
  const tail = stripQualifiedPrefix(nameNode.text);
  if (tail !== 'enable_if_t' && tail !== 'enable_if') return undefined;

  // Predicate is the first template argument of enable_if_t.
  const argList = t.childForFieldName('arguments') ?? childOfType(t, 'template_argument_list');
  if (argList === null) return { kind: 'unknown' };
  for (let i = 0; i < argList.namedChildCount; i++) {
    const arg = argList.namedChild(i);
    if (arg === null) continue;
    if (arg.type !== 'type_descriptor') continue;
    const inner = arg.childForFieldName('type') ?? arg.namedChild(0);
    if (inner === null) continue;
    return parseAtomicOrBoolean(inner);
  }
  return { kind: 'unknown' };
}

/** Parse a requires-clause body. The body is a binary or unary expression
 *  over atomic predicates (variable templates like `is_integral_v<T>`). */
function parseRequiresClause(requiresClause: SyntaxNode): ConstraintExpr | undefined {
  // tree-sitter-cpp exposes the expression as a named child or via a
  // `constraint` field. Probe both.
  let expr: SyntaxNode | null = requiresClause.childForFieldName('constraint');
  if (expr === null) {
    for (let i = 0; i < requiresClause.namedChildCount; i++) {
      const c = requiresClause.namedChild(i);
      if (c === null) continue;
      // Skip the `requires` keyword token.
      if (c.type === 'requires') continue;
      expr = c;
      break;
    }
  }
  if (expr === null) return undefined;
  return parseAtomicOrBoolean(expr);
}

/**
 * Recursively parse a constraint sub-expression. Recognizes:
 *   - `template_type` / `template_function` named `<predicate>_v` → atomic
 *   - binary_expression with `&&` / `||` → conjunction / disjunction
 *   - unary_expression with `!` → negation
 *   - parenthesized_expression → unwrap
 *   - anything else → `{kind:'unknown'}` (monotonicity-safe)
 *
 * `requires_expression` blocks intentionally fall through to 'unknown'
 * — they need substitution semantics we don't model in V1.
 */
function parseAtomicOrBoolean(node: SyntaxNode): ConstraintExpr {
  // Unwrap parentheses.
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner === null ? { kind: 'unknown' } : parseAtomicOrBoolean(inner);
  }
  // Boolean composition.
  if (node.type === 'binary_expression') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const opNode = node.childForFieldName('operator');
    if (left !== null && right !== null && opNode !== null) {
      const op = opNode.text;
      const l = parseAtomicOrBoolean(left);
      const r = parseAtomicOrBoolean(right);
      if (op === '&&') return { kind: 'and', children: [l, r] };
      if (op === '||') return { kind: 'or', children: [l, r] };
    }
    return { kind: 'unknown' };
  }
  if (node.type === 'unary_expression') {
    const opNode = node.childForFieldName('operator') ?? node.namedChild(0);
    const arg = node.childForFieldName('argument') ?? node.namedChild(1) ?? node.namedChild(0);
    if (opNode !== null && opNode.text === '!' && arg !== null && arg !== opNode) {
      return { kind: 'not', child: parseAtomicOrBoolean(arg) };
    }
    return { kind: 'unknown' };
  }
  // Atomic predicate — `template_type` is the typical shape for variable
  // templates like `is_integral_v<T>`. Some grammar variants surface it as
  // `template_function` or via a `qualified_identifier` wrapper.
  if (node.type === 'template_type' || node.type === 'template_function') {
    return parseAtomicTemplate(node);
  }
  if (node.type === 'qualified_identifier') {
    // `std::is_integral_v<T>` shape (without template_type wrapping).
    const inner = node.childForFieldName('name');
    if (inner !== null && (inner.type === 'template_type' || inner.type === 'template_function')) {
      return parseAtomicTemplate(inner);
    }
    return { kind: 'unknown' };
  }
  // `requires { typename T::U; }` blocks and decltype: out of V1 scope.
  return { kind: 'unknown' };
}

function parseAtomicTemplate(t: SyntaxNode): ConstraintExpr {
  const nameNode = t.childForFieldName('name');
  if (nameNode === null) return { kind: 'unknown' };
  const name = stripQualifiedPrefix(nameNode.text);
  const argList = t.childForFieldName('arguments') ?? childOfType(t, 'template_argument_list');
  const args: string[] = [];
  if (argList !== null) {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const arg = argList.namedChild(i);
      if (arg === null) continue;
      if (arg.type !== 'type_descriptor') continue;
      const inner = arg.childForFieldName('type') ?? arg.namedChild(0);
      if (inner === null) continue;
      // For Tier-A predicates the args are bare template-parameter names
      // (`T`, `U`). Anything more elaborate is bailed via 'unknown' at the
      // top level if needed; here we just record the textual identifier.
      const id =
        inner.type === 'type_identifier' ? inner : firstDescendantOfType(inner, 'type_identifier');
      args.push(id !== null ? id.text : inner.text);
    }
  }
  return { kind: 'atomic', name, args };
}

/** Build a `paramName → call-site argument index` map by scanning the
 *  function's parameter list for parameters typed by each template param. */
function buildParamArgIndex(
  templateParams: readonly string[],
  funcDeclarator: SyntaxNode | null,
): { [paramName: string]: number } {
  const out: { [paramName: string]: number } = {};
  if (funcDeclarator === null || templateParams.length === 0) return out;
  const paramList = funcDeclarator.childForFieldName('parameters');
  if (paramList === null) return out;

  let argIdx = 0;
  for (let i = 0; i < paramList.childCount; i++) {
    const p = paramList.child(i);
    if (p === null) continue;
    if (
      p.type !== 'parameter_declaration' &&
      p.type !== 'optional_parameter_declaration' &&
      p.type !== 'variadic_parameter_declaration'
    ) {
      continue;
    }
    const typeNode = p.childForFieldName('type');
    if (typeNode !== null) {
      const tname = bareTypeIdentifier(typeNode);
      if (tname !== null && templateParams.includes(tname) && !(tname in out)) {
        out[tname] = argIdx;
      }
    }
    argIdx++;
  }
  return out;
}

function bareTypeIdentifier(typeNode: SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  // Allow `T const`, `T&`, `T*` shapes — the inner type_identifier still wins.
  const id = firstDescendantOfType(typeNode, 'type_identifier');
  return id !== null ? id.text : null;
}

function stripQualifiedPrefix(text: string): string {
  const idx = text.lastIndexOf('::');
  return idx >= 0 ? text.slice(idx + 2) : text;
}

function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && c.type === type) return c;
  }
  return null;
}

function firstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const hit = firstDescendantOfType(c, type);
    if (hit !== null) return hit;
  }
  return null;
}
