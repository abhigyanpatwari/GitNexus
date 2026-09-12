// R3-5: TWO producers returning the same field name — the case name inference
// must refuse, because `x.ambiguousProducedField` alone cannot say which shape
// is meant. The receiver's binding says which, so this resolves precisely.
export function producerAlpha(row) {
  return {
    ambiguousProducedField: row.a,
  };
}

export function producerBeta(row) {
  return {
    ambiguousProducedField: row.b,
  };
}

// BOUND to the call result, so the type binding attaches.
export function readsAlpha(row) {
  const shaped = producerAlpha(row);
  return shaped.ambiguousProducedField;
}

export function readsBeta(row) {
  const shaped = producerBeta(row);
  return shaped.ambiguousProducedField;
}

// THE BOUND of the mechanism: a bare parameter has no binding here, because
// typing it needs the CALLER's type to flow in. This must stay unresolved and
// fall through to name inference, which will refuse it (two producers).
export function readsUnbound(shaped) {
  return shaped.ambiguousProducedField;
}
