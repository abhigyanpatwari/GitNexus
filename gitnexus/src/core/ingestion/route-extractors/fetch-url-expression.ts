import type Parser from 'tree-sitter';
import type { ForwardedCallee } from './fetch-wrapper.js';

type Node = Parser.SyntaxNode;

/** Serializable string operations; no source code is evaluated. */
export type FetchUrlExpression =
  | string
  | { kind: 'parameter' }
  | { kind: 'concat'; parts: FetchUrlExpression[] }
  | { kind: 'call'; callee: ForwardedCallee; argument: FetchUrlExpression }
  | {
      kind: 'leading-slash';
      value: FetchUrlExpression;
      consequence: FetchUrlExpression;
      alternative: FetchUrlExpression;
    };

export interface FetchUrlArgument {
  callee: ForwardedCallee;
  argument: FetchUrlExpression;
  fetch: boolean;
}

/** Follow only stable lexical bindings and supported string syntax. */
export function readFetchUrlExpression(
  expression: Node | null | undefined,
  parameter: string | undefined,
  binding: (node: Node) => string | undefined,
  valueOf: (binding: string) => Node | undefined,
  targetOf: (node: Node | null) => ForwardedCallee | undefined,
  mayBeBase: (node: Node) => boolean,
): FetchUrlExpression | undefined {
  const active = new Set<string>();
  let remaining = 256;
  const read = (node: Node | null | undefined, depth = 0): FetchUrlExpression | undefined => {
    if (!node || depth > 32 || --remaining < 0) return undefined;
    const next = (child: Node | null | undefined) => read(child, depth + 1);
    if (
      [
        'parenthesized_expression',
        'as_expression',
        'satisfies_expression',
        'non_null_expression',
      ].includes(node.type)
    )
      return next(node.namedChildren.find((child) => child.type !== 'comment'));
    if (node.type === 'identifier') {
      const id = binding(node);
      if (!id) return undefined;
      if (id === parameter) return { kind: 'parameter' };
      if (active.has(id)) return undefined;
      active.add(id);
      const result = next(valueOf(id));
      active.delete(id);
      return result;
    }
    // Escapes require runtime decoding; do not mistake their source spelling for a path.
    if (node.type === 'string')
      return node.text.includes('\\') ? undefined : node.text.slice(1, -1);
    if (node.type === 'binary_expression') {
      if (node.childForFieldName('operator')?.text !== '+') return undefined;
      const left = next(node.childForFieldName('left'));
      const right = next(node.childForFieldName('right'));
      return left === undefined || right === undefined
        ? undefined
        : { kind: 'concat', parts: [left, right] };
    }
    if (node.type === 'template_string') {
      const parts: FetchUrlExpression[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'string_fragment') parts.push(child.text);
        else if (child.type === 'template_substitution') {
          const inner = child.namedChildren.find((item) => item.type !== 'comment');
          const value = next(inner);
          if (value !== undefined) parts.push(value);
          // Preserve the existing leading base-URL convention. An unknown
          // interpolation anywhere after the base cannot prove a static URL.
          else if (parts.length === 0 && inner && mayBeBase(inner)) parts.push('${base}');
          else return undefined;
        } else if (child.type !== 'comment') return undefined;
      }
      return { kind: 'concat', parts };
    }
    if (node.type === 'call_expression') {
      const callee = targetOf(node.childForFieldName('function'));
      const argument = next(
        node
          .childForFieldName('arguments')
          ?.namedChildren.find((child) => child.type !== 'comment'),
      );
      return callee && argument !== undefined ? { kind: 'call', callee, argument } : undefined;
    }
    if (node.type === 'ternary_expression') {
      const condition = node.childForFieldName('condition');
      const callee = condition?.childForFieldName('function');
      const args = condition
        ?.childForFieldName('arguments')
        ?.namedChildren.filter((child) => child.type !== 'comment');
      if (
        condition?.type !== 'call_expression' ||
        callee?.type !== 'member_expression' ||
        callee.childForFieldName('property')?.text !== 'startsWith' ||
        args?.length !== 1 ||
        next(args[0]) !== '/'
      )
        return undefined;
      const value = next(callee.childForFieldName('object'));
      const consequence = next(node.childForFieldName('consequence'));
      const alternative = next(node.childForFieldName('alternative'));
      return value === undefined || consequence === undefined || alternative === undefined
        ? undefined
        : { kind: 'leading-slash', value, consequence, alternative };
    }
    return undefined;
  };
  return read(expression);
}

/** Substitute a caller's URL, resolving only a proven URL-building function. */
export function evaluateFetchUrlExpression(
  expression: FetchUrlExpression,
  parameter: string,
  returned: (callee: ForwardedCallee, argument: string) => string | undefined,
  depth = 0,
): string | undefined {
  if (depth > 32) return undefined;
  if (typeof expression === 'string') return expression;
  const evaluate = (value: FetchUrlExpression) =>
    evaluateFetchUrlExpression(value, parameter, returned, depth + 1);
  if (expression.kind === 'parameter') return parameter;
  if (expression.kind === 'call') {
    const argument = evaluate(expression.argument);
    return argument === undefined ? undefined : returned(expression.callee, argument);
  }
  if (expression.kind === 'leading-slash') {
    const value = evaluate(expression.value);
    return value === undefined || value.startsWith('${')
      ? undefined
      : evaluate(value.startsWith('/') ? expression.consequence : expression.alternative);
  }
  let result = '';
  for (const part of expression.parts) {
    const value = evaluate(part);
    if (value === undefined || result.length + value.length > 8192) return undefined;
    result += value;
  }
  return result;
}
