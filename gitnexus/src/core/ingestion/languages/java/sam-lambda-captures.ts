import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** `lambda:<argument>:<argument count>:<parameter>:<lambda arity>`, answered by
 * `javaSamLambdaParameterType` in `sam-lambda-types.ts`. A route ending in
 * `JAVA_SAM_LAMBDA_FALLBACK` stands only where resolution refuted the binding
 * capture also gave that parameter (see `javaCallResultAssignmentApplies`). */
export const JAVA_SAM_LAMBDA_ROUTE = /^lambda:(\d+):(\d+):(\d+):(\d+)(?::fallback)?$/;
export const JAVA_SAM_LAMBDA_FALLBACK = ':fallback';
const COMMENTS = new Set(['line_comment', 'block_comment']);

/** The argument-list child keeps any parentheses around the lambda expression. */
export function javaLambdaArgument(lambda: SyntaxNode): SyntaxNode {
  let argument = lambda;
  while (argument.parent?.type === 'parenthesized_expression') argument = argument.parent;
  return argument;
}

/** The names an implicitly typed lambda declares (`x`, `(x, y)`, `(var x)`);
 * `undefined` for an explicitly typed or empty parameter list. */
function implicitParameterNames(lambda: SyntaxNode): SyntaxNode[] | undefined {
  const parameters = lambda.childForFieldName('parameters');
  if (parameters === null) return undefined;
  if (parameters.type === 'identifier') return [parameters];
  const names: SyntaxNode[] = [];
  for (const parameter of parameters.namedChildren) {
    if (COMMENTS.has(parameter.type)) continue;
    if (parameters.type === 'inferred_parameters' && parameter.type === 'identifier') {
      names.push(parameter);
      continue;
    }
    const name = parameter.childForFieldName('name');
    if (
      parameters.type !== 'formal_parameters' ||
      parameter.type !== 'formal_parameter' ||
      parameter.childForFieldName('type')?.text !== 'var' ||
      parameter.childForFieldName('dimensions') !== null ||
      name?.type !== 'identifier'
    )
      return undefined;
    names.push(name);
  }
  return names.length > 0 && new Set(names.map((name) => name.text)).size === names.length
    ? names
    : undefined;
}

/**
 * One call-result assignment per parameter of an implicitly typed lambda that
 * is a direct argument of a method invocation. The route records the
 * argument's position, the call's argument count and the lambda's arity; the
 * binding is anchored at the parameter, inside the lambda's own scope.
 * `fallback` marks a lambda whose parameters capture already typed from a JDK
 * container reading that resolution may refute.
 */
export function synthesizeJavaSamLambdaCaptures(
  lambda: SyntaxNode,
  fallback = false,
): CaptureMatch[] {
  const argument = javaLambdaArgument(lambda);
  const argumentList = argument.parent;
  const call = argumentList?.parent;
  if (
    argumentList?.type !== 'argument_list' ||
    call?.type !== 'method_invocation' ||
    call.childForFieldName('arguments')?.id !== argumentList.id
  )
    return [];
  const args = argumentList.namedChildren.filter((child) => !COMMENTS.has(child.type));
  const position = args.findIndex((child) => child.id === argument.id);
  const names = implicitParameterNames(lambda);
  if (position < 0 || names === undefined) return [];
  return names.map((name, index) => ({
    '@call-result-assignment.call': nodeToCapture('@call-result-assignment.call', call),
    '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
    '@call-result-assignment.scope': nodeToCapture('@call-result-assignment.scope', name),
    '@call-result-assignment.element': {
      ...nodeToCapture('@call-result-assignment.element', lambda),
      text: `lambda:${position}:${args.length}:${index}:${names.length}${
        fallback ? JAVA_SAM_LAMBDA_FALLBACK : ''
      }`,
    },
  }));
}
