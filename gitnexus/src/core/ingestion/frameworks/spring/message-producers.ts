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
 * Fold a receiver's simple name to the form the type-name match runs against.
 *
 * `_` and `$` are word separators in the spellings this has to accept, not part
 * of the words: `KAFKA_TEMPLATE` and `kafka_template` are the same bean name as
 * `kafkaTemplate`, written to the constant and snake conventions. Digits stay,
 * because they are part of a name (`kafkaTemplate2`), never a separator.
 */
function foldReceiverName(receiverSimpleName: string): string {
  return receiverSimpleName.replace(/[_$]/g, '').toLowerCase();
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
 * `outer.inner.kafkaTemplate` match while `templates.get("k")` does not.
 *
 * The PLAIN_IDENTIFIER gate runs BEFORE the fold and is load-bearing, because
 * the last-dot split is textual: in `config.get("a.kafkaTemplate")` it yields
 * `kafkaTemplate")`, which folds to something a name match would accept. Only
 * an identifier survives the gate, which is also what rejects `templates["k"]`,
 * `getTemplate()`, and a receiver whose dot is separated by a comment.
 *
 * The folded segment then matches case-insensitively when it CONTAINS the
 * template type name, so every convention a template bean is really declared
 * with is recognized — decorated by prefix (`orderKafkaTemplate`), by suffix
 * (`kafkaTemplateDlq`, `kafkaTemplateV2`, `rabbitTemplate1`), or written as a
 * constant (`KAFKA_TEMPLATE`, `STREAM_BRIDGE`). A suffix-only rule accepted
 * one of those and silently dropped the rest, which are exactly the publishes
 * this capture exists to find. A receiver named only `template` still does not
 * match: without type information that would attribute any `send` in the
 * repository to Kafka.
 *
 * The bare type name (`KafkaTemplate.send(...)`) contains itself and so is
 * accepted. That is left as it is: the match is by NAME, a name equal to the
 * type is the strongest evidence the rule has, and a later phase that owns type
 * information can discard a static-looking receiver.
 */
export function springMessageProducerTemplateOf(
  receiverName: string,
  methodName: string,
): SpringMessageProducerTemplate | null {
  if (!isSpringMessageProducerMethod(methodName)) return null;
  const receiverSimpleName = receiverName.slice(receiverName.lastIndexOf('.') + 1).trim();
  if (!PLAIN_IDENTIFIER.test(receiverSimpleName)) return null;
  const folded = foldReceiverName(receiverSimpleName);
  for (const signature of PRODUCER_SIGNATURES) {
    if (signature.methodName !== methodName) continue;
    if (folded.includes(signature.typeName.toLowerCase())) return signature.template;
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
