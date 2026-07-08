// Mixed-locus fixture: `handleRequest` has BOTH genuine intra-procedural
// dependence (a normalized value computed and reused across statements, guarded
// by a validity check) AND a cross-function reach (it calls `persist`).
// Changing it affects intra statements (the normalize->guard->use chain) AND
// the callee.

export function persist(value: number): number {
  return value;
}

export function handleRequest(raw: number): number {
  // criterion: mixed. Intra: normalized flows through the guard to the call.
  const normalized = raw * 2; // def; data-dependent uses below
  if (normalized < 0) {
    // control-dependent guard
    return -1; // control-dependent on the guard
  }
  const adjusted = normalized + 1; // data-dependent on `normalized`
  return persist(adjusted); // cross-function reach; arg data-dependent on `adjusted`
}
