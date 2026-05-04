import type { BindingRef } from 'gitnexus-shared';

const TIER: Record<BindingRef['origin'], number> = {
  local: 0,
  namespace: 1,
  import: 2,
  reexport: 3,
  wildcard: 4,
};

export function goMergeBindings(
  existing: readonly BindingRef[],
  incoming: readonly BindingRef[],
  _scopeId: string,
): BindingRef[] {
  const seen = new Set<string>();
  return [...existing, ...incoming]
    .sort(
      (a, b) =>
        (TIER[a.origin] ?? 99) - (TIER[b.origin] ?? 99) || a.def.nodeId.localeCompare(b.def.nodeId),
    )
    .filter((binding) => {
      if (seen.has(binding.def.nodeId)) return false;
      seen.add(binding.def.nodeId);
      return true;
    });
}
