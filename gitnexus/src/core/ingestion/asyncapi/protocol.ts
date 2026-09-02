/**
 * AsyncAPI protocol name → broker identity, for `destinationNodeKey`.
 *
 * Deliberately OUTSIDE `frameworks/spring/`, like `destination-key.ts` and for
 * the same reason: an AsyncAPI document is not a Spring artifact, and the
 * broker it names has to be mintable by anything that reads one.
 *
 * ── WHY THE DEFAULT IS PASS-THROUGH, AND WHERE THAT STOPS ─────────────────
 *
 * The alias table holds only the cases where AsyncAPI and this codebase spell
 * the same broker differently. Everything else is passed through as its own
 * literal, because `destinationNodeKey` takes a plain `string` precisely so a
 * non-Spring caller can attest to a broker Spring has no member for. An `mqtt`
 * or `nats` channel therefore mints `mqtt <address>` and joins any other site
 * that says the same thing, instead of being dropped for the sake of a closed
 * union it was never going to fit.
 *
 * Refusing an unmapped protocol was the alternative, and it is worse in the
 * direction that matters: it loses a destination the document states plainly,
 * to protect against a collision that cannot happen — an unmapped protocol
 * keys on its own name, so it can only ever meet another site that named the
 * same protocol.
 *
 * That argument holds only while the value really is a protocol NAME, which is
 * why {@link isProtocolToken} exists. It is the one place the pass-through is
 * bounded, and both of the things it excludes are real:
 *
 *   `$ref`  — an AsyncAPI `bindings` value may be a Reference Object, so the
 *             map's own key can be `$ref` rather than a protocol. Passed
 *             through, that mints a `Destination` keyed `$ref <address>`: two
 *             unrelated services that both reference shared bindings and both
 *             name `orders` land on ONE node, and the broker half of the key —
 *             the thing that keeps `kafka orders` and `rabbit orders` apart —
 *             is carrying no information at all.
 *
 *   spaces  — `destinationNodeKey` joins with a space, so a broker containing
 *             one makes `("kafka orders", "x")` and `("kafka", "orders x")` the
 *             same key. That was latent while every broker came from Spring's
 *             closed union; this module is the first caller to feed the helper
 *             text a document wrote, which is exactly the condition under which
 *             it stops being latent. Rejecting the input here closes it without
 *             changing the shared key encoding — whether the delimiter itself
 *             should change is a separate question that also touches
 *             `routeNodeKey`, and it is not this module's to answer.
 *
 * ── THE ALIASES, AND WHY EACH ONE EARNS ITS ROW ───────────────────────────
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
 * The transport-security variants are the same argument with the vendor doubt
 * removed, and leaving them out was an inconsistency rather than a decision.
 * AsyncAPI's SERVER vocabulary distinguishes `kafka` from `kafka-secure`; its
 * BINDINGS vocabulary does not — the Kafka binding is `kafka` whatever the
 * transport. So a conformant document for a secured cluster names both
 * spellings of one broker and, without these rows, contradicts itself: the
 * two-source agreement rule reads `kafka-secure` against `kafka` and refuses
 * the operation as self-contradictory. With bindings absent it is worse and
 * quieter — `kafka-secure <address>` simply never meets the `kafka <address>`
 * that Spring capture mints, and nothing reports the miss, because two brokers
 * on one address is an ordinary two-node situation that needs no diagnosis.
 * TLS is a property of the connection, not of the place messages go.
 */

/**
 * Spellings that differ between AsyncAPI's protocol vocabulary and the broker
 * names this codebase already mints from source.
 *
 * Both AMQP versions collapse: `amqp1` is AMQP 1.0, a different wire format for
 * the same family, and a service that documents one while its code speaks the
 * other is describing one queue, not two.
 */
const PROTOCOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['amqp', 'rabbit'],
  ['amqp1', 'rabbit'],
  ['kafka-secure', 'kafka'],
  ['secure-mqtt', 'mqtt'],
  ['mqtts', 'mqtt'],
  ['wss', 'ws'],
  ['stomps', 'stomp'],
  ['https', 'http'],
]);

/**
 * Does this text name a protocol, as opposed to being some other map key that
 * happened to sit where a protocol name goes?
 *
 * Deliberately syntactic rather than an allowlist. An allowlist would have to
 * be revised for every protocol AsyncAPI adds, and a protocol missing from it
 * fails the same silent way an unmapped alias does — it loses a real
 * destination. This shape test admits anything spelled like a protocol token
 * and excludes the two things that are not: a `$`-prefixed reference field, and
 * anything containing whitespace or a separator that the node key reserves.
 */
function isProtocolToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9+._-]*$/.test(value);
}

/**
 * Normalize an AsyncAPI protocol to the broker half of a `Destination` key.
 *
 * Returns `undefined` for a blank protocol — silence is not a claim, and a key
 * built from an empty string would merge every silent document — and for text
 * that is not shaped like a protocol name at all.
 */
export function brokerForProtocol(protocol: string | undefined): string | undefined {
  if (protocol === undefined) return undefined;
  const normalized = protocol.trim().toLowerCase();
  if (normalized === '' || !isProtocolToken(normalized)) return undefined;
  return PROTOCOL_ALIASES.get(normalized) ?? normalized;
}
