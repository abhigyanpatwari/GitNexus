// A declared contract, and a generic whose PARAMETER collides with its name.
// tsc reads both annotations in `unwrap` as the type parameter, not the
// interface — so a `USES` edge from `unwrap` reports a consumer of a contract it
// has no relationship with, at the same confidence as a real one.
export interface Result {
  ok: boolean;
}

export function unwrap<Result>(value: Result): Result {
  return value;
}

// The CONTROL. A genuine consumer of the interface, which must survive: the
// point is to stop shadowed references, not to disable the rule.
export function readResult(r: Result): boolean {
  return r.ok;
}

// Same collision on a generic type alias.
export type Box<Result> = { held: Result };

// A generic whose parameter does NOT collide — the interface reference inside
// it is real and must still link.
export function wrap<T>(value: T, meta: Result): T {
  return meta.ok ? value : value;
}
