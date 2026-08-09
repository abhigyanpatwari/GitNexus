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

// Same collision on a generic type alias whose value is an OBJECT TYPE — the
// one alias form that opens a scope of its own.
export type Box<Result> = { held: Result };

// The same collision on the alias forms that open NO scope. A union, a
// conditional, a mapped type, an array, a tuple, a function type and a
// `Record<K, V>` are all `type_alias_declaration`s whose value is not an
// `object_type`, so nothing anchors their parameters to a region of the file.
// A parameter list that binds nothing is harmless; one that binds the WHOLE
// MODULE deletes every `USES` edge in the file whose target is spelled
// `Result` — including `readResult` above, and including an imported type.
export type Maybe<Result> = Result | null;
export type Ids<Result> = Result[];

// A generic whose parameter does NOT collide — the interface reference inside
// it is real and must still link.
export function wrap<T>(value: T, meta: Result): T {
  return meta.ok ? value : value;
}
