/**
 * Shared destination-identity keying — the async counterpart of `routeNodeKey`
 * in `route-extractors/route-path.ts`.
 *
 * Deliberately OUTSIDE `frameworks/spring/`, and for the same reason
 * `routeNodeKey` sits outside the routes phase: the identity has to be mintable
 * by anything that names a broker address, so a Node Kafka client or a Celery
 * task queue can land on the very node a Spring publisher minted. A key that
 * lived in the Spring module would force every other producer to import Spring,
 * or — worse — let each one invent its own spelling, and two spellings of one
 * address is precisely the missed connection this overlay exists to make.
 *
 * `broker` is a plain `string`, NOT the Spring `SpringDestinationBroker` union.
 * Importing that union here is the dependency this module exists to avoid, and
 * widening it costs nothing that matters: the union is a subtype of `string`,
 * so a Spring caller passes its own values unchanged, while a future
 * non-Spring caller stays free to attest to a broker Spring has no name for.
 * The trade is real but small — this signature cannot reject a misspelled
 * broker — and it is the same trade `routeNodeKey` makes by taking `method` as
 * a `string` rather than an HTTP-verb union. Pure string logic, no
 * dependencies.
 */

/**
 * The `Destination` node identity: `(broker, address)` when the broker is
 * known, falling back to the address alone when it is not.
 *
 * The broker belongs IN the key, exactly as the HTTP verb belongs in
 * `routeNodeKey`. `GET /x` and `POST /x` are two nodes, both fully joinable,
 * and neither is punished for the other's existence; `kafka orders` and
 * `rabbit orders` are two nodes on the same terms. A Kafka topic and a Rabbit
 * queue that happen to share a name are two places, and one node for both would
 * report a publisher and a subscriber as connected when nothing connects them.
 *
 * The known objection is that the broker is INFERRED — from a receiver's name,
 * from an annotation table — so a wrong guess splits a pair that is really one.
 * That is true and it is the cost. It is worth paying because the alternative
 * tried first was worse: withdrawing the address from every site that named it
 * split the pair even when the guess was RIGHT, since one unrelated third party
 * writing the same word anywhere in the repository was enough to disconnect
 * everybody on that spelling. Putting the broker in the key bounds the damage
 * of a wrong guess to the one pair it was wrong about, instead of spreading it
 * to every pair that shares an address with a stranger.
 *
 * ── THE ADDRESS-ONLY FALLBACK IS UNREACHABLE TODAY ──────────────────────
 *
 * `SpringDestinationCandidate.broker` is REQUIRED, and every annotation rule
 * and every producer template supplies one, so no Spring caller can reach the
 * `undefined` branch. It is written anyway, and on purpose: the parameter shape
 * is the contract this module offers the next language, and the next language
 * may well capture an address without being able to attest to a broker (a bare
 * `queue.publish(name)` in a dynamic language, a binding that names only a
 * channel). Degrading to address-only is the right answer there — silence about
 * the broker is not a claim about it, and refusing to key such a site at all
 * would lose a real destination over a value nobody disagreed about.
 *
 * Because the branch is dead, it is covered by testing THIS function directly
 * rather than by a pipeline test staged to look as though a phase reached it.
 */
export function destinationNodeKey(broker: string | undefined, address: string): string {
  return broker ? `${broker} ${address}` : address;
}
