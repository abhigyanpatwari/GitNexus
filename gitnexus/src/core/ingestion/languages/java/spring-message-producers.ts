import { makeScopeId } from 'gitnexus-shared';
import {
  normalizeSpringFactText,
  type SpringArgumentFact,
} from '../../frameworks/spring/argument-facts.js';
import {
  isSpringMessageProducerMethod,
  springMessageProducerTemplateOf,
  type SpringMessageProducerFact,
} from '../../frameworks/spring/message-producers.js';
import {
  findAncestorBeforeBoundary,
  hasRecoveredSyntax,
  nodeToCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

const CALLABLE_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);
/**
 * A type body ends the search for the publishing callable.
 *
 * Without it the ancestor walk passes THROUGH the body of a class declared
 * inside a method, so a publish in that class's field initializer is attributed
 * to the enclosing method, which may never run it. The identical construct at
 * the top level of a class already yields no fact — there is no enclosing
 * callable to find — and the rule has to read the same at every depth.
 */
const TYPE_BODY_BOUNDARIES = new Set([
  'class_body',
  'interface_body',
  'enum_body',
  'enum_body_declarations',
  'annotation_type_body',
]);
const COMMENT_NODE_TYPES = new Set(['line_comment', 'block_comment']);

/** Java has no named call arguments, so every argument is captured positionally. */
function javaCallArgumentFacts(argumentList: SyntaxNode): SpringArgumentFact[] {
  return argumentList.namedChildren
    .filter((child) => !COMMENT_NODE_TYPES.has(child.type))
    .map((child) => ({ text: normalizeSpringFactText(child.text) }));
}

/**
 * Capture one messaging-template publish from a Java call already surfaced by
 * the scope query, without resolving the destination it names.
 *
 * The destination argument may be a literal, a reference to a constant that
 * lives in another file, or a `${...}` placeholder resolved from configuration;
 * all three are recorded as written and left to a later phase.
 *
 * A call whose argument list did not parse yields NO fact. The fact exists to
 * carry a destination, and error recovery invents argument boundaries — an
 * unterminated `send(TOPIC,` absorbs the next declaration's source and offers
 * it as an argument. There is no state on this fact that means "published
 * somewhere unreadable", so the choice is between silence and a plausible lie,
 * and silence is recoverable: the file is re-captured when it parses.
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
  const receiverName = normalizeSpringFactText(receiverText);
  const template = springMessageProducerTemplateOf(receiverName, methodName);
  if (template === null) return null;

  const argumentList = node.childForFieldName('arguments');
  if (argumentList !== null && hasRecoveredSyntax(argumentList)) return null;
  const owner = findAncestorBeforeBoundary(node, CALLABLE_NODE_TYPES, TYPE_BODY_BOUNDARIES);
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
