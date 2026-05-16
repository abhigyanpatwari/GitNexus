import type { SyntaxNode } from '../../utils/ast-helpers.js';

export interface CArityInfo {
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
}

/**
 * Compute declaration arity from a C function definition or declaration node.
 */
export function computeCDeclarationArity(node: SyntaxNode): CArityInfo {
  // Find the function_declarator child (may be wrapped in pointer_declarator)
  const funcDecl = findFuncDeclarator(node);
  if (funcDecl === null) return {};

  const paramList = funcDecl.childForFieldName('parameters');
  if (paramList === null) return {};

  const params: SyntaxNode[] = [];
  for (let i = 0; i < paramList.childCount; i++) {
    const child = paramList.child(i);
    if (child === null) continue;
    if (child.type === 'parameter_declaration' || child.type === 'variadic_parameter') {
      params.push(child);
    }
  }

  // K&R old-style declaration: `int foo()` has an empty parameter_list with
  // no parameter_declaration or variadic_parameter children. Per C89/C99,
  // this means the function accepts an unspecified number/types of arguments —
  // NOT zero arguments. Return unknown arity to avoid false 'incompatible'.
  // `int foo(void)` is the explicit zero-parameter form and is handled below.
  if (params.length === 0) return {};

  // (void) means zero parameters
  if (params.length === 1 && params[0].type === 'parameter_declaration') {
    const typeNode = params[0].childForFieldName('type');
    const hasDeclarator = params[0].childForFieldName('declarator') !== null;
    if (typeNode !== null && typeNode.text === 'void' && !hasDeclarator) {
      return { parameterCount: 0, requiredParameterCount: 0, parameterTypes: [] };
    }
  }

  const isVariadic = params.some((p) => p.type === 'variadic_parameter');
  const nonVariadicCount = params.filter((p) => p.type !== 'variadic_parameter').length;

  const types: string[] = [];
  for (const p of params) {
    if (p.type === 'variadic_parameter') {
      types.push('...');
    } else {
      const typeNode = p.childForFieldName('type');
      types.push(typeNode?.text ?? 'unknown');
    }
  }

  return {
    parameterCount: isVariadic ? undefined : nonVariadicCount,
    requiredParameterCount: nonVariadicCount,
    parameterTypes: types,
  };
}

/**
 * Compute call-site arity from a call_expression node.
 */
export function computeCCallArity(node: SyntaxNode): number {
  const argList = node.childForFieldName('arguments');
  if (argList === null) return 0;

  let count = 0;
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    // Skip punctuation (commas, parens)
    if (child.type !== ',' && child.type !== '(' && child.type !== ')') {
      count++;
    }
  }
  return count;
}

function findFuncDeclarator(node: SyntaxNode): SyntaxNode | null {
  // Direct child
  let decl = node.childForFieldName('declarator');
  if (decl === null) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_declarator') return c;
    }
    return null;
  }
  // Unwrap pointer_declarator
  while (decl.type === 'pointer_declarator') {
    const next = decl.childForFieldName('declarator');
    if (next === null) break;
    decl = next;
  }
  if (decl.type === 'function_declarator') return decl;
  return null;
}
