import type { Range, ScopeId } from 'gitnexus-shared';
import type { SpringArgumentFact } from './argument-facts.js';

/**
 * Outbound side of Spring messaging: the template calls that publish to a
 * broker destination, mirroring the inbound `@KafkaListener` / `@RabbitListener`
 * family already recognized in `non-http-handlers.ts`.
 *
 * Recognition is purely syntactic and happens while the language's own scope
 * query already has the call node in hand. The receiver's declared type is NOT
 * consulted: at capture time the field may be inherited, injected from another
 * file, or typed through an import that is not finalized yet. Matching on the
 * receiver's simple name instead keeps the capture cheap and resolver-free; a
 * later phase that owns type information can refine or discard a fact.
 */
export type SpringMessageProducerTemplate = 'kafka' | 'rabbit' | 'jms' | 'stream-bridge';

interface ProducerSignature {
  readonly template: SpringMessageProducerTemplate;
  /** Simple type name of the template bean, matched as a receiver-name suffix. */
  readonly typeName: string;
  readonly methodName: string;
}

const PRODUCER_SIGNATURES: readonly ProducerSignature[] = [
  { template: 'kafka', typeName: 'KafkaTemplate', methodName: 'send' },
  { template: 'rabbit', typeName: 'RabbitTemplate', methodName: 'convertAndSend' },
  { template: 'jms', typeName: 'JmsTemplate', methodName: 'convertAndSend' },
  { template: 'stream-bridge', typeName: 'StreamBridge', methodName: 'send' },
];

const PRODUCER_METHOD_NAMES: ReadonlySet<string> = new Set(
  PRODUCER_SIGNATURES.map((signature) => signature.methodName),
);

/** A receiver we can attribute; `templates["k"]` or `getTemplate()` cannot be. */
const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Join a receiver chain that the source wrapped across lines.
 *
 * A chain written as `outer\n    .inner\n    .kafkaTemplate` is the same
 * receiver as its single-line spelling, but the raw node text would carry the
 * newlines and the enclosing block's indentation across the worker boundary,
 * so two spellings of one receiver would not compare equal downstream.
 *
 * Only a run of whitespace that CONTAINS A NEWLINE and sits next to a dot is
 * removed. Single-line spacing is left alone, which keeps the rewrite away
 * from string literals nested in the receiver: `registry.get("a . b").template`
 * keeps its argument exactly as written.
 */
export function normalizeSpringProducerReceiverName(receiverName: string): string {
  return receiverName
    .trim()
    .replace(/\s*\.\s*/g, (separator) => (separator.includes('\n') ? '.' : separator));
}

/**
 * Cheap pre-filter usable before any receiver text is materialized. Both
 * languages visit every member call, so the common case must cost one set
 * lookup on the method name.
 */
export function isSpringMessageProducerMethod(methodName: string): boolean {
  return PRODUCER_METHOD_NAMES.has(methodName);
}

/**
 * Classify a `receiver.method(...)` call as a messaging producer, or `null`.
 *
 * `receiverName` is the receiver expression as written; only its last
 * dot-separated segment participates, so `this.kafkaTemplate` and
 * `outer.inner.kafkaTemplate` match while `templates.get("k")` does not. The
 * segment matches case-insensitively as a SUFFIX of the template type name, so
 * both `kafkaTemplate` and `orderKafkaTemplate` are recognized. A receiver
 * named only `template` is deliberately not: without type information that
 * would attribute any `send` in the repository to Kafka.
 */
export function springMessageProducerTemplateOf(
  receiverName: string,
  methodName: string,
): SpringMessageProducerTemplate | null {
  if (!isSpringMessageProducerMethod(methodName)) return null;
  const receiverSimpleName = receiverName.slice(receiverName.lastIndexOf('.') + 1).trim();
  if (!PLAIN_IDENTIFIER.test(receiverSimpleName)) return null;
  const lowered = receiverSimpleName.toLowerCase();
  for (const signature of PRODUCER_SIGNATURES) {
    if (signature.methodName !== methodName) continue;
    if (lowered.endsWith(signature.typeName.toLowerCase())) return signature.template;
  }
  return null;
}

export interface SpringMessageProducerFact {
  /** Callable that performs the publish; the enclosing method or function. */
  readonly ownerScopeId: ScopeId;
  readonly ownerRange: Range;
  readonly template: SpringMessageProducerTemplate;
  /** Receiver expression as written, for example `this.orderKafkaTemplate`. */
  readonly receiverName: string;
  readonly methodName: string;
  /**
   * Call arguments in source order, or absent when the call site has no
   * argument list at all (a Kotlin trailing-lambda call). An empty array means
   * an empty argument list was written — a different fact from no list.
   */
  readonly args?: readonly SpringArgumentFact[];
}
