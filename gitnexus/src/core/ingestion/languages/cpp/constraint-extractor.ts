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

export type CppTemplateParamUnwrap =
  | { readonly kind: 'pointer'; readonly depth: number }
  | { readonly kind: 'lvalue-ref' }
  | {
      readonly kind: 'template-arg';
      readonly containerBase: string;
      readonly argIndex: number;
      readonly pointerDepth: number;
    };

export interface CppConstraintPayload {
  /** Ordered template parameter names (type-params only — non-type defaults
   *  carrying enable_if predicates are folded into `expr`). */
  readonly templateParams: readonly string[];
  /**
   * Mapping from each uniquely-deducible template parameter name to the
   * call-site argument index where its deduced type lives. Parameters with
   * zero or multiple occurrences across the function signature are omitted so
   * evaluation yields `'unknown'` (#1896).
   */
  readonly paramArgIndex: { readonly [paramName: string]: number };
  /**
   * Optional per-parameter unwrap instructions for one-level peeled deduction
   * (`T*`, `const T&`, `std::vector<T>`, `std::pair<T, U>`). Omitted when all
   * deduced parameters are bare by-value `T`.
   */
  readonly paramUnwraps?: { readonly [paramName: string]: CppTemplateParamUnwrap };
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

  const { paramArgIndex, paramUnwraps } = buildParamDeductions(templateParams, funcDeclarator);
  const expr: ConstraintExpr =
    exprs.length === 0
      ? { kind: 'unknown' }
      : exprs.length === 1
        ? exprs[0]
        : { kind: 'and', children: exprs };

  return {
    templateParams,
    paramArgIndex,
    ...(Object.keys(paramUnwraps).length > 0 ? { paramUnwraps } : {}),
    expr,
  };
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
  // `constraint` field. On parenthesized `requires (A && B)` the `constraint`
  // field points at the anonymous `'('` token, so require `expr.isNamed`.
  let expr: SyntaxNode | null = requiresClause.childForFieldName('constraint');
  if (expr !== null && !expr.isNamed) expr = null;
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
  if (
    node.type === 'binary_expression' ||
    node.type === 'constraint_conjunction' ||
    node.type === 'constraint_disjunction'
  ) {
    const left = node.childForFieldName('left') ?? node.namedChild(0);
    const right = node.childForFieldName('right') ?? node.namedChild(1);
    const opText =
      node.childForFieldName('operator')?.text ?? findBinaryOperatorToken(node, left, right);
    if (left !== null && right !== null && opText !== null) {
      const l = parseAtomicOrBoolean(left);
      const r = parseAtomicOrBoolean(right);
      if (opText === '&&') return { kind: 'and', children: [l, r] };
      if (opText === '||') return { kind: 'or', children: [l, r] };
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

/**
 * Scan the function's parameter list to record unique one-level deduction
 * paths (`[temp.deduct.call]`, issue #1896):
 *   - bare `T` (by value) -> `paramArgIndex[T] = argIdx`
 *   - `T*` / `const T*`   -> `pointer` unwrap
 *   - `T&` / `const T&`   -> `lvalue-ref` unwrap (forwarding `T&&` stays unknown)
 *   - `C<..., T, ...>`    -> one-level `template-arg` unwrap when `T` is a
 *                            direct undecorated template argument
 *
 * Any template parameter appearing in multiple parameter positions (or
 * multiple times within a single parameter, e.g. `pair<T, T>`) is omitted so
 * evaluation conservatively yields `'unknown'`.
 */
function buildParamDeductions(
  templateParams: readonly string[],
  funcDeclarator: SyntaxNode | null,
): {
  paramArgIndex: { [paramName: string]: number };
  paramUnwraps: { [paramName: string]: CppTemplateParamUnwrap };
} {
  const paramArgIndex: { [paramName: string]: number } = {};
  const paramUnwraps: { [paramName: string]: CppTemplateParamUnwrap } = {};
  if (funcDeclarator === null || templateParams.length === 0) {
    return { paramArgIndex, paramUnwraps };
  }
  const paramList = funcDeclarator.childForFieldName('parameters');
  if (paramList === null) return { paramArgIndex, paramUnwraps };

  const templateSet = new Set(templateParams);
  const occurrences = new Map<string, number>();
  const candidates = new Map<string, { argIdx: number; unwrap?: CppTemplateParamUnwrap }>();

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
      countTemplateParamOccurrences(typeNode, templateSet, occurrences);
      if (p.type !== 'variadic_parameter_declaration') {
        extractOneLevelDeductionsFromParameter(p, typeNode, argIdx, templateSet, candidates);
      }
    }
    argIdx++;
  }

  for (const tname of templateParams) {
    if (occurrences.get(tname) !== 1) continue;
    const cand = candidates.get(tname);
    if (cand === undefined) continue;
    paramArgIndex[tname] = cand.argIdx;
    if (cand.unwrap !== undefined) paramUnwraps[tname] = cand.unwrap;
  }

  return { paramArgIndex, paramUnwraps };
}

function countTemplateParamOccurrences(
  node: SyntaxNode,
  templateSet: ReadonlySet<string>,
  counts: Map<string, number>,
): void {
  if (
    (node.type === 'type_identifier' || node.type === 'identifier') &&
    templateSet.has(node.text)
  ) {
    counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null) countTemplateParamOccurrences(c, templateSet, counts);
  }
}

function extractOneLevelDeductionsFromParameter(
  paramNode: SyntaxNode,
  typeNode: SyntaxNode,
  argIdx: number,
  templateSet: ReadonlySet<string>,
  out: Map<string, { argIdx: number; unwrap?: CppTemplateParamUnwrap }>,
): void {
  const declShape = inspectParameterDeclarator(paramNode);
  if (declShape === null) return;

  // Unwrap namespace-qualified type (`std::vector<T>`) only when the qualifier
  // scope itself contains no template parameter; `typename T::value_type` and
  // `Box<T>::iterator` are ISO `[temp.deduct.type]/5` non-deduced contexts.
  let coreType = typeNode;
  while (coreType.type === 'qualified_identifier') {
    const scope = coreType.childForFieldName('scope');
    if (scope !== null && subtreeContainsTemplateParam(scope, templateSet)) return;
    const name = coreType.childForFieldName('name');
    if (name === null) return;
    coreType = name;
  }

  if (coreType.type === 'type_identifier' && templateSet.has(coreType.text)) {
    const tname = coreType.text;
    if (declShape.pointerDepth > 0) {
      out.set(tname, {
        argIdx,
        unwrap: { kind: 'pointer', depth: declShape.pointerDepth },
      });
      return;
    }
    if (declShape.refKind === 'none') {
      out.set(tname, { argIdx });
      return;
    }
    // Forwarding reference (`T&&` without cv-qualifier) deduces `U&` on lvalues
    // and `U` on rvalues; leave unknown without expression value-category facts.
    if (declShape.refKind === 'rvalue-ref' && !declShape.hasCvQualifier) {
      return;
    }
    out.set(tname, { argIdx, unwrap: { kind: 'lvalue-ref' } });
    return;
  }

  if (coreType.type === 'template_type') {
    const nameNode = coreType.childForFieldName('name');
    const argList =
      coreType.childForFieldName('arguments') ?? childOfType(coreType, 'template_argument_list');
    if (nameNode === null || argList === null) return;
    const containerBase = stripQualifiedPrefix(nameNode.text.trim());
    if (containerBase === '') return;

    let slotIdx = 0;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const argDesc = argList.namedChild(i);
      if (argDesc === null) continue;
      if (argDesc.type === 'type_descriptor') {
        const hasQual = childOfType(argDesc, 'type_qualifier') !== null;
        const hasDeclarator = argDesc.childForFieldName('declarator') !== null;
        const innerType = argDesc.childForFieldName('type');
        if (
          !hasQual &&
          !hasDeclarator &&
          innerType !== null &&
          innerType.type === 'type_identifier' &&
          templateSet.has(innerType.text)
        ) {
          out.set(innerType.text, {
            argIdx,
            unwrap: {
              kind: 'template-arg',
              containerBase,
              argIndex: slotIdx,
              pointerDepth: declShape.pointerDepth,
            },
          });
        }
      }
      slotIdx++;
    }
  }
}

function inspectParameterDeclarator(paramNode: SyntaxNode): {
  pointerDepth: number;
  refKind: 'none' | 'lvalue-ref' | 'rvalue-ref';
  hasCvQualifier: boolean;
} | null {
  let hasCvQualifier = false;
  for (let i = 0; i < paramNode.childCount; i++) {
    const c = paramNode.child(i);
    if (c !== null && c.type === 'type_qualifier') {
      const t = c.text.trim();
      if (t === 'const' || t === 'volatile') hasCvQualifier = true;
    }
  }

  let pointerDepth = 0;
  let refKind: 'none' | 'lvalue-ref' | 'rvalue-ref' = 'none';
  let cur: SyntaxNode | null = paramNode.childForFieldName('declarator');
  let hops = 8;
  while (cur !== null && hops-- > 0) {
    if (cur.type === 'function_declarator' || cur.type === 'array_declarator') return null;
    if (cur.type === 'pointer_declarator' || cur.type === 'abstract_pointer_declarator') {
      pointerDepth++;
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(cur.namedChildCount - 1);
      continue;
    }
    if (cur.type === 'reference_declarator' || cur.type === 'abstract_reference_declarator') {
      refKind = cur.text.trim().startsWith('&&') ? 'rvalue-ref' : 'lvalue-ref';
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(0);
      continue;
    }
    break;
  }
  return { pointerDepth, refKind, hasCvQualifier };
}

function subtreeContainsTemplateParam(node: SyntaxNode, templateSet: ReadonlySet<string>): boolean {
  if (
    (node.type === 'type_identifier' || node.type === 'identifier') &&
    templateSet.has(node.text)
  ) {
    return true;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && subtreeContainsTemplateParam(c, templateSet)) return true;
  }
  return false;
}

function stripQualifiedPrefix(text: string): string {
  const idx = text.lastIndexOf('::');
  return idx >= 0 ? text.slice(idx + 2) : text;
}

function findBinaryOperatorToken(
  node: SyntaxNode,
  left: SyntaxNode | null,
  right: SyntaxNode | null,
): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null || c === left || c === right) continue;
    const t = c.text.trim();
    if (t === '&&' || t === '||') return t;
  }
  return null;
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
