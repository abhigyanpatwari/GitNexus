import type { SpringArgumentFact } from './argument-facts.js';
import type { SpringMessageProducerTemplate } from './message-producers.js';

/**
 * Resolution of Spring async messaging DESTINATIONS — the broker address a
 * `@KafkaListener` reads from or a `kafkaTemplate.send(...)` writes to.
 *
 * The capture layer records the destination argument exactly as written and
 * resolves nothing (see `argument-facts.ts`). This module is the other half:
 * it decides WHICH argument names the destination, then walks a four-step
 * cascade to turn that argument's source text into an address. It is pure —
 * no graph, no filesystem, no parser — so every rule below is unit-testable
 * against a string, and `pipeline-phases/spring-destinations.ts` is left with
 * only node and edge emission.
 *
 * ── THE INVARIANT THIS MODULE EXISTS TO PROTECT ──────────────────────────
 *
 * An address that could NOT be resolved must never become a shared identity.
 * Two unrelated services that each merely write
 *
 *     @KafkaListener(topics = "${app.topic}")
 *
 * have said nothing about each other. If the graph keyed a destination node on
 * that placeholder text, they would land on one node and READ AS CONNECTED —
 * and a false edge is worse than a missing one, because a missing edge is
 * visible as a gap while a false one enters reports as a fact.
 *
 * So this module never returns a placeholder, a constant name, or any other
 * unresolved spelling as an `address`. An unresolved candidate comes back as
 * `{ kind: 'unresolved', reason }` with no address at all, and the phase keys
 * such a node by its SOURCE LOCATION. A status flag would not have been
 * enough: the two services would still share whatever key the node was minted
 * from. Only withholding the key prevents the join.
 *
 * ── REFUSAL IS DATA ──────────────────────────────────────────────────────
 *
 * Every path that declines to produce an address records WHY, from a closed
 * set ({@link SpringDestinationRefusal}). The measure of this feature is the
 * unresolved fraction, so a silent `continue` would hide precisely the number
 * that says whether it works.
 */

/** Broker family behind a destination, as far as the syntax can attest. */
export type SpringDestinationBroker =
  | 'kafka'
  | 'rabbit'
  | 'jms'
  | 'pulsar'
  | 'sqs'
  | 'stream'
  | 'integration';

/**
 * Why a candidate produced no address. Closed set: each member is a distinct,
 * countable diagnosis, and no path may decline without naming one.
 */
export type SpringDestinationRefusal =
  /** The annotation is a recognized listener but its arguments were never read. */
  | 'annotation-arguments-unavailable'
  /** Recognized listener, argument list present, no element names a destination. */
  | 'no-destination-argument'
  /** `@KafkaListener(topicPattern = ...)` — a regex over topics, not an address. */
  | 'topic-pattern'
  /** A destination form this module deliberately does not read, e.g.
   *  `@RabbitListener(bindings = @QueueBinding(...))` or `topicPartitions`. */
  | 'unsupported-annotation-argument'
  /** A Kotlin trailing-lambda call: the publish has no argument list at all. */
  | 'producer-arguments-unavailable'
  /** The call's arity matches none of the overloads that carry a destination. */
  | 'producer-arity-unrecognized'
  /** `rabbitTemplate.convertAndSend(message)` — default exchange, empty routing
   *  key. There is no address in the source to record. */
  | 'rabbit-default-exchange'
  /** The argument in the destination position is not shaped like an address
   *  (not a string literal, not a constant reference) — most often because the
   *  overload actually taken has the payload there. */
  | 'producer-argument-not-address-shaped'
  /** `topics = {}` / `topics = []` / `arrayOf()`. */
  | 'empty-destination-list'
  /** The element is an expression this module will not evaluate — a
   *  concatenation, a call, a ternary. */
  | 'not-a-literal-or-constant'
  /** A constant reference no constant resolver could fold to a string. */
  | 'unresolved-constant'
  /** `${key}` with no default. The KEY is recorded; the VALUE is deliberately
   *  absent from the graph (config values may hold credentials — see the header
   *  of `pipeline-phases/spring-config.ts`), so this can never resolve here. */
  | 'unresolved-config-key'
  /** Everything folded, and the result was the empty string. An empty address
   *  addresses nothing, and letting it through would give every such site one
   *  shared `''` identity — the same false join the placeholder rule prevents. */
  | 'empty-address';

/** How an address was arrived at, kept on the node for provenance. */
export type SpringDestinationVia = 'literal' | 'constant' | 'config-default' | 'specification';

export type SpringDestinationRole = 'consumer' | 'producer';

/**
 * One argument element that has been ACCEPTED as naming a destination, before
 * any attempt to resolve it. An array-valued argument yields one candidate per
 * element: `topics = ["a", "b"]` really is two destinations, and each gets its
 * own node and its own edge (see the phase for why no group node is minted).
 */
export interface SpringDestinationCandidate {
  readonly role: SpringDestinationRole;
  /** Annotation simple name (`KafkaListener`) or producer template (`kafka`). */
  readonly source: string;
  readonly broker: SpringDestinationBroker;
  /** Index of the argument this element came from, in source order. */
  readonly argIndex: number;
  /** Argument name when the call/annotation named it (`topics`, `queues`). */
  readonly argName?: string;
  /** Index within an array-valued argument; `0` for a scalar. */
  readonly elementIndex: number;
  /** The element's source text, exactly as captured. */
  readonly rawText: string;
  /** Companion provenance that is not itself an address — currently only the
   *  Rabbit exchange that accompanies a routing key. */
  readonly exchange?: string;
}

/** A candidate that was declined before resolution was even attempted. */
export interface SpringDestinationRefusalRecord {
  readonly role: SpringDestinationRole;
  readonly source: string;
  readonly broker: SpringDestinationBroker;
  readonly reason: SpringDestinationRefusal;
  /** Source text that provoked the refusal, when there was one. */
  readonly rawText?: string;
  readonly argIndex?: number;
  readonly argName?: string;
}

export interface SpringDestinationSelection {
  readonly candidates: readonly SpringDestinationCandidate[];
  readonly refusals: readonly SpringDestinationRefusalRecord[];
}

export type SpringDestinationResolution =
  | { readonly kind: 'resolved'; readonly address: string; readonly via: SpringDestinationVia }
  | {
      readonly kind: 'unresolved';
      readonly reason: SpringDestinationRefusal;
      /** Configuration key named by an unresolvable `${...}` placeholder. Lets
       *  the phase link the node to the `Property` nodes for that key without
       *  ever learning the key's value. */
      readonly configKey?: string;
    };

/**
 * The cascade's pluggable steps. Both are supplied by the phase, which owns the
 * language-specific machinery; keeping them as callbacks is what lets this
 * module stay language-neutral and testable with a plain map.
 */
export interface SpringDestinationResolvers {
  /**
   * Step 2 — fold a constant reference (`Topics.ORDERS`, `ORDERS`) to its
   * string value, or `null` when it cannot be folded. Backed by
   * `resolveJavaConstant` / `resolveKotlinConstant`.
   */
  readonly constant?: (name: string) => string | null;
  /**
   * Step 4 — SEAM, DELIBERATELY NOT IMPLEMENTED.
   *
   * Some destinations are named nowhere in the source: the address lives in a
   * published API specification (AsyncAPI / springwolf) that the service
   * generates, and the code only names a binding. Resolving those means reading
   * an artifact that is not a source file, deciding which specification belongs
   * to which module, and trusting a generated document — a different problem
   * from the three syntactic steps above, with a different failure mode.
   *
   * The hook exists so that work has a defined place to land and so the cascade
   * order is fixed now rather than renegotiated later. Nothing supplies it
   * today, so step 4 is a no-op and such destinations stay unresolved with the
   * reason the earlier step recorded.
   */
  readonly specification?: (candidate: SpringDestinationCandidate) => string | null;
}

// ── Consumer side: which annotation argument names the destination ─────────

interface ConsumerAnnotationRule {
  readonly broker: SpringDestinationBroker;
  /** Argument names that carry an address, in preference order. */
  readonly addressArgs: readonly string[];
  /**
   * A bare positional argument is the annotation's `value` element. Accepted
   * only where `value` really is the destination: `@SqsListener("q")` and
   * `@StreamListener("ch")`. `@KafkaListener`, `@RabbitListener`, `@JmsListener`
   * and `@ServiceActivator` declare no `value` alias for their destination, so
   * a positional argument on one of those is something else entirely and is
   * refused rather than guessed at.
   */
  readonly positionalIsAddress: boolean;
  /** Arguments that are patterns over addresses, not addresses. */
  readonly patternArgs?: readonly string[];
  /** Arguments that name a destination in a shape this module will not read. */
  readonly unsupportedArgs?: readonly string[];
}

/**
 * Recognized listener annotations, keyed by SIMPLE name.
 *
 * Simple names, not fully-qualified ones, because a pipeline phase runs after
 * scope resolution has finished and no longer has the import tables that
 * `createSpringAnnotationNameResolver` needs. The capture layer already gates
 * on simple names for the same reason (`CAPTURE_RELEVANT_SIMPLE_NAMES` in
 * `non-http-handlers.ts`), so nothing reaches this map that was not already
 * admitted on that basis; matching on the FQN here would only reject facts the
 * capture had already accepted, never admit more.
 *
 * DELIBERATELY ABSENT: `@MessageMapping` and `@SubscribeMapping`. Both are
 * recognized by `non-http-handlers.ts` as message handlers, and both are
 * WebSocket/STOMP routes — an application-level destination inside a
 * server-managed session, not an address on a broker. Modelling `/topic/prices`
 * as a `Destination` would put a STOMP path in the same namespace as a Kafka
 * topic and let the cross-service joiner match them.
 */
const CONSUMER_ANNOTATIONS: ReadonlyMap<string, ConsumerAnnotationRule> = new Map([
  [
    'KafkaListener',
    {
      broker: 'kafka' as const,
      addressArgs: ['topics'],
      positionalIsAddress: false,
      patternArgs: ['topicPattern'],
      unsupportedArgs: ['topicPartitions'],
    },
  ],
  [
    'PulsarListener',
    {
      broker: 'pulsar' as const,
      addressArgs: ['topics'],
      positionalIsAddress: false,
      patternArgs: ['topicPattern'],
    },
  ],
  [
    'RabbitListener',
    {
      broker: 'rabbit' as const,
      addressArgs: ['queues'],
      positionalIsAddress: false,
      unsupportedArgs: ['bindings', 'queuesToDeclare'],
    },
  ],
  [
    'JmsListener',
    { broker: 'jms' as const, addressArgs: ['destination'], positionalIsAddress: false },
  ],
  [
    'ServiceActivator',
    { broker: 'integration' as const, addressArgs: ['inputChannel'], positionalIsAddress: false },
  ],
  ['SqsListener', { broker: 'sqs' as const, addressArgs: ['value'], positionalIsAddress: true }],
  [
    'StreamListener',
    { broker: 'stream' as const, addressArgs: ['value'], positionalIsAddress: true },
  ],
]);

/**
 * Plural container annotations (`@KafkaListeners`, `@RabbitListeners`, …) wrap
 * repeated listeners. Their single argument is a list of nested annotations,
 * whose own arguments the capture does not descend into, so there is nothing
 * here to read. Recognizing them by name keeps them from being reported as an
 * unrecognized annotation, which would make the refusal counts misleading.
 */
const CONSUMER_CONTAINER_ANNOTATIONS: ReadonlySet<string> = new Set([
  'KafkaListeners',
  'RabbitListeners',
  'JmsListeners',
  'PulsarListeners',
]);

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

/** True when the annotation is one this module reads destinations from. */
export function isSpringDestinationAnnotation(annotationName: string): boolean {
  return CONSUMER_ANNOTATIONS.has(simpleName(annotationName));
}

/**
 * Choose the destination-bearing arguments of one listener annotation.
 *
 * Returns `null` when the annotation is not a broker listener at all — that is
 * not a refusal, there was nothing to refuse. A recognized annotation always
 * returns a selection, even when every path in it declined, so the caller can
 * count what was seen against what resolved.
 */
export function selectConsumerDestinationArguments(
  annotationName: string,
  args: readonly SpringArgumentFact[] | undefined,
): SpringDestinationSelection | null {
  const name = simpleName(annotationName);
  if (CONSUMER_CONTAINER_ANNOTATIONS.has(name)) {
    return { candidates: [], refusals: [] };
  }
  const rule = CONSUMER_ANNOTATIONS.get(name);
  if (rule === undefined) return null;

  const refusals: SpringDestinationRefusalRecord[] = [];
  const refuse = (
    reason: SpringDestinationRefusal,
    extra: Omit<SpringDestinationRefusalRecord, 'role' | 'source' | 'broker' | 'reason'> = {},
  ): void => {
    refusals.push({ role: 'consumer', source: name, broker: rule.broker, reason, ...extra });
  };

  // Absent arguments have two causes and only one is a statement about the
  // source (see `SpringNonHttpHandlerAnnotationFact.args`). Neither is
  // distinguishable here, and both mean the same thing to this module: the
  // destination cannot be read. An empty ARRAY, by contrast, means an empty
  // argument list really was written, which for a listener means no address.
  if (args === undefined || args.length === 0) {
    refuse('annotation-arguments-unavailable');
    return { candidates: [], refusals };
  }

  const candidates: SpringDestinationCandidate[] = [];
  let sawDestinationArgument = false;
  for (const [argIndex, arg] of args.entries()) {
    const argName = arg.name;
    if (argName === undefined) {
      // Positional. Only the annotations whose `value` element IS the
      // destination accept it; on the others a positional argument is a
      // different element entirely and gets no guess.
      if (!rule.positionalIsAddress) continue;
      sawDestinationArgument = true;
      pushElements(candidates, refusals, {
        role: 'consumer',
        source: name,
        broker: rule.broker,
        argIndex,
        rawText: arg.text,
      });
      continue;
    }
    if (rule.patternArgs?.includes(argName)) {
      sawDestinationArgument = true;
      refuse('topic-pattern', { rawText: arg.text, argIndex, argName });
      continue;
    }
    if (rule.unsupportedArgs?.includes(argName)) {
      sawDestinationArgument = true;
      refuse('unsupported-annotation-argument', { rawText: arg.text, argIndex, argName });
      continue;
    }
    if (!rule.addressArgs.includes(argName)) continue;
    sawDestinationArgument = true;
    pushElements(candidates, refusals, {
      role: 'consumer',
      source: name,
      broker: rule.broker,
      argIndex,
      argName,
      rawText: arg.text,
    });
  }

  // A listener whose arguments were read and named `groupId` and
  // `containerFactory` but no destination is a real, countable gap — most often
  // a form this module has not learned. It must not be silent.
  if (!sawDestinationArgument) refuse('no-destination-argument');
  return { candidates, refusals };
}

// ── Producer side: which call argument names the destination ───────────────

/**
 * Choose the destination-bearing arguments of one messaging-template publish.
 *
 * Arity decides where it CAN decide, and shape decides where it cannot.
 *
 * `KafkaTemplate.send` and `StreamBridge.send` put the destination first in
 * every multi-argument overload they have, so once a call has two or more
 * arguments its slot 0 is the destination and nothing further needs deciding.
 * Those slots use the PERMISSIVE gate ({@link isAddressShaped}): a bare
 * identifier is let through to the cascade, which refuses it by name if no
 * constant folds. That keeps `unresolved-constant` — a thing we tried to
 * resolve — distinct from `producer-argument-not-address-shaped`, a thing we
 * declined to read at all.
 *
 * The `convertAndSend` families are different. Both admit a trailing
 * `MessagePostProcessor`, which collides two overloads onto one arity:
 *
 *   jms    (destination, message)     vs (message, postProcessor)          — 2
 *   rabbit (routingKey, message)      vs (message, postProcessor)          — 2
 *   rabbit (exchange, routingKey, msg) vs (routingKey, msg, postProcessor) — 3
 *
 * At those arities the tie is broken by the STRICT gate
 * ({@link isConfidentAddressShape}) — a string literal, a qualified reference,
 * or a screaming-snake constant, all of which a payload variable is not. A
 * lowercase bare identifier is NOT confident evidence there, so
 * `convertAndSend(topic, payload)` is refused rather than read: the same
 * spelling is how a payload variable looks, and there is nothing in the syntax
 * that separates them. That refusal is the deliberate cost. A refusal is
 * counted and recoverable; a wrong address enters reports as a fact.
 */
export function selectProducerDestinationArguments(fact: {
  readonly template: SpringMessageProducerTemplate;
  readonly methodName: string;
  readonly args?: readonly SpringArgumentFact[];
}): SpringDestinationSelection {
  const broker: SpringDestinationBroker =
    fact.template === 'stream-bridge' ? 'stream' : fact.template;
  const source = fact.template;
  const refusals: SpringDestinationRefusalRecord[] = [];
  const refuse = (
    reason: SpringDestinationRefusal,
    extra: Omit<SpringDestinationRefusalRecord, 'role' | 'source' | 'broker' | 'reason'> = {},
  ): void => {
    refusals.push({ role: 'producer', source, broker, reason, ...extra });
  };

  const args = fact.args;
  if (args === undefined) {
    refuse('producer-arguments-unavailable');
    return { candidates: [], refusals };
  }
  if (args.length === 0) {
    refuse('producer-arity-unrecognized');
    return { candidates: [], refusals };
  }

  const candidates: SpringDestinationCandidate[] = [];
  const accept = (argIndex: number, exchange?: string): void => {
    const arg = args[argIndex] as SpringArgumentFact;
    pushElements(candidates, refusals, {
      role: 'producer',
      source,
      broker,
      argIndex,
      ...(arg.name === undefined ? {} : { argName: arg.name }),
      rawText: arg.text,
      ...(exchange === undefined ? {} : { exchange }),
    });
  };
  const textAt = (index: number): string => (args[index] as SpringArgumentFact).text;
  const confident = (index: number): boolean =>
    index < args.length && isConfidentAddressShape(textAt(index));
  const refuseShape = (index: number): void => {
    refuse('producer-argument-not-address-shaped', { rawText: textAt(index), argIndex: index });
  };

  if (fact.template === 'rabbit') {
    // `convertAndSend` overloads, by what occupies the leading slots:
    //   (message)                              → default exchange, no address
    //   (routingKey, message)                  → arg0 is the routing key
    //   (message, postProcessor)               → NO address, same arity
    //   (exchange, routingKey, message)        → arg0 + arg1
    //   (routingKey, message, postProcessor)   → arg0 only, same arity
    //   (exchange, routingKey, message, pp)    → arg0 + arg1
    if (args.length === 1) {
      refuse('rabbit-default-exchange', { rawText: textAt(0), argIndex: 0 });
      return { candidates, refusals };
    }
    if (args.length >= 4) {
      // Only the exchange form reaches four arguments, so this is unambiguous
      // and slot 1 may use the permissive gate.
      if (!isAddressShaped(textAt(1))) {
        refuseShape(1);
        return { candidates, refusals };
      }
      accept(1, unquoteForProvenance(textAt(0)));
      return { candidates, refusals };
    }
    if (args.length === 3 && confident(1)) {
      // The ADDRESS is the routing key. The exchange rides along as provenance
      // on the edge rather than becoming part of the address: composing
      // `exchange/routingKey` would invent a spelling no consumer ever writes,
      // and a `@RabbitListener` names a QUEUE, so the two sides do not join on
      // the exchange anyway. Which queue an exchange/key pair reaches is decided
      // by bindings this index does not read.
      accept(1, unquoteForProvenance(textAt(0)));
      return { candidates, refusals };
    }
    if (confident(0)) {
      accept(0);
      return { candidates, refusals };
    }
    refuseShape(0);
    return { candidates, refusals };
  }

  // kafka `send(topic, …)`, jms `convertAndSend(destination, message, …)` and
  // stream-bridge `send(binding, …)` all put the destination first and all
  // require at least one further argument for the payload. A single-argument
  // call is therefore one of the payload-only overloads —
  // `send(ProducerRecord)`, `send(Message<?>)`, `convertAndSend(Object)` — which
  // carries its destination inside an object this module does not open.
  if (args.length < 2) {
    refuse('producer-arity-unrecognized', { rawText: textAt(0), argIndex: 0 });
    return { candidates, refusals };
  }
  // Two-argument `convertAndSend` is the one JMS arity that collides with the
  // post-processor overload, so only there does slot 0 need confident evidence.
  const strict = fact.template === 'jms' && args.length === 2;
  if (strict ? !confident(0) : !isAddressShaped(textAt(0))) {
    refuseShape(0);
    return { candidates, refusals };
  }
  accept(0);
  return { candidates, refusals };
}

// ── Array / literal / placeholder text handling ────────────────────────────

/**
 * Split an array-valued destination argument into its elements.
 *
 * Both languages hand this module ONE unsplit string per argument: capture
 * records an argument's source text, and `topics = {"a", "b"}` is a single
 * argument whose text happens to be a list. So the list is parsed here, in the
 * three spellings the two languages use — Java `{…}`, Kotlin `[…]`, and Kotlin
 * `arrayOf(…)`.
 *
 * Anything else comes back as a single element, unchanged: a scalar argument,
 * and equally an expression that merely starts with a brace. The split tracks
 * nesting and string literals, so a comma inside a literal or inside a nested
 * call does not split the list.
 *
 * Returns `[]` for an empty list, which the caller must distinguish from a
 * one-element list — `topics = {}` names no destination at all.
 */
export function splitSpringDestinationList(text: string): readonly string[] {
  const trimmed = text.trim();
  let inner: string | null = null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) inner = trimmed.slice(1, -1);
  else if (trimmed.startsWith('[') && trimmed.endsWith(']')) inner = trimmed.slice(1, -1);
  else if (/^arrayOf\s*\(/.test(trimmed) && trimmed.endsWith(')')) {
    inner = trimmed.slice(trimmed.indexOf('(') + 1, -1);
  }
  if (inner === null) return [trimmed];
  if (inner.trim() === '') return [];

  const elements: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"""' | '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (quote === '"""') {
      current += char;
      if (inner.startsWith('"""', index)) {
        current += '""';
        index += 2;
        quote = null;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\' && index + 1 < inner.length) {
        current += inner.slice(index, index + 2);
        index += 1;
        continue;
      }
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (inner.startsWith('"""', index)) {
      current += '"""';
      index += 2;
      quote = '"""';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      elements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  elements.push(current.trim());
  return elements.filter((element) => element !== '');
}

const STRING_LITERAL = /^(?:"""([\s\S]*)"""|"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)')$/;

/**
 * Unquote a string literal to its value, or `null` when the text is not a
 * single literal.
 *
 * Escapes are undone only for the sequences that can appear inside a
 * destination: `\"`, `\\`, and Kotlin's `\$`. That last one matters more than it
 * looks — a Spring placeholder written in Kotlin MUST escape the dollar
 * (`"\${app.topic}"`) or the compiler reads it as a string template, so without
 * undoing it every Kotlin placeholder would fail the `${` test below and be
 * misfiled as a plain literal address named `\${app.topic}`.
 */
export function parseSpringStringLiteral(text: string): string | null {
  const match = STRING_LITERAL.exec(text.trim());
  if (match === null) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  return raw.replace(/\\(["'\\$nrt])/g, (_all, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

/** A dotted or bare identifier — the only non-literal shape read as a constant. */
const CONSTANT_REFERENCE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * PERMISSIVE gate — true when the text could name an address: a string literal,
 * or any reference a constant resolver could plausibly fold. Says nothing about
 * whether that reference actually resolves; the cascade decides that and
 * records `unresolved-constant` when it does not.
 *
 * Used where the overload set already fixes which slot holds the destination.
 */
export function isAddressShaped(text: string): boolean {
  const trimmed = text.trim();
  if (parseSpringStringLiteral(trimmed) !== null) return true;
  return CONSTANT_REFERENCE.test(trimmed);
}

/** A reference whose spelling is evidence in itself: qualified (`Topics.ORDERS`)
 *  or a screaming-snake constant (`ORDERS_TOPIC`). `this.x` is excluded — the
 *  qualifier says nothing about the member. */
const CONFIDENT_REFERENCE = /^(?!this\s*\.)[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*[A-Za-z0-9_$.\s]+$/;
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_$]*$/;

/**
 * STRICT gate — true only when the spelling is confident evidence of an
 * address, not merely compatible with one.
 *
 * The difference from {@link isAddressShaped} is the lowercase bare identifier.
 * `convertAndSend(topic, payload)` and `convertAndSend(message, processor)` are
 * the same syntax; only a human reading the names can tell which slot is the
 * destination, and a name is not something this module is willing to rank as
 * evidence. So a bare `topic` fails here and the publish is refused, while
 * `"orders"`, `Topics.ORDERS` and `ORDERS_TOPIC` pass.
 *
 * Used ONLY at the arities where a trailing `MessagePostProcessor` overload
 * collides with the destination-carrying one. Everywhere else the permissive
 * gate applies, so this stricter rule costs nothing outside the ambiguity.
 */
export function isConfidentAddressShape(text: string): boolean {
  const trimmed = text.trim();
  if (parseSpringStringLiteral(trimmed) !== null) return true;
  if (!CONSTANT_REFERENCE.test(trimmed)) return false;
  return CONFIDENT_REFERENCE.test(trimmed) || SCREAMING_SNAKE.test(trimmed);
}

/** Best-effort display form for provenance text; never used as an identity. */
function unquoteForProvenance(text: string): string {
  return parseSpringStringLiteral(text) ?? text.trim();
}

export interface SpringPlaceholderResult {
  /** Fully substituted value when every placeholder carried a default. */
  readonly value?: string;
  /** First key that had no default, in `${key}` order. */
  readonly unresolvedKey?: string;
  /** True when the text contained no `${…}` at all. */
  readonly plain: boolean;
}

/**
 * Interpret Spring property placeholders in an already-unquoted value.
 *
 * `${key:default}` resolves to `default`, because that default is written in
 * the SOURCE — reading it is not reading configuration, and refusing it would
 * throw away an address the repository states outright.
 *
 * `${key}` does not resolve, ever. The value lives in a configuration file that
 * this index deliberately does not read into the graph (values may hold
 * credentials — see `pipeline-phases/spring-config.ts`), so there is nothing to
 * substitute. The KEY comes back instead, so the caller can link the node to
 * the `Property` nodes for that key without learning its value.
 *
 * A default that itself contains `${` is not expanded: nested placeholders
 * would need the same configuration this module refuses to read, and expanding
 * only the outer level would produce a half-substituted string that looks like
 * an address. The inner key is reported unresolved instead.
 */
export function resolveSpringPlaceholders(value: string): SpringPlaceholderResult {
  if (!value.includes('${')) return { plain: true };
  let out = '';
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf('${', index);
    if (start === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, start);
    let depth = 1;
    let cursor = start + 2;
    while (cursor < value.length && depth > 0) {
      if (value.startsWith('${', cursor)) {
        depth += 1;
        cursor += 2;
        continue;
      }
      if (value[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    // An unterminated `${` is not a placeholder this module can read. Treating
    // the tail as a literal would mint an address containing `${`.
    if (depth > 0) return { plain: false, unresolvedKey: value.slice(start + 2) };
    const body = value.slice(start + 2, cursor - 1);
    const separator = body.indexOf(':');
    // Spring splits on the FIRST colon, so `${a:b:c}` defaults to `b:c`.
    const key = (separator === -1 ? body : body.slice(0, separator)).trim();
    if (separator === -1) return { plain: false, unresolvedKey: key };
    const fallback = body.slice(separator + 1);
    if (fallback.includes('${')) return { plain: false, unresolvedKey: key };
    out += fallback;
    index = cursor;
  }
  return { plain: false, value: out };
}

// ── The cascade ────────────────────────────────────────────────────────────

/**
 * Resolve one candidate to an address, or to a named refusal.
 *
 * Four steps, in this order, each of which may decline:
 *
 *  1. literal        — `"orders.v1"`, including one element of an array form.
 *  2. constant       — `Topics.ORDERS`, through the supplied constant resolver.
 *  3. configuration  — `${app.topic:orders}` resolves to its SOURCE-written
 *                      default; `${app.topic}` does not resolve and reports the
 *                      key instead.
 *  4. specification  — the deferred seam; see {@link SpringDestinationResolvers}.
 *
 * Steps 1 and 2 both feed step 3: a literal may be a placeholder, and so may
 * the value a constant folds to (`static final String TOPIC = "${app.topic}"`
 * is an ordinary way to write one). Skipping step 3 after step 2 would file
 * that constant's placeholder text as a resolved address — the exact false
 * identity this module exists to prevent, arrived at one step later.
 */
export function resolveSpringDestination(
  candidate: SpringDestinationCandidate,
  resolvers: SpringDestinationResolvers = {},
): SpringDestinationResolution {
  const specification = (): SpringDestinationResolution | null => {
    const resolved = resolvers.specification?.(candidate);
    if (resolved === undefined || resolved === null || resolved === '') return null;
    return { kind: 'resolved', address: resolved, via: 'specification' };
  };

  const literal = parseSpringStringLiteral(candidate.rawText);
  if (literal !== null) {
    return finish(literal, 'literal', specification);
  }

  const trimmed = candidate.rawText.trim();
  if (CONSTANT_REFERENCE.test(trimmed)) {
    const folded = resolvers.constant?.(trimmed.replace(/\s*\.\s*/g, '.')) ?? null;
    if (folded === null)
      return specification() ?? { kind: 'unresolved', reason: 'unresolved-constant' };
    return finish(folded, 'constant', specification);
  }

  return specification() ?? { kind: 'unresolved', reason: 'not-a-literal-or-constant' };
}

function finish(
  value: string,
  via: 'literal' | 'constant',
  specification: () => SpringDestinationResolution | null,
): SpringDestinationResolution {
  const placeholders = resolveSpringPlaceholders(value);
  if (placeholders.unresolvedKey !== undefined) {
    return (
      specification() ?? {
        kind: 'unresolved',
        reason: 'unresolved-config-key',
        configKey: placeholders.unresolvedKey,
      }
    );
  }
  const address = placeholders.plain ? value : (placeholders.value as string);
  if (address.trim() === '') {
    return specification() ?? { kind: 'unresolved', reason: 'empty-address' };
  }
  return { kind: 'resolved', address, via: placeholders.plain ? via : 'config-default' };
}

/**
 * Expand one accepted argument into per-element candidates.
 *
 * An empty list is a refusal rather than zero silent candidates: `topics = {}`
 * is a listener that names nothing, which is a finding, not an absence.
 */
function pushElements(
  candidates: SpringDestinationCandidate[],
  refusals: SpringDestinationRefusalRecord[],
  base: Omit<SpringDestinationCandidate, 'elementIndex'>,
): void {
  const elements = splitSpringDestinationList(base.rawText);
  if (elements.length === 0) {
    refusals.push({
      role: base.role,
      source: base.source,
      broker: base.broker,
      reason: 'empty-destination-list',
      rawText: base.rawText,
      argIndex: base.argIndex,
      ...(base.argName === undefined ? {} : { argName: base.argName }),
    });
    return;
  }
  for (const [elementIndex, element] of elements.entries()) {
    candidates.push({ ...base, rawText: element, elementIndex });
  }
}
