import { makeScopeId } from 'gitnexus-shared';
import type { SpringArgumentFact } from '../../frameworks/spring/argument-facts.js';
import {
  isSpringMessageProducerMethod,
  normalizeSpringProducerReceiverName,
  springMessageProducerTemplateOf,
  type SpringMessageProducerFact,
} from '../../frameworks/spring/message-producers.js';
import {
  findAncestorBeforeBoundary,
  nodeToCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

const CALLABLE_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);
const NO_CALLABLE_BOUNDARIES = new Set<string>();
const COMMENT_NODE_TYPES = new Set(['line_comment', 'block_comment']);

/** Java has no named call arguments, so every argument is captured positionally. */
function javaCallArgumentFacts(argumentList: SyntaxNode): SpringArgumentFact[] {
  return argumentList.namedChildren
    .filter((child) => !COMMENT_NODE_TYPES.has(child.type))
    .map((child) => ({ text: child.text.trim() }));
}

/**
 * Capture one messaging-template publish from a Java call already surfaced by
 * the scope query, without resolving the destination it names.
 *
 * The destination argument may be a literal, a reference to a constant that
 * lives in another file, or a `${...}` placeholder resolved from configuration;
 * all three are recorded as written and left to a later phase.
 */
export function captureJavaSpringMessageProducerFact(
  node: SyntaxNode,
  filePath: string,
): SpringMessageProducerFact | null {
  if (node.type !== 'method_invocation') return null;
  const methodName = node.childForFieldName('name')?.text.trim();
  if (methodName === undefined || !isSpringMessageProducerMethod(methodName)) return null;
  const receiverText = node.childForFieldName('object')?.text;
  if (receiverText === undefined) return null;
  const receiverName = normalizeSpringProducerReceiverName(receiverText);
  const template = springMessageProducerTemplateOf(receiverName, methodName);
  if (template === null) return null;

  const argumentList = node.childForFieldName('arguments');
  const owner = findAncestorBeforeBoundary(node, CALLABLE_NODE_TYPES, NO_CALLABLE_BOUNDARIES);
  if (owner === null) return null;
  const ownerCapture = nodeToCapture('@spring-message-producer.owner', owner);
  return {
    ownerScopeId: makeScopeId({ filePath, range: ownerCapture.range, kind: 'Function' }),
    ownerRange: ownerCapture.range,
    template,
    receiverName,
    methodName,
    ...(argumentList === null ? {} : { args: javaCallArgumentFacts(argumentList) }),
  };
}

/** Standalone extractor for focused tests; production reuses scope-query call nodes. */
export function captureJavaSpringMessageProducerFacts(
  rootNode: SyntaxNode,
  filePath: string,
): SpringMessageProducerFact[] {
  return rootNode
    .descendantsOfType('method_invocation')
    .map((node) => captureJavaSpringMessageProducerFact(node, filePath))
    .filter((fact): fact is SpringMessageProducerFact => fact !== null);
}
