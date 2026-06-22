// Thin cross-function dispatcher. `dispatch`'s TRUE impact is entirely
// cross-function: it just routes to `handleA` / `handleB` / `handleDefault`.
// Intra-procedural PDG over `dispatch` returns ~no truly-affected statements
// of interest (the routing branch returns are control-dependent on the
// selector, but the *meaningful* blast radius — the work — lives in the
// callees), so PDG inter-AIS recall here is ~0 BY DESIGN. The call-graph mode
// is the right tool: its inter-procedural reach finds the three handlers.

export function handleA(payload: number): number {
  return payload + 1;
}

export function handleB(payload: number): number {
  return payload * 2;
}

export function handleDefault(payload: number): number {
  return payload;
}

export function dispatch(kind: string, payload: number): number {
  // criterion: a thin router. Changing it affects the callees it routes to.
  if (kind === 'a') {
    return handleA(payload);
  }
  if (kind === 'b') {
    return handleB(payload);
  }
  return handleDefault(payload);
}
