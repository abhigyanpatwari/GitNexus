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
import { getKotlinSpringDynamicLookupFacts } from './capture-side-channel.js';

// Kotlin emits graph callables for functions and secondary constructors.
// `init {}` / primary-constructor bodies have no independent callable node, so
// attributing their lookups to the enclosing Class would violate graph semantics.
const CALLABLE_NODE_TYPES = new Set(['function_declaration', 'secondary_constructor']);
const NO_CALLABLE_BOUNDARIES = new Set<string>();
const KOTLIN_CLASS_LITERAL =
  /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)::class(?:\.java)?$/;

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
    (child) => child.type !== 'line_comment' && child.type !== 'multiline_comment',
  );
  if (argumentsWithoutComments.length !== 1) return null;
  const value = argumentsWithoutComments[0];
  if (value?.type !== 'value_argument' || value.namedChildCount !== 1) return null;
  return value.namedChild(0)?.text.trim().match(KOTLIN_CLASS_LITERAL)?.[1] ?? null;
}

/** Capture real Kotlin calls using `Type::class` or `Type::class.java`. */
export function captureKotlinSpringDynamicLookupFact(
  node: SyntaxNode,
  filePath: string,
): SpringDynamicLookupFact | null {
  if (node.type !== 'call_expression') return null;
  const callee = node.namedChildren.find((child) => child.type === 'navigation_expression');
  if (callee === undefined) return null;
  const parts = navigationParts(callee);
  if (parts === null) return null;
  if (springDynamicLookupCardinality(parts.receiverName, parts.methodName) === null) return null;
  const targetTypeName = singleClassLiteralArgument(node);
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
    receiverName: parts.receiverName,
    methodName: parts.methodName,
    targetTypeName,
  };
}

/** Standalone extractor for focused tests; production reuses scope-query call nodes. */
export function captureKotlinSpringDynamicLookupFacts(
  rootNode: SyntaxNode,
  filePath: string,
): SpringDynamicLookupFact[] {
  return rootNode
    .descendantsOfType('call_expression')
    .map((node) => captureKotlinSpringDynamicLookupFact(node, filePath))
    .filter((fact): fact is SpringDynamicLookupFact => fact !== null);
}

/** Attach Kotlin lookup facts for later resolution by the shared DI phase. */
export const attachKotlinSpringDynamicLookup = createSpringDynamicLookupMetadataAttacher({
  getFacts: getKotlinSpringDynamicLookupFacts,
});
