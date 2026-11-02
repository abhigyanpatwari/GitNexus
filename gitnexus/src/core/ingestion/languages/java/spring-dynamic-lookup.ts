import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringDynamicLookupMetadataAttacher,
  springDynamicLookupCardinality,
  type SpringDynamicLookupFact,
} from '../../frameworks/spring/dynamic-lookups.js';
import {
  findAncestorBeforeBoundary,
  nodeToCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getJavaSpringDynamicLookupFacts } from './capture-side-channel.js';

const CALLABLE_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);
const NO_CALLABLE_BOUNDARIES = new Set<string>();

function classLiteralTypeName(argument: SyntaxNode): string | null {
  if (argument.type !== 'class_literal' || argument.namedChildCount !== 1) return null;
  return argument.namedChild(0)?.text.trim() ?? null;
}

/** Capture real Java method invocations; comments and literals are never visited as calls. */
export function captureJavaSpringDynamicLookupFact(
  node: SyntaxNode,
  filePath: string,
): SpringDynamicLookupFact | null {
  if (node.type !== 'method_invocation') return null;
  const receiverName = node.childForFieldName('object')?.text.trim();
  const methodName = node.childForFieldName('name')?.text.trim();
  const argumentsNode = node.childForFieldName('arguments');
  if (receiverName === undefined || methodName === undefined || argumentsNode === null) return null;
  if (springDynamicLookupCardinality(receiverName, methodName) === null) return null;

  const argumentsWithoutComments = argumentsNode.namedChildren.filter(
    (child) => child.type !== 'line_comment' && child.type !== 'block_comment',
  );
  if (argumentsWithoutComments.length !== 1) return null;
  const argument = argumentsWithoutComments[0];
  if (argument === undefined) return null;
  const targetTypeName = classLiteralTypeName(argument);
  if (targetTypeName === null) return null;

  const owner = findAncestorBeforeBoundary(node, CALLABLE_NODE_TYPES, NO_CALLABLE_BOUNDARIES);
  if (owner === null) return null;
  const ownerCapture = nodeToCapture('@spring-dynamic-lookup.owner', owner);
  return {
    ownerScopeId: makeScopeId({
      filePath,
      range: ownerCapture.range,
      kind: 'Function',
    }),
    ownerRange: ownerCapture.range,
    receiverName,
    methodName,
    targetTypeName,
  };
}

/** Standalone extractor for focused tests; production reuses scope-query call nodes. */
export function captureJavaSpringDynamicLookupFacts(
  rootNode: SyntaxNode,
  filePath: string,
): SpringDynamicLookupFact[] {
  return rootNode
    .descendantsOfType('method_invocation')
    .map((node) => captureJavaSpringDynamicLookupFact(node, filePath))
    .filter((fact): fact is SpringDynamicLookupFact => fact !== null);
}

/** Attach Java lookup facts for later resolution by the shared DI phase. */
export const attachJavaSpringDynamicLookup = createSpringDynamicLookupMetadataAttacher({
  getFacts: getJavaSpringDynamicLookupFacts,
});
