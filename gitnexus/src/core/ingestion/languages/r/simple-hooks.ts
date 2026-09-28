import type { BindingRef, Callsite, SymbolDefinition } from 'gitnexus-shared';

const TIER: Record<BindingRef['origin'], number> = {
  local: 0,
  namespace: 1,
  import: 2,
  reexport: 3,
  wildcard: 4,
};

/** Local declarations shadow imports; deterministic order within a tier.
 *  Same shape as Zig's `zigMergeBindings` — R has no per-scope binding
 *  precedence rule beyond "the tightest-origin binding wins". */
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
    if (!byNode.has(b.def.nodeId)) byNode.set(b.def.nodeId, b);
  }
  return [...byNode.values()].sort((a, b) => a.def.nodeId.localeCompare(b.def.nodeId));
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
