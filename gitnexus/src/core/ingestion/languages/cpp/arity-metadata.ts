import type { SyntaxNode } from '../../utils/ast-helpers.js';

export interface CppArityInfo {
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
}

/**
 * Compute declaration arity from a C++ function definition or declaration node.
 * Extends the C arity computation with support for:
 *   - optional_parameter_declaration (default parameters)
 *   - variadic_parameter_declaration / parameter packs
 *   - (void) explicit zero-parameter form
 */
export function computeCppDeclarationArity(node: SyntaxNode): CppArityInfo {
  const funcDecl = findFuncDeclarator(node);
  if (funcDecl === null) return {};

  const paramList = funcDecl.childForFieldName('parameters');
  if (paramList === null) return {};

  const params: SyntaxNode[] = [];
  // Track whether a C-style variadic `...` anonymous token appears.
  // tree-sitter-cpp emits `...` as an anonymous (non-named) child of
  // parameter_list, not as `variadic_parameter`.
  let hasEllipsis = false;
  for (let i = 0; i < paramList.childCount; i++) {
    const child = paramList.child(i);
    if (child === null) continue;
    if (
      child.type === 'parameter_declaration' ||
      child.type === 'optional_parameter_declaration' ||
      child.type === 'variadic_parameter' ||
      child.type === 'variadic_parameter_declaration'
    ) {
      params.push(child);
    } else if (child.type === '...' || (!child.isNamed && child.text === '...')) {
      hasEllipsis = true;
    }
  }

  // Empty parameter list: C++ `void foo()` means zero params (unlike C)
  if (params.length === 0 && !hasEllipsis) {
    return { parameterCount: 0, requiredParameterCount: 0, parameterTypes: [] };
  }

  // (void) means zero parameters
  if (params.length === 1 && params[0].type === 'parameter_declaration') {
    const typeNode = params[0].childForFieldName('type');
    const hasDeclarator = params[0].childForFieldName('declarator') !== null;
    if (typeNode !== null && typeNode.text === 'void' && !hasDeclarator) {
      return { parameterCount: 0, requiredParameterCount: 0, parameterTypes: [] };
    }
  }

  // C-style variadic: `void foo(int x, ...)` — the `...` is an anonymous
  // token in tree-sitter-cpp, detected via `hasEllipsis` above.
  // C++ parameter packs: `template<typename... Ts> void foo(Ts... args)` —
  // detected as `variadic_parameter_declaration`.
  const isVariadic =
    hasEllipsis ||
    params.some(
      (p) => p.type === 'variadic_parameter' || p.type === 'variadic_parameter_declaration',
    );
  const optionalCount = params.filter((p) => p.type === 'optional_parameter_declaration').length;
  const requiredCount = params.filter(
    (p) =>
      p.type === 'parameter_declaration' ||
      // variadic_parameter_declaration with a name is a parameter pack — counts as one
      p.type === 'variadic_parameter_declaration',
  ).length;
  const totalNonVariadic = requiredCount + optionalCount;

  const types: string[] = [];
  for (const p of params) {
    if (p.type === 'variadic_parameter') {
      types.push('...');
    } else if (p.type === 'variadic_parameter_declaration') {
      // Parameter pack: treated as variadic
      types.push('...');
    } else {
      const typeNode = p.childForFieldName('type');
      types.push(normalizeCppParamType(typeNode?.text ?? 'unknown'));
    }
  }
  // Append '...' for C-style variadic if not already in types
  if (hasEllipsis && !types.includes('...')) {
    types.push('...');
  }

  return {
    parameterCount: isVariadic ? undefined : totalNonVariadic,
    requiredParameterCount: requiredCount,
    parameterTypes: types,
  };
}

/**
 * Compute call-site arity from a call_expression node.
 */
export function computeCppCallArity(node: SyntaxNode): number {
  const argList = node.childForFieldName('arguments');
  if (argList === null) return 0;

  let count = 0;
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    if (child.type !== ',' && child.type !== '(' && child.type !== ')') {
      count++;
    }
  }
  return count;
}

/**
 * Normalize a C++ parameter type for overload disambiguation.
 * Maps common qualified/aliased types to their canonical short forms
 * so that `narrowOverloadCandidates` can match against literal-inferred
 * argument types (e.g. `inferCppLiteralType` returns `'string'` for
 * string literals, not `'std::string'`).
 */
function normalizeCppParamType(raw: string): string {
  let t = raw.trim();
  // Strip const, volatile, etc.
  t = t.replace(/\b(const|volatile|restrict|mutable|constexpr)\b/g, '').trim();
  // Strip reference/pointer markers
  t = t.replace(/[&*]+\s*$/, '').trim();
  // Strip template parameters (loop handles nested: Map<List<int>> → Map)
  while (t.includes('<')) {
    const stripped = t.replace(/<[^<>]*>/g, '');
    if (stripped === t) break; // avoid infinite loop on malformed input
    t = stripped;
  }
  t = t.trim();
  // Map std:: types to canonical short forms
  const STD_MAP: Record<string, string> = {
    'std::string': 'string',
    'std::wstring': 'string',
    'std::string_view': 'string',
    string: 'string',
    char: 'char',
    int: 'int',
    long: 'int',
    short: 'int',
    unsigned: 'int',
    'unsigned int': 'int',
    'long long': 'int',
    size_t: 'int',
    'std::size_t': 'int',
    float: 'double',
    double: 'double',
    bool: 'bool',
    nullptr_t: 'null',
    'std::nullptr_t': 'null',
  };
  return STD_MAP[t] ?? t;
}

function findFuncDeclarator(node: SyntaxNode): SyntaxNode | null {
  let decl = node.childForFieldName('declarator');
  if (decl === null) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_declarator') return c;
    }
    return null;
  }
  // Unwrap pointer_declarator / reference_declarator
  while (decl.type === 'pointer_declarator' || decl.type === 'reference_declarator') {
    const next = decl.childForFieldName('declarator');
    if (next === null) {
      // reference_declarator may not use field name
      for (let i = 0; i < decl.childCount; i++) {
        const c = decl.child(i);
        if (c?.type === 'function_declarator') return c;
      }
      break;
    }
    decl = next;
  }
  if (decl.type === 'function_declarator') return decl;
  return null;
}
