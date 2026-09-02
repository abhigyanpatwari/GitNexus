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

/**
 * Broker family behind a destination, as far as the syntax can attest.
 *
 * Part of the `Destination` node IDENTITY, not merely a label on it: the phase
 * keys a resolved node by `(broker, address)` via the framework-neutral
 * `ingestion/destination-key.ts`, so two brokers claiming one address are two
 * ordinary nodes. Adding or renaming a member here therefore re-keys every node
 * it applies to, which a full re-index absorbs and an incremental one does not
 * — the destination layer is delete-alled and rebuilt graph-wide on every
 * incremental writeback for exactly this class of reason.
 *
 * A member is only added when the SYNTAX attests to it. A guess here becomes a
 * guess in the identity, and the cost of a wrong one is a real pair split in
 * two (see `destinationNodeKey` for why that cost is nonetheless the cheaper
 * of the two failures available).
 */
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
 *
 * Members are split rather than merged wherever the two causes are different
 * FACTS about the repository. The unresolved fraction is only useful if its
 * breakdown says what to go and fix, and a bucket that means "either the
 * capture could not read this or the source really did write it that way"
 * answers neither question.
 */
export type SpringDestinationRefusal =
  /** The annotation is a recognized listener but its arguments were never read
   *  — a CAPTURE limitation, not a statement about the source. */
  | 'annotation-arguments-unavailable'
  /** The annotation's argument list was read and it was EMPTY: `@KafkaListener`
   *  with no elements at all. A real source-level gap, and deliberately not the
   *  same bucket as `annotation-arguments-unavailable` — see
   *  `SpringNonHttpHandlerAnnotationFact.args`, which keeps absent and `[]`
   *  apart precisely so a consumer of the fact does not have to guess. */
  | 'annotation-arguments-empty'
  /** Recognized listener, argument list present, no element names a destination. */
  | 'no-destination-argument'
  /** `@KafkaListeners({@KafkaListener(...), ...})` and its siblings. The
   *  container's single argument is a list of NESTED annotations, and capture
   *  does not descend into them, so their destinations are unreadable here.
   *  Recorded rather than skipped: a repository using repeated-listener
   *  containers loses real destinations, and that has to show up in the count
   *  instead of looking like a repository with no listeners. */
  | 'repeated-listener-container'
  /** `@KafkaListener(topicPattern = ...)` — a regex over topics, not an address. */
  | 'topic-pattern'
  /** A destination form this module deliberately does not read, e.g.
   *  `@RabbitListener(bindings = @QueueBinding(...))` or `topicPartitions`. */
  | 'unsupported-annotation-argument'
  /** A Kotlin trailing-lambda call: the publish has no argument list at all. */
  | 'producer-arguments-unavailable'
  /** The call's arity matches none of the overloads that carry a destination. */
  | 'producer-arity-unrecognized'
  /** The call used NAMED arguments and none of them names a destination
   *  parameter this module knows. Selecting by position instead would read
   *  whatever the author happened to write first — see
   *  {@link selectProducerDestinationArguments}. */
  | 'producer-named-argument-unrecognized'
  /** `rabbitTemplate.convertAndSend(message)` — default exchange, empty routing
   *  key. There is no address in the source to record. */
  | 'rabbit-default-exchange'
  /** The argument in the destination position is not shaped like an address
   *  (not a string literal, not a constant reference) — most often because the
   *  overload actually taken has the payload there. */
  | 'producer-argument-not-address-shaped'
  /** Two overloads fit the call, they disagree about which slot is the address,
   *  and the argument is spelled the same way under both readings. The
   *  archetype is `convertAndSend("orders.rk", "body", correlationData)`: it is
   *  `(exchange, routingKey, message)` with the address `"body"`, or
   *  `(routingKey, message, correlationData)` with the address `"orders.rk"`
   *  and `"body"` as a String PAYLOAD. Both are real overloads spelled
   *  (String, String, ref).
   *
   *  Distinct from `producer-argument-not-address-shaped`, which says the slot
   *  cannot hold an address at all. This one says it can, twice, and the module
   *  will not pick — a payload published as an address joins a consumer of a
   *  queue that happens to be named after the payload's text. */
  | 'ambiguous-producer-overload'
  /** `topics = {}` / `topics = []` / `arrayOf()`. */
  | 'empty-destination-list'
  /** The element is an expression this module will not evaluate — a
   *  concatenation, a call, a ternary. */
  | 'not-a-literal-or-constant'
  /** A constant reference no constant resolver could fold to a string. */
  | 'unresolved-constant'
  /** `#{...}` — a SpEL expression, evaluated by the container against beans and
   *  the environment at RUNTIME. `#{@kafkaProps.ordersTopic}` is the archetypal
   *  unresolvable address: nothing in the source says what it evaluates to, and
   *  two services that merely wrote the same expression have said nothing about
   *  each other. */
  | 'spel-expression'
  /** An unescaped `$` interpolation in a language whose string literals
   *  interpolate. In Kotlin `"orders-$env"` and `"orders-${env}"` are STRING
   *  TEMPLATES evaluated at runtime, not addresses and not Spring placeholders
   *  — the escaped `"\${app.topic}"` is how a Spring placeholder has to be
   *  written there. Java does not interpolate, so `$` is an ordinary character
   *  and this never fires for it. */
  | 'unescaped-interpolation'
  /** `${key}` with no default. The KEY is recorded; the VALUE is deliberately
   *  absent from the graph (config values may hold credentials — see the header
   *  of `pipeline-phases/spring-config.ts`), so this can never resolve here. */
  | 'unresolved-config-key'
  /** `${key:default}`. The default IS written in the source, and it is kept on
   *  the node — but it is not an IDENTITY. It holds only while the key is not
   *  overridden in configuration, and configuration VALUES are deliberately
   *  absent from this graph, so the code cannot know whether it holds. Keying
   *  on it merges every service that copy-pasted the same fallback: `${a:events}`
   *  and `${b:events}` are two different addresses that happen to share a
   *  default. Both the key and the default text survive as properties, so the
   *  case stays countable and distinguishable from a bare `${key}`. */
  | 'overridable-config-default'
  /** `${}` — a placeholder that names no key. There is nothing to record and
   *  nothing to look up; kept separate so an empty key never reaches the
   *  `Property` lookup as if it were a real one. */
  | 'empty-config-key'
  /** A string literal that is empty or nothing but whitespace. An empty address
   *  addresses nothing, and letting it through would give every such site one
   *  shared `''` identity — the same false join the placeholder rule prevents. */
  | 'empty-literal-address'
  /** A constant reference that folded to an empty or whitespace-only string.
   *  Same outcome as `empty-literal-address`, different repository fact: there
   *  the source wrote `""`, here a constant declaration did. */
  | 'empty-constant-address';

/**
 * How an address was arrived at, kept on the node for provenance.
 *
 * There is deliberately no `config-default` member. A `${key:default}` does not
 * resolve — see `overridable-config-default` — so no address can be reached
 * that way.
 */
export type SpringDestinationVia = 'literal' | 'constant' | 'specification';

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
      /** Default text of a `${key:default}`, exactly as the source wrote it.
       *  Kept as PROVENANCE only — it is never an address and never a key, for
       *  the reason `overridable-config-default` gives. */
      readonly configDefault?: string;
    };

/**
 * The cascade's pluggable steps plus the one language capability it needs.
 *
 * The steps are supplied by the phase, which owns the language-specific
 * machinery; keeping them as callbacks is what lets this module stay
 * language-neutral and testable with a plain map.
 */
export interface SpringDestinationResolvers {
  /**
   * Whether the owning language INTERPOLATES string literals — Kotlin does,
   * Java does not. A capability, deliberately not a language name: shared
   * ingestion code may not branch on a language (see AGENTS.md), and the
   * capability is also the thing that actually matters. Supplied alongside
   * `getSpringMessagingFacts` by the provider and threaded in by the phase.
   *
   * When true, an unescaped `$` inside a literal is a runtime template and the
   * candidate is refused. When false (the default) `$` is an ordinary
   * character and `"${app.topic}"` is a Spring placeholder.
   */
  readonly interpolatesStringLiterals?: boolean;
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
 * here to read.
 *
 * They are recognized rather than ignored so the loss is COUNTED. A repository
 * that declares its listeners this way really does lose those destinations, and
 * returning an empty selection would make it indistinguishable from a
 * repository with no listeners at all — the module header promises that every
 * path which declines to produce an address records why, and an empty
 * `refusals` array records nothing. The broker comes from the container's own
 * name, which is the one thing the annotation does state.
 */
const CONSUMER_CONTAINER_ANNOTATIONS: ReadonlyMap<string, SpringDestinationBroker> = new Map([
  ['KafkaListeners', 'kafka' as const],
  ['RabbitListeners', 'rabbit' as const],
  ['JmsListeners', 'jms' as const],
  ['PulsarListeners', 'pulsar' as const],
]);

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
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
  const containerBroker = CONSUMER_CONTAINER_ANNOTATIONS.get(name);
  if (containerBroker !== undefined) {
    return {
      candidates: [],
      refusals: [
        {
          role: 'consumer',
          source: name,
          broker: containerBroker,
          reason: 'repeated-listener-container',
          ...(args === undefined || args[0] === undefined ? {} : { rawText: args[0].text }),
        },
      ],
    };
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

  // ABSENT arguments are a capture limitation: the annotation was recognized
  // but its argument list was never read (see
  // `SpringNonHttpHandlerAnnotationFact.args`). An empty ARRAY is a different
  // fact entirely — an argument list WAS read and it was empty, so the source
  // really does declare a listener that names no destination. Capture keeps the
  // two apart on purpose, the producer side of this module already does, and
  // merging them here would file a source-level gap under a tooling gap and
  // corrupt the one breakdown this feature is measured on.
  if (args === undefined) {
    refuse('annotation-arguments-unavailable');
    return { candidates: [], refusals };
  }
  if (args.length === 0) {
    refuse('annotation-arguments-empty');
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
 * Parameter names that carry a destination, per template, for calls that pass
 * their arguments BY NAME.
 *
 * Kotlin call sites may name arguments, and a named argument list is in source
 * order, not parameter order — `send(data = payload, topic = "orders")` is
 * legal and puts the payload in slot 0. Reading slot 0 there publishes the
 * PAYLOAD as an address. The name is captured
 * ({@link SpringArgumentFact.name}), so the honest rule is to use it: select by
 * name when there is one, and refuse when the names present say nothing this
 * module recognizes. Selecting by position while ignoring a name that
 * contradicts it is the one option that is never defensible.
 *
 * `exchange` is listed for rabbit but is NOT an address — it is the companion
 * provenance the routing key carries (see the arity notes below).
 */
const PRODUCER_DESTINATION_PARAMETERS: Readonly<
  Record<SpringMessageProducerTemplate, readonly string[]>
> = {
  kafka: ['topic'],
  // `RabbitTemplate.convertAndSend(String exchange, String routingKey, Object message, …)`.
  rabbit: ['routingKey'],
  // `JmsTemplate.convertAndSend(Destination destination, …)` and the
  // `String destinationName` overloads.
  jms: ['destination', 'destinationName'],
  // `StreamBridge.send(String bindingName, Object data, …)`.
  'stream-bridge': ['bindingName'],
};

/** Rabbit's exchange parameter, carried as provenance rather than as an address. */
const RABBIT_EXCHANGE_PARAMETER = 'exchange';

/**
 * Choose the destination-bearing arguments of one messaging-template publish.
 *
 * A NAME beats a position, arity decides where it can decide, and shape decides
 * where it cannot.
 *
 * When any argument is passed by name, {@link PRODUCER_DESTINATION_PARAMETERS}
 * decides — position is not consulted at all, because a named argument list
 * need not be in parameter order. When the slot this module would have read
 * positionally is itself named with something it does not recognize, that is a
 * contradiction and the publish is refused rather than read.
 *
 * `KafkaTemplate.send` and `StreamBridge.send` put the destination first in
 * every multi-argument positional overload they have, so once such a call has
 * two or more arguments its slot 0 is the destination and nothing further needs
 * deciding. Those slots use the PERMISSIVE gate ({@link isAddressShaped}): a
 * bare identifier is let through to the cascade, which refuses it by name if no
 * constant folds. That keeps `unresolved-constant` — a thing we tried to
 * resolve — distinct from `producer-argument-not-address-shaped`, a thing we
 * declined to read at all.
 *
 * The `convertAndSend` families are different. Both admit trailing
 * `MessagePostProcessor` and `CorrelationData` parameters, and arity does not
 * separate the overloads in EITHER direction:
 *
 *   jms    (destination, message)                2  vs (message, postProcessor)          2
 *   rabbit (routingKey, message)                 2  vs (message, postProcessor)          2
 *   rabbit (exchange, routingKey, message)       3  vs (routingKey, message, pp)         3
 *                                                   vs (routingKey, message, correlation) 3
 *   rabbit (exchange, routingKey, message, pp)   4  vs (routingKey, message, pp, corr)   4
 *
 * So the tie is broken by the STRICT gate ({@link isConfidentAddressShape}) — a
 * string literal, a qualified reference, or a screaming-snake constant, all of
 * which a payload variable is not. A lowercase bare identifier is NOT confident
 * evidence, so `convertAndSend(topic, payload)` is refused rather than read:
 * the same spelling is how a payload variable looks, and nothing in the syntax
 * separates them. That refusal is the deliberate cost. A refusal is counted and
 * recoverable; a wrong address enters reports as a fact.
 *
 * There is NO positional fallback at rabbit arity 3+. An earlier revision fell
 * back to accepting slot 0 when slot 1 was not confident, which turned the
 * ordinary `convertAndSend(EXCHANGE, routingKey, event)` — routing key in a
 * variable — into a destination whose address was the EXCHANGE NAME. That is
 * the worst possible outcome: an address that looks entirely plausible and can
 * join a `@RabbitListener(queues = "orders")` that has nothing to do with it.
 *
 * ── THE ONE AMBIGUITY, REFUSED RATHER THAN GUESSED ───────────────────────
 *
 * `convertAndSend("orders.rk", "body", correlationData)` fits two overloads at
 * once and they disagree about which slot is the address:
 *
 *     (exchange, routingKey, message)          → the address is `"body"`
 *     (routingKey, message, correlationData)   → the address is `"orders.rk"`
 *
 * Both are real, both are spelled (String, String, ref), and no rule over the
 * syntax separates them. Picking either one publishes the OTHER reading's
 * payload as an address, where a consumer of a queue named after that text
 * joins a publisher that never wrote to it. So neither is picked: the call is
 * refused as `ambiguous-producer-overload` and yields no candidate and no edge.
 *
 * The refusal is narrow on purpose, because over-refusing here costs the
 * ordinary case, and a suppression that eats correct results is the more
 * expensive mistake. It fires ONLY on a STRING LITERAL in slot 1, at the
 * arities where a competing overload exists:
 *
 *   - A literal is no evidence at all. An address and a payload are BOTH
 *     ordinarily written as literals, so the spelling distinguishes nothing.
 *   - A CONSTANT or QUALIFIED reference is evidence, which is the whole premise
 *     of {@link isConfidentAddressShape}: `ORDERS_ROUTING_KEY` and
 *     `Topics.ORDERS_KEY` are how a configured NAME is written, not how a
 *     payload computed at the call site is. Those keep resolving.
 *   - Arity 5 has no competing overload at all —
 *     `(exchange, routingKey, message, pp, correlationData)` is the only
 *     five-argument form — so slot 1 there is the routing key whatever it is
 *     spelled like, and the refusal must not reach it.
 *   - A NAMED argument settles the reading outright, and the name-beats-position
 *     pre-pass above has already returned by then.
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
  /**
   * Accept a slot chosen by POSITION.
   *
   * Refuses when the argument in that slot carries a name — a named list need
   * not be in parameter order, so a name in the destination slot that is not a
   * destination parameter contradicts the position, and reading the position
   * anyway is how `send(data = "payload", topic = "orders")` published the
   * payload. The name-matching pre-pass above has already had its chance.
   */
  const acceptPositional = (argIndex: number, exchange?: string): void => {
    const arg = args[argIndex] as SpringArgumentFact;
    if (arg.name !== undefined) {
      refuse('producer-named-argument-unrecognized', {
        rawText: arg.text,
        argIndex,
        argName: arg.name,
      });
      return;
    }
    accept(argIndex, exchange);
  };
  const textAt = (index: number): string => (args[index] as SpringArgumentFact).text;
  const confident = (index: number): boolean =>
    index < args.length && isConfidentAddressShape(textAt(index));
  const refuseShape = (index: number): void => {
    refuse('producer-argument-not-address-shaped', { rawText: textAt(index), argIndex: index });
  };

  // ── A name beats a position ─────────────────────────────────────────────
  // When an argument names a destination parameter, that argument IS the
  // destination wherever it sits in the list. Only when no name matches does
  // the positional reasoning below run, and `acceptPositional` then refuses if
  // the slot it lands on turns out to be named after something else.
  const destinationNames = PRODUCER_DESTINATION_PARAMETERS[fact.template];
  const namedIndex = args.findIndex(
    (arg) => arg.name !== undefined && destinationNames.includes(arg.name),
  );
  if (namedIndex !== -1) {
    const exchangeIndex =
      fact.template === 'rabbit'
        ? args.findIndex((arg) => arg.name === RABBIT_EXCHANGE_PARAMETER)
        : -1;
    accept(
      namedIndex,
      exchangeIndex === -1 ? undefined : unquoteForProvenance(textAt(exchangeIndex)),
    );
    return { candidates, refusals };
  }

  if (fact.template === 'rabbit') {
    // `convertAndSend` overloads, by what occupies the leading slots:
    //   (message)                                  → default exchange, no address
    //   (routingKey, message)                      → arg0 is the routing key
    //   (message, postProcessor)                   → NO address, same arity
    //   (exchange, routingKey, message)            → arg0 + arg1
    //   (routingKey, message, postProcessor)       → arg0 only, same arity
    //   (routingKey, message, correlationData)     → arg0 only, same arity
    //   (exchange, routingKey, message, pp)        → arg0 + arg1
    //   (routingKey, message, pp, correlationData) → arg0 only, same arity
    //   (exchange, routingKey, message, pp, corr)  → arg0 + arg1
    if (args.length === 1) {
      refuse('rabbit-default-exchange', { rawText: textAt(0), argIndex: 0 });
      return { candidates, refusals };
    }
    if (args.length === 2) {
      // (routingKey, message) versus (message, postProcessor).
      if (confident(0)) {
        acceptPositional(0);
        return { candidates, refusals };
      }
      refuseShape(0);
      return { candidates, refusals };
    }
    // Three arguments and up. Arity separates almost nothing here — three and
    // four both admit an exchange form and a routing-key form — so the ONLY
    // acceptance is confident evidence in slot 1, and there is no positional
    // fallback. `convertAndSend(EXCHANGE, routingKey, event)` fails that test
    // and is refused; the discarded fallback published `EXCHANGE` as the
    // address, which is a wrong answer wearing the costume of a right one.
    //
    // And confident evidence in slot 1 is not enough when the evidence is a
    // STRING LITERAL: under the competing overload that same literal is the
    // String PAYLOAD, and the two readings are spelled identically. See the
    // ambiguity section in this function's doc comment for why this is a
    // refusal rather than a choice, and for each of the three cases it must not
    // touch — a constant in slot 1 (spelling that IS evidence), arity 5 (no
    // competing overload exists), and a named argument (already returned
    // above, and its name settles the reading).
    const competingOverload = args.length === 3 || args.length === 4;
    if (
      competingOverload &&
      args[1]?.name === undefined &&
      parseSpringStringLiteral(textAt(1)) !== null
    ) {
      refuse('ambiguous-producer-overload', { rawText: textAt(1), argIndex: 1 });
      return { candidates, refusals };
    }
    if (confident(1)) {
      // The ADDRESS is the routing key. The exchange rides along as provenance
      // on the edge rather than becoming part of the address: composing
      // `exchange/routingKey` would invent a spelling no consumer ever writes,
      // and a `@RabbitListener` names a QUEUE, so the two sides do not join on
      // the exchange anyway. Which queue an exchange/key pair reaches is decided
      // by bindings this index does not read.
      acceptPositional(1, unquoteForProvenance(textAt(0)));
      return { candidates, refusals };
    }
    refuseShape(1);
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
  acceptPositional(0);
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

/**
 * ONE string literal, whole.
 *
 * The triple-quoted alternative excludes `"""` from its body rather than
 * matching greedily: `"""a""" + """b"""` is a concatenation, not a literal, and
 * a greedy body swallowed the operator and folded it to the single address
 * `a""" + """b`. Excluding the terminator makes the whole-string anchor fail
 * there, so the text falls through to the constant test and is refused as
 * `not-a-literal-or-constant`, which is what it is.
 */
const STRING_LITERAL =
  /^(?:"""((?:(?!""")[\s\S])*)"""|"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)')$/;

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
 *
 * The unescaping is also why {@link hasUnescapedStringInterpolation} has to run
 * against the RAW text: once `\$` has become `$`, the escaped placeholder and
 * the runtime template are the same string.
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

/** `$` followed by a brace or an identifier start — the two template forms. */
const INTERPOLATION_START = /^[{A-Za-z_]/;

/**
 * Whether a string literal contains an UNESCAPED interpolation, for a language
 * whose literals interpolate.
 *
 * Only meaningful for such a language; Java never calls it. In Kotlin:
 *
 *     "orders-$env"        template — the value is decided at runtime
 *     "orders-${env}"      template — NOT a Spring placeholder
 *     "\${app.topic}"      escaped  — this is how a Spring placeholder is written
 *     """orders-$env"""    template — raw strings interpolate and cannot escape
 *
 * Reads the RAW literal text on purpose: {@link parseSpringStringLiteral}
 * resolves `\$` to `$`, after which the second and third rows above are the
 * same string and the distinction is gone. A raw (`"""`) literal has no
 * backslash escapes at all — `${'$'}` is the only way to write a dollar there —
 * so every `$` in one is an interpolation.
 */
export function hasUnescapedStringInterpolation(text: string): boolean {
  const trimmed = text.trim();
  const match = STRING_LITERAL.exec(trimmed);
  if (match === null) return false;
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  const escapable = match[1] === undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (escapable && char === '\\') {
      index += 1;
      continue;
    }
    if (char === '$' && INTERPOLATION_START.test(raw.slice(index + 1))) return true;
  }
  return false;
}

/** `#{...}` — a SpEL expression the container evaluates at runtime. */
function containsSpelExpression(value: string): boolean {
  return value.includes('#{');
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
  /** True when the text contained no `${…}` at all. */
  readonly plain: boolean;
  /** Key of the FIRST placeholder, in source order. Present whenever `plain`
   *  is false; the empty string when the placeholder named no key (`${}`). */
  readonly key?: string;
  /** Default text of that placeholder, exactly as written, when it had one.
   *  Absent for a bare `${key}`. The empty string for `${key:}`, which is a
   *  default that was written and is empty. */
  readonly defaultValue?: string;
}

/**
 * Read the FIRST Spring property placeholder out of an already-unquoted value.
 *
 * NOTHING IS SUBSTITUTED, and that is the rule, not an omission.
 *
 * `${key}` cannot resolve: the value lives in a configuration file this index
 * deliberately does not read into the graph (values may hold credentials — see
 * `pipeline-phases/spring-config.ts`). The KEY comes back instead, so the
 * caller can link the node to the `Property` nodes for that key without ever
 * learning its value.
 *
 * `${key:default}` cannot resolve EITHER, which is a correction to this
 * module's original rule. The default is written in the source, so reading it
 * is legitimate and it is returned — but it is provenance, never an identity.
 * A default holds only while the key is not overridden, and whether it is
 * overridden is a fact about configuration VALUES, which are absent from this
 * graph by design. Substituting it made `${a.topic:events}` and
 * `${b.topic:events}` one node and reported a producer/consumer pair between
 * two services that shared nothing but a copy-pasted fallback. The same
 * reasoning applies to any placeholder-derived value: a value the configuration
 * can override is not an identity.
 *
 * Only the first placeholder is read because there is nothing to do with the
 * rest — the value is already unresolvable, and the first key is the one a
 * reader would look up. A nested default (`${a:${b}}`) needs no special case
 * under this rule: `a` is the key and `${b}` is the default text, both reported
 * as written.
 */
export function resolveSpringPlaceholders(value: string): SpringPlaceholderResult {
  const start = value.indexOf('${');
  if (start === -1) return { plain: true };
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
  // the tail as a literal would mint an address containing `${`; treating it as
  // a key at least names the thing the author was reaching for.
  if (depth > 0) return { plain: false, key: value.slice(start + 2).trim() };
  const body = value.slice(start + 2, cursor - 1);
  const separator = body.indexOf(':');
  // Spring splits on the FIRST colon, so `${a:b:c}` defaults to `b:c`.
  if (separator === -1) return { plain: false, key: body.trim() };
  return {
    plain: false,
    key: body.slice(0, separator).trim(),
    defaultValue: body.slice(separator + 1),
  };
}

// ── The cascade ────────────────────────────────────────────────────────────

/**
 * Resolve one candidate to an address, or to a named refusal.
 *
 * Four steps, in this order, each of which may decline:
 *
 *  1. literal        — `"orders.v1"`, including one element of an array form.
 *  2. constant       — `Topics.ORDERS`, through the supplied constant resolver.
 *  3. configuration  — neither `${app.topic}` nor `${app.topic:orders}`
 *                      resolves; the key, and the default text when there is
 *                      one, are reported instead.
 *  4. specification  — the deferred seam; see {@link SpringDestinationResolvers}.
 *
 * Steps 1 and 2 both feed step 3: a literal may be a placeholder, and so may
 * the value a constant folds to (`static final String TOPIC = "${app.topic}"`
 * is an ordinary way to write one). Skipping step 3 after step 2 would file
 * that constant's placeholder text as a resolved address — the exact false
 * identity this module exists to prevent, arrived at one step later.
 *
 * Two classes of text are rejected BEFORE step 3, because they are not
 * addresses in any configuration: a SpEL expression, which the container
 * evaluates against live beans, and an unescaped string-template interpolation
 * in a language that interpolates. Order matters between them and the
 * placeholder rule — `"#{'${app.topics}'.split(',')}"` contains a `${` and
 * would otherwise be filed under a configuration key that is not really what
 * it is.
 *
 * WHITESPACE. An address is kept exactly as the source wrote it, `" orders "`
 * included, so `" orders "` is its own node and does not join `"orders"`. That
 * is a missing connection rather than a false one, which is the trade this
 * module makes everywhere. The emptiness test below trims, because a
 * whitespace-only address addresses nothing — the two rules disagree on
 * purpose, and this is the statement of it.
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
    // The raw spelling, not the unquoted value: unquoting has already turned
    // `\$` into `$` and the escaped placeholder into the runtime template.
    if (
      resolvers.interpolatesStringLiterals === true &&
      hasUnescapedStringInterpolation(candidate.rawText)
    ) {
      return specification() ?? { kind: 'unresolved', reason: 'unescaped-interpolation' };
    }
    return finish(literal, 'literal', specification);
  }

  const trimmed = candidate.rawText.trim();
  if (CONSTANT_REFERENCE.test(trimmed)) {
    const folded = resolvers.constant?.(trimmed.replace(/\s*\.\s*/g, '.')) ?? null;
    if (folded === null)
      return specification() ?? { kind: 'unresolved', reason: 'unresolved-constant' };
    // A folded value has already lost its escapes, so an interpolating language
    // cannot tell `"\${app.topic}"` from `"${app.topic}"` here the way the
    // literal branch can. Both are unresolved either way, so the cost is a
    // reason filed under `unescaped-interpolation` that might have belonged
    // under `unresolved-config-key` — never a false address.
    //
    // A LIVE PATH, not a guard for the future. Kotlin both interpolates and
    // supplies a constant fold — `languages/kotlin.ts` declares
    // `extractModuleConstants` and `foldRoutePathOperands`, and
    // `spring-destinations.ts` hands the fold to this cascade — so a Kotlin
    // constant reaching this branch is an ordinary occurrence and the misfiled
    // reason above is a cost actually paid. Fixing it means teaching the fold
    // to report whether the value it returned was escaped at its declaration,
    // which the shared `ModuleConstants` shape does not carry.
    if (resolvers.interpolatesStringLiterals === true && /\$[{A-Za-z_]/.test(folded)) {
      return specification() ?? { kind: 'unresolved', reason: 'unescaped-interpolation' };
    }
    return finish(folded, 'constant', specification);
  }

  return specification() ?? { kind: 'unresolved', reason: 'not-a-literal-or-constant' };
}

function finish(
  value: string,
  via: 'literal' | 'constant',
  specification: () => SpringDestinationResolution | null,
): SpringDestinationResolution {
  const decline = (
    reason: SpringDestinationRefusal,
    extra: { configKey?: string; configDefault?: string } = {},
  ): SpringDestinationResolution =>
    specification() ?? {
      kind: 'unresolved',
      reason,
      ...(extra.configKey === undefined ? {} : { configKey: extra.configKey }),
      ...(extra.configDefault === undefined ? {} : { configDefault: extra.configDefault }),
    };

  // Before the placeholder rule: a SpEL expression may CONTAIN a `${…}`, and
  // calling that a configuration key would name the wrong diagnosis.
  if (containsSpelExpression(value)) return decline('spel-expression');

  const placeholders = resolveSpringPlaceholders(value);
  if (!placeholders.plain) {
    const key = placeholders.key ?? '';
    if (key === '') return decline('empty-config-key');
    if (placeholders.defaultValue !== undefined) {
      return decline('overridable-config-default', {
        configKey: key,
        configDefault: placeholders.defaultValue,
      });
    }
    return decline('unresolved-config-key', { configKey: key });
  }

  if (value.trim() === '') {
    return decline(via === 'literal' ? 'empty-literal-address' : 'empty-constant-address');
  }
  return { kind: 'resolved', address: value, via };
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
