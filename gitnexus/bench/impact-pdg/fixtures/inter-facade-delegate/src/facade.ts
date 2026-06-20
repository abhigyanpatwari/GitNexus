// Facade that delegates to a layered set of helpers. `processOrder`'s true
// impact is cross-function: it sequences `validate`, `enrich`, and `persist`.
// Its own body is a thin sequence of calls with a single guard; the real work
// (and the real blast radius) is in the delegates. PDG intra-AIS is ~empty by
// design; the call-graph mode walks the delegation chain.

export function validate(order: number): boolean {
  return order > 0;
}

export function enrich(order: number): number {
  return order + 100;
}

export function persist(order: number): number {
  return order;
}

export function processOrder(order: number): number {
  // criterion: a facade. Its impact flows into the three delegates.
  if (!validate(order)) {
    return -1;
  }
  const enriched = enrich(order);
  return persist(enriched);
}
