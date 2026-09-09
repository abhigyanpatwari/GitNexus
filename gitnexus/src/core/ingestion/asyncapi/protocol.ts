/**
 * AsyncAPI protocol name → broker identity, for `destinationNodeKey`.
 *
 * Deliberately OUTSIDE `frameworks/spring/`, like `destination-key.ts` and for
 * the same reason: an AsyncAPI document is not a Spring artifact, and the
 * broker it names has to be mintable by anything that reads one.
 *
 * ── TWO READERS, TWO RULES, AND WHY THEY ARE NOT THE SAME RULE ────────────
 *
 * A document states its protocol in two places, and they have opposite
 * defaults:
 *
 *   `servers[].protocol` is a FIELD DECLARED TO HOLD A PROTOCOL. Whatever it
 *   contains is the document's claim about its broker, including a protocol
 *   this codebase has never heard of. {@link brokerForProtocol} therefore
 *   passes an unrecognized value through as its own literal — an `mqtt` or
 *   `nats` channel mints `mqtt <address>` and joins any other site that says
 *   the same thing, instead of being dropped for the sake of a closed union it
 *   was never going to fit. Refusing it would lose a destination the document
 *   states plainly, to protect against a collision that cannot happen: an
 *   unmapped protocol keys on its own name, so it can only meet a site that
 *   named the same protocol.
 *
 *   A `bindings` MAP KEY is not that. The map is keyed by protocol name BY
 *   CONVENTION, and the specification puts other things in the same namespace:
 *   `$ref` when the bindings are a Reference Object, and `x-` Specification
 *   Extensions, which generators emit routinely. Here a non-protocol key is the
 *   EXPECTED case, not the exotic one, so {@link brokerForBindingKey} answers
 *   only for names it recognizes.
 *
 * That asymmetry was learned the expensive way. An earlier version applied one
 * syntactic test to both and excluded only `$`-prefixed tokens; a document
 * carrying `bindings: { x-scs-function: … }` then minted
 * `Destination(broker='x-scs-function')`, so two unrelated services sharing a
 * vendor annotation and an address landed on ONE node with a broker half that
 * carried no broker information at all. Worse, `{ kafka: {}, x-internal: {} }`
 * read as two brokers and refused a conformant document as self-contradictory
 * — which also makes any writer of a document a one-line saboteur of its own
 * cross-service links. A list that must be extended when AsyncAPI adds a
 * binding is the smaller cost.
 *
 * ── WHY THE ALIASES EARN THEIR ROWS ───────────────────────────────────────
 *
 * `amqp` → `rabbit` is not an identity. AMQP is a wire protocol and RabbitMQ is
 * one implementation of it; a Qpid or ActiveMQ broker speaking AMQP is filed
 * under `rabbit` here and the label is wrong about the product. It is mapped
 * anyway because the alternative is a guaranteed MISS: Spring's own capture
 * calls `@RabbitListener` `rabbit`, so an `amqp` document describing the very
 * same queue would sit on a second node and the two would never meet. A label
 * that is wrong about the vendor but right about the protocol family joins the
 * pair; an honest `amqp` label splits it every time.
 *
 * The transport-security variants are that argument with the vendor doubt
 * removed. AsyncAPI's SERVER vocabulary distinguishes `kafka` from
 * `kafka-secure`; its BINDINGS vocabulary does not. Without these rows a
 * secured cluster's own document contradicts itself, and with bindings absent
 * it is worse and quieter: `kafka-secure <address>` never meets the
 * `kafka <address>` Spring capture mints, and nothing reports the miss. TLS is
 * a property of the connection, not of the place messages go.
 */

/**
 * A protocol name long enough to be a mistake.
 *
 * The broker is the THIRD string that reaches a graph identifier, alongside the
 * address and the operation id, and it is the one that was left unbounded:
 * `destinationNodeKey` is `` `${broker} ${address}` `` and `generateId` is
 * `` `${label}:${name}` `` — concatenation both, no hashing. A one-megabyte
 * protocol in a document that satisfies every other cap was measured producing
 * a gigabyte of resident identifier strings, because the phase mints one id per
 * node and one per edge. The longest name in AsyncAPI's vocabulary is
 * `googlepubsub` at twelve characters, so this bound is generous by more than a
 * factor of two and can only be reached on purpose.
 */
const MAX_PROTOCOL_LENGTH = 32;

/**
 * Spellings that differ between AsyncAPI's protocol vocabulary and the broker
 * names this codebase already mints from source.
 *
 * Both AMQP versions collapse: `amqp1` is AMQP 1.0, a different wire format for
 * the same family, and a service that documents one while its code speaks the
 * other is describing one queue, not two. `mqtt5` collapses onto `mqtt` for the
 * identical reason.
 */
const PROTOCOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['amqp', 'rabbit'],
  ['amqp1', 'rabbit'],
  ['kafka-secure', 'kafka'],
  ['secure-mqtt', 'mqtt'],
  ['mqtts', 'mqtt'],
  ['mqtt5', 'mqtt'],
  ['wss', 'ws'],
  ['stomps', 'stomp'],
  ['https', 'http'],
]);

/**
 * AsyncAPI's binding vocabulary — the names a `bindings` map key may take.
 *
 * Closed on purpose; see the header. Adding a protocol here is a deliberate
 * act, which is the point: the cost of a missing row is one document's
 * destinations, and the cost of an open door is a node keyed on a vendor
 * annotation that two unrelated services happen to share.
 */
const BINDING_PROTOCOLS: ReadonlySet<string> = new Set([
  'amqp',
  'amqp1',
  'anypointmq',
  'googlepubsub',
  'http',
  'https',
  'ibmmq',
  'jms',
  'kafka',
  'kafka-secure',
  'mercure',
  'mqtt',
  'mqtt5',
  'mqtts',
  'nats',
  'pulsar',
  'redis',
  'secure-mqtt',
  'sns',
  'solace',
  'sqs',
  'stomp',
  'stomps',
  'ws',
  'wss',
]);

/**
 * Protocols whose destinations this module refuses to mint, because the address
 * alone is not the thing that identifies them.
 *
 * For a broker, the topic or queue name IS the namespace: two services naming
 * `orders.v1` on Kafka are talking about one place, and dropping which cluster
 * they used is a bounded, stated trade. For HTTP and WebSocket the HOST is the
 * namespace and the address is only a path, so keying on the path alone makes
 * every service that exposes `/events` — or `/health`, or `/api/v1/orders` —
 * one node. That is unbounded, and it is a false join rather than a lost one.
 *
 * These are not lost information: an HTTP endpoint is a `Route`, which the
 * routes phase already models with the method in its key.
 */
const NON_DESTINATION_PROTOCOLS: ReadonlySet<string> = new Set(['http', 'ws']);

/**
 * Shape a protocol NAME must take, applied to both readers.
 *
 * The pass-through in {@link brokerForProtocol} is an argument about
 * UNRECOGNIZED protocols — a name this codebase has not heard of is still the
 * document's claim. It is not an argument about arbitrary text. A protocol name
 * contains no whitespace, and one that did would collide in the node key, since
 * `destinationNodeKey` joins broker and address with a space: `("kafka orders",
 * "x")` and `("kafka", "orders x")` are then the same node.
 *
 * Learned twice. The check was added when that collision was first shown to be
 * reachable, then dropped during a rewrite that moved the binding-key filtering
 * into its own function — and the test written for the first lesson caught the
 * second within the minute.
 */
function isProtocolToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9+._-]*$/.test(value);
}

function normalize(protocol: string | undefined): string | undefined {
  if (protocol === undefined) return undefined;
  const trimmed = protocol.trim().toLowerCase();
  if (trimmed === '' || trimmed.length > MAX_PROTOCOL_LENGTH) return undefined;
  if (!isProtocolToken(trimmed)) return undefined;
  return trimmed;
}

/** True when a broker names a transport whose addresses must not be keyed. */
export function isNonDestinationBroker(broker: string): boolean {
  return NON_DESTINATION_PROTOCOLS.has(broker);
}

/**
 * Normalize a `servers[].protocol` value to the broker half of a `Destination`
 * key. Unrecognized protocols pass through; see the header.
 *
 * Returns `undefined` for a blank or implausibly long value — silence is not a
 * claim, and a key built from an empty string would merge every silent
 * document.
 */
export function brokerForProtocol(protocol: string | undefined): string | undefined {
  const normalized = normalize(protocol);
  if (normalized === undefined) return undefined;
  return PROTOCOL_ALIASES.get(normalized) ?? normalized;
}

/**
 * Normalize a `bindings` MAP KEY to a broker, answering only for names in
 * AsyncAPI's binding vocabulary.
 *
 * `$ref` and `x-` extensions live in this namespace legitimately, so anything
 * unrecognized is silence rather than a broker.
 */
export function brokerForBindingKey(key: string | undefined): string | undefined {
  const normalized = normalize(key);
  if (normalized === undefined || !BINDING_PROTOCOLS.has(normalized)) return undefined;
  return PROTOCOL_ALIASES.get(normalized) ?? normalized;
}
