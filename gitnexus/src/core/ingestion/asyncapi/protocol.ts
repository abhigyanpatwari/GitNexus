/**
 * AsyncAPI protocol name → broker identity, for `destinationNodeKey`.
 *
 * Deliberately OUTSIDE `frameworks/spring/`, like `destination-key.ts` and for
 * the same reason: an AsyncAPI document is not a Spring artifact, and the
 * broker it names has to be mintable by anything that reads one.
 *
 * ── WHY THIS MAP IS TINY, AND WHY THE DEFAULT IS PASS-THROUGH ─────────────
 *
 * The map holds only the cases where AsyncAPI and this codebase spell the same
 * broker differently. Everything else is passed through as its own literal,
 * because `destinationNodeKey` takes a plain `string` precisely so a non-Spring
 * caller can attest to a broker Spring has no member for. An `mqtt` or `nats`
 * channel therefore mints `mqtt <address>` and joins any other site that says
 * the same thing, instead of being dropped for the sake of a closed union it
 * was never going to fit.
 *
 * Refusing an unmapped protocol was the alternative, and it is worse in the
 * direction that matters: it loses a destination the document states plainly,
 * to protect against a collision that cannot happen — an unmapped protocol
 * keys on its own name, so it can only ever meet another site that named the
 * same protocol.
 *
 * ── THE ONE INFERENCE, NAMED ──────────────────────────────────────────────
 *
 * `amqp` → `rabbit` is not an identity. AMQP is a wire protocol and RabbitMQ is
 * one implementation of it; a Qpid or ActiveMQ broker speaking AMQP is filed
 * under `rabbit` here and the label is wrong about the product. It is mapped
 * anyway because the alternative is a guaranteed MISS: Spring's own capture
 * calls `@RabbitListener` `rabbit`, so an `amqp` document describing the very
 * same queue would sit on a second node and the two would never meet. A label
 * that is wrong about the vendor but right about the protocol family joins the
 * pair; an honest `amqp` label splits it every time.
 */

/**
 * Spellings that differ between AsyncAPI's protocol vocabulary and the broker
 * names this codebase already mints from source. Both AMQP versions collapse:
 * `amqp1` is AMQP 1.0, a different wire format for the same family, and a
 * service that documents one while its code speaks the other is describing one
 * queue, not two.
 */
const PROTOCOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['amqp', 'rabbit'],
  ['amqp1', 'rabbit'],
]);

/**
 * Normalize an AsyncAPI protocol to the broker half of a `Destination` key.
 *
 * Returns `undefined` for a blank protocol — silence is not a claim, and a key
 * built from an empty string would merge every silent document.
 */
export function brokerForProtocol(protocol: string | undefined): string | undefined {
  if (protocol === undefined) return undefined;
  const normalized = protocol.trim().toLowerCase();
  if (normalized === '') return undefined;
  return PROTOCOL_ALIASES.get(normalized) ?? normalized;
}
