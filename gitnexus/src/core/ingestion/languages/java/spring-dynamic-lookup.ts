import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringDynamicLookupMetadataAttacher,
  springDynamicLookupCardinality,
  type SpringDynamicLookupFact,
} from '../../frameworks/spring/dynamic-lookups.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getJavaSpringDynamicLookupFacts } from './capture-side-channel.js';

const CALLABLE_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

function enclosingCallable(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (CALLABLE_NODE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function classLiteralTypeName(argument: SyntaxNode): string | null {
  if (argument.type !== 'class_literal' || argument.namedChildCount !== 1) return null;
  return argument.namedChild(0)?.text.trim() ?? null;
}

/** Capture real Java method invocations; comments and literals are never visited as calls. */
export function captureJavaSpringDynamicLookupFacts(
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
    if (node.type !== 'method_invocation') continue;

    const receiverName = node.childForFieldName('object')?.text.trim();
    const methodName = node.childForFieldName('name')?.text.trim();
    const argumentsNode = node.childForFieldName('arguments');
    if (receiverName === undefined || methodName === undefined || argumentsNode === null) continue;
    if (springDynamicLookupCardinality(receiverName, methodName) === null) continue;

    const argumentsWithoutComments = argumentsNode.namedChildren.filter(
      (child) => child.type !== 'line_comment' && child.type !== 'block_comment',
    );
    if (argumentsWithoutComments.length !== 1) continue;
    const argument = argumentsWithoutComments[0];
    if (argument === undefined) continue;
    const targetTypeName = classLiteralTypeName(argument);
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
      receiverName,
      methodName,
      targetTypeName,
    });
  }
  return facts;
}

/** Attach Java lookup facts for later resolution by the shared DI phase. */
export const attachJavaSpringDynamicLookup = createSpringDynamicLookupMetadataAttacher({
  getFacts: getJavaSpringDynamicLookupFacts,
});
