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

/** A package's binding of a name and the position of the `library()` call that first attached it. */
interface Attachment {
  readonly ref: BindingRef;
  readonly at: Range;
}

/**
 * What a merge result remembers: every package that defines the name and where it was first
 * attached, including the ones that result masks. The pipeline folds the bindings of a name in
 * one at a time, so a package masked at one step would otherwise be forgotten, and a later
 * `library()` of it would look like a fresh attachment. Keyed by the surviving bindings (not by
 * the result array), so a copy of the array keeps it. A binding that has lost its entry is read as
 * if nothing were masked.
 */
const attachments = new WeakMap<BindingRef, ReadonlyMap<string, Attachment>>();

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
 * top to bottom; a `library()` inside a function, run later or never, is not told apart.
 *
 * A package counts at the call that attached it first: R leaves an attached package where it is,
 * so `library(a); library(b); library(a)` keeps `b` masking `a`. When any of the bindings has no
 * call position the whole tier is kept, as it was before.
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
  const tierRefs = all.filter((b) => (TIER[b.origin] ?? 99) === bestTier);
  const kept = bestTier === TIER.wildcard ? firstAttached(tierRefs) : firstPerNode(tierRefs);
  // By code unit, not `localeCompare`: the order must not depend on the machine's locale.
  return kept.sort((a, b) =>
    a.def.nodeId < b.def.nodeId ? -1 : a.def.nodeId > b.def.nodeId ? 1 : 0,
  );
}

/** One binding per node: the first one seen. */
function firstPerNode(bindings: readonly BindingRef[]): BindingRef[] {
  const byNode = new Map<string, BindingRef>();
  for (const b of bindings) if (!byNode.has(b.def.nodeId)) byNode.set(b.def.nodeId, b);
  return [...byNode.values()];
}

/**
 * The bindings that the `library()` call attached last brought in, a package counting at the call
 * that attached it first. The packages that earlier merges masked take part, from their record.
 */
function firstAttached(bindings: readonly BindingRef[]): BindingRef[] {
  const positioned: Array<{ ref: BindingRef; at: Range }> = [];
  for (const ref of bindings) {
    const at = ref.via?.atRange;
    // Without a call position on every binding the order is unknown: keep the whole tier.
    if (at === undefined) return firstPerNode(bindings);
    positioned.push({ ref, at });
  }
  const byNode = new Map<string, Attachment>();
  const offer = (a: Attachment): void => {
    const seen = byNode.get(a.ref.def.nodeId);
    if (seen === undefined || startsBefore(a.at, seen.at)) byNode.set(a.ref.def.nodeId, a);
  };
  for (const a of positioned) {
    for (const remembered of attachments.get(a.ref)?.values() ?? []) offer(remembered);
    offer(a);
  }
  let last: Range | undefined;
  for (const { at } of byNode.values()) if (last === undefined || startsBefore(last, at)) last = at;
  const lastAt = last;
  const kept = [...byNode.values()].filter(
    ({ at }) =>
      lastAt !== undefined && at.startLine === lastAt.startLine && at.startCol === lastAt.startCol,
  );
  for (const { ref } of kept) attachments.set(ref, byNode);
  return kept.map(({ ref }) => ref);
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
