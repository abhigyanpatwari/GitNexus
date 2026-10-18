import type { BindingRef, Callsite, Range, SymbolDefinition } from 'gitnexus-shared';

const TIER: Record<BindingRef['origin'], number> = {
  local: 0,
  namespace: 1,
  import: 2,
  reexport: 3,
  wildcard: 4,
};

/** `a` before `b` by the line, then the column, at which each starts. */
const startsBefore = (a: Range, b: Range): boolean =>
  a.startLine !== b.startLine ? a.startLine < b.startLine : a.startCol < b.startCol;

/**
 * Local declarations shadow imports; deterministic order within a tier.
 * Same shape as Zig's `zigMergeBindings`.
 *
 * Within the wildcard tier (`library()` / `require()` of a local package) a name that several
 * attached packages define is masked as R masks it: the package attached last wins, so only the
 * bindings of the `library()` call that comes last in the file are kept. A call that attaches a
 * package of several files keeps all of that package's bindings for the name, because a name
 * defined in two of its files is a real ambiguity the order cannot settle. The order is the
 * position of the call in the file, which is the order the file attaches them in when it runs
 * top to bottom; a `library()` inside a function, run later or never, is not told apart, and a
 * package named by several calls counts at its last one (R would keep it where it was first
 * attached). When any of the bindings has no call position the whole tier is kept, as it was
 * before.
 */
export function rMergeBindings(
  existing: readonly BindingRef[],
  incoming: readonly BindingRef[],
  _scopeId: string,
): BindingRef[] {
  const all = [...existing, ...incoming];
  if (all.length === 0) return [];
  let bestTier = 99;
  for (const b of all) {
    const t = TIER[b.origin] ?? 99;
    if (t < bestTier) bestTier = t;
  }
  const byNode = new Map<string, BindingRef>();
  for (const b of all) {
    if ((TIER[b.origin] ?? 99) !== bestTier) continue;
    const seen = byNode.get(b.def.nodeId);
    // One node bound more than once (a package named by several `library()` calls): the later
    // call position wins, whichever way round the bindings arrive.
    if (seen === undefined || attachedLater(b, seen)) byNode.set(b.def.nodeId, b);
  }
  let tier = [...byNode.values()];
  if (bestTier === TIER.wildcard && tier.length > 1) tier = lastAttached(tier);
  // By code unit, not `localeCompare`: the order must not depend on the machine's locale.
  return tier.sort((a, b) =>
    a.def.nodeId < b.def.nodeId ? -1 : a.def.nodeId > b.def.nodeId ? 1 : 0,
  );
}

/** `a` was attached at a call that starts after the one `b` was attached at (both need a position). */
const attachedLater = (a: BindingRef, b: BindingRef): boolean => {
  const ra = a.via?.atRange;
  const rb = b.via?.atRange;
  return ra !== undefined && rb !== undefined && startsBefore(rb, ra);
};

/** The bindings that the last of the `library()` calls behind `bindings` brought in. */
function lastAttached(bindings: BindingRef[]): BindingRef[] {
  const at: Range[] = [];
  for (const b of bindings) {
    if (b.via?.atRange === undefined) return bindings;
    at.push(b.via.atRange);
  }
  let last = at[0];
  for (const range of at) if (startsBefore(last, range)) last = range;
  return bindings.filter(
    (_, i) => at[i].startLine === last.startLine && at[i].startCol === last.startCol,
  );
}

/** R declarations carry no synthesized arity metadata (no `...`/default-arg
 *  capture exists yet), so the comparison is always 'unknown' — a real bounds
 *  check that turns on if arity captures are added later. Same rationale as
 *  Zig's `zigArityCompatibility`. */
export function rArityCompatibility(
  callsite: Callsite,
  def: SymbolDefinition,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';
  if (!Number.isFinite(callsite.arity) || callsite.arity! < 0) return 'unknown';
  if (min !== undefined && callsite.arity! < min) return 'incompatible';
  if (max !== undefined && callsite.arity! > max) return 'incompatible';
  return 'compatible';
}
