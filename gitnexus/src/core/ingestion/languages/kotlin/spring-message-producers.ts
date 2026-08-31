import { makeScopeId } from 'gitnexus-shared';
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
import { kotlinValueArgumentFacts } from './spring-di.js';

// Kotlin emits graph callables for functions and secondary constructors.
// `init {}` / primary-constructor bodies have no independent callable node, so
// attributing their publishes to the enclosing Class would violate graph
// semantics.
const CALLABLE_NODE_TYPES = new Set(['function_declaration', 'secondary_constructor']);
const NO_CALLABLE_BOUNDARIES = new Set<string>();

/**
 * Strip null-assertion operators from a receiver.
 *
 * `?.` carries its marker on the navigation suffix, which the structural split
 * already discards, but `!!` wraps the receiver in a `postfix_expression` whose
 * text ends in the operator — enough to make `kafkaTemplate!!` fail the
 * receiver-name check and lose a publish. Unwrapping is limited to `!!`
 * because `counter++` produces the same node shape and is not a receiver name.
 */
function withoutNullAssertions(receiver: SyntaxNode): SyntaxNode {
  let current = receiver;
  while (current.type === 'postfix_expression') {
    const operand = current.namedChildren[0];
    if (operand === undefined) return current;
    const onlyNullAssertions = current.children.every(
      (child) => child.id === operand.id || child.type === '!!',
    );
    if (!onlyNullAssertions) return current;
    current = operand;
  }
  return current;
}

/**
 * Split `receiver.method` structurally rather than by text.
 *
 * Text splitting would leave the safe-call marker on the receiver
 * (`kafkaTemplate?` for `kafkaTemplate?.send(...)`).
 */
function navigationParts(
  callee: SyntaxNode,
): { receiverName: string; methodName: string } | null {
  if (callee.type !== 'navigation_expression') return null;
  const suffix = callee.namedChildren.find((child) => child.type === 'navigation_suffix');
  const receiver = callee.namedChildren.find((child) => child.type !== 'navigation_suffix');
  if (suffix === undefined || receiver === undefined) return null;
  const methodName = suffix.namedChildren
    .find((child) => child.type === 'simple_identifier')
    ?.text.trim();
  if (methodName === undefined) return null;
  return {
    receiverName: normalizeSpringProducerReceiverName(withoutNullAssertions(receiver).text),
    methodName,
  };
}

/**
 * Capture one messaging-template publish from a Kotlin call already surfaced by
 * the scope query, without resolving the destination it names.
 *
 * The destination argument may be a literal, a reference to a constant that
 * lives in another file, or a `${...}` placeholder resolved from configuration;
 * all three are recorded as written and left to a later phase.
 */
export function captureKotlinSpringMessageProducerFact(
  node: SyntaxNode,
  filePath: string,
): SpringMessageProducerFact | null {
  if (node.type !== 'call_expression') return null;
  const callee = node.namedChildren[0];
  if (callee === undefined) return null;
  const parts = navigationParts(callee);
  if (parts === null || !isSpringMessageProducerMethod(parts.methodName)) return null;
  const template = springMessageProducerTemplateOf(parts.receiverName, parts.methodName);
  if (template === null) return null;

  const callSuffix = node.namedChildren.find((child) => child.type === 'call_suffix');
  // A trailing-lambda call (`send { ... }`) has no argument list at all, which
  // is a different fact from an empty one (`send()`).
  const valueArguments = callSuffix?.namedChildren.find(
    (child) => child.type === 'value_arguments',
  );
  const owner = findAncestorBeforeBoundary(node, CALLABLE_NODE_TYPES, NO_CALLABLE_BOUNDARIES);
  if (owner === null) return null;
  const ownerCapture = nodeToCapture('@spring-message-producer.owner', owner);
  return {
    ownerScopeId: makeScopeId({ filePath, range: ownerCapture.range, kind: 'Function' }),
    ownerRange: ownerCapture.range,
    template,
    receiverName: parts.receiverName,
    methodName: parts.methodName,
    ...(valueArguments === undefined ? {} : { args: kotlinValueArgumentFacts(valueArguments) }),
  };
}

/** Standalone extractor for focused tests; production reuses scope-query call nodes. */
export function captureKotlinSpringMessageProducerFacts(
  rootNode: SyntaxNode,
  filePath: string,
): SpringMessageProducerFact[] {
  return rootNode
    .descendantsOfType('call_expression')
    .map((node) => captureKotlinSpringMessageProducerFact(node, filePath))
    .filter((fact): fact is SpringMessageProducerFact => fact !== null);
}
