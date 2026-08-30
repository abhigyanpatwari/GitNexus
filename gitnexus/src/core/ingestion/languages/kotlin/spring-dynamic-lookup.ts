import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringDynamicLookupMetadataAttacher,
  springDynamicLookupCardinality,
  type SpringDynamicLookupFact,
} from '../../frameworks/spring/dynamic-lookups.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getKotlinSpringDynamicLookupFacts } from './capture-side-channel.js';

// Kotlin emits graph callables for functions and secondary constructors.
// `init {}` / primary-constructor bodies have no independent callable node, so
// attributing their lookups to the enclosing Class would violate graph semantics.
const CALLABLE_NODE_TYPES = new Set(['function_declaration', 'secondary_constructor']);
const KOTLIN_CLASS_LITERAL =
  /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)::class(?:\.java)?$/;

function enclosingCallable(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (CALLABLE_NODE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function navigationParts(node: SyntaxNode): { receiverName: string; methodName: string } | null {
  if (node.type !== 'navigation_expression') return null;
  const text = node.text.trim();
  const separator = text.lastIndexOf('.');
  if (separator <= 0 || separator === text.length - 1) return null;
  return {
    receiverName: text.slice(0, separator),
    methodName: text.slice(separator + 1),
  };
}

function singleClassLiteralArgument(node: SyntaxNode): string | null {
  const suffix = node.namedChildren.find((child) => child.type === 'call_suffix');
  const argumentsNode = suffix?.namedChildren.find((child) => child.type === 'value_arguments');
  if (argumentsNode === undefined) return null;
  const argumentsWithoutComments = argumentsNode.namedChildren.filter(
    (child) =>
      child.type !== 'line_comment' &&
      child.type !== 'multiline_comment' &&
      child.type !== 'block_comment',
  );
  if (argumentsWithoutComments.length !== 1) return null;
  const value = argumentsWithoutComments[0];
  if (value?.type !== 'value_argument' || value.namedChildCount !== 1) return null;
  return value.namedChild(0)?.text.trim().match(KOTLIN_CLASS_LITERAL)?.[1] ?? null;
}

/** Capture real Kotlin calls using `Type::class` or `Type::class.java`. */
export function captureKotlinSpringDynamicLookupFacts(
  rootNode: SyntaxNode,
  filePath: string,
): SpringDynamicLookupFact[] {
  const facts: SpringDynamicLookupFact[] = [];
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      const child = node.namedChildren[index];
      if (child !== undefined) stack.push(child);
    }
    if (node.type !== 'call_expression') continue;

    const callee = node.namedChildren.find((child) => child.type === 'navigation_expression');
    if (callee === undefined) continue;
    const parts = navigationParts(callee);
    if (parts === null) continue;
    if (springDynamicLookupCardinality(parts.receiverName, parts.methodName) === null) continue;
    const targetTypeName = singleClassLiteralArgument(node);
    if (targetTypeName === null) continue;

    const owner = enclosingCallable(node);
    if (owner === null) continue;
    const ownerCapture = nodeToCapture('@spring-dynamic-lookup.owner', owner);
    facts.push({
      ownerScopeId: makeScopeId({
        filePath,
        range: ownerCapture.range,
        kind: 'Function',
      }),
      ownerRange: ownerCapture.range,
      receiverName: parts.receiverName,
      methodName: parts.methodName,
      targetTypeName,
    });
  }
  return facts;
}

/** Attach Kotlin lookup facts for later resolution by the shared DI phase. */
export const attachKotlinSpringDynamicLookup = createSpringDynamicLookupMetadataAttacher({
  getFacts: getKotlinSpringDynamicLookupFacts,
});
