import { simpleQualifiedName } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import type { reconcileOwnership as reconcile } from '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';

export function probeOwnership(
  reconcileOwnership: typeof reconcile,
  probe: { legacy: boolean; registrations: number; reads: number },
) {
  const seen = new WeakMap<object, Set<string>>();
  const types = new Set([
    'Class',
    'Interface',
    'Enum',
    'Struct',
    'Union',
    'Trait',
    'TypeAlias',
    'Typedef',
    'Record',
    'Delegate',
    'Annotation',
    'Template',
    'Namespace',
  ]);
  return (...args: Parameters<typeof reconcileOwnership>) => {
    const [files, model] = args;
    let ids = seen.get(model);
    if (ids === undefined) {
      ids = new Set();
      seen.set(model, ids);
      for (const registry of [model.fields, model.types]) {
        const lookup = registry.lookupAllByOwner;
        registry.lookupAllByOwner = (owner, name) => {
          if (owner === undefined) probe.reads++;
          return lookup(owner, name);
        };
      }
    }
    // The probe is installed first: reconciliation's own duplicate checks
    // are registry readers too, and must be counted.
    const stats = reconcileOwnership(...args);
    if (probe.legacy)
      for (const file of files)
        for (const def of file.localDefs) {
          if (def.ownerId !== undefined || ids.has(def.nodeId)) continue;
          const name = simpleQualifiedName(def);
          if (name === undefined) continue;
          // Reproduce the pre-fix ownerless buckets, including their runtime
          // undefined key despite the registry's string-only reader contract.
          const owner = undefined as unknown as string;
          if (['Property', 'Variable', 'Const', 'Static'].includes(def.type))
            model.fields.register(owner, name, def);
          else if (types.has(def.type)) model.types.registerByOwner(owner, name, def);
          else continue;
          ids.add(def.nodeId);
          probe.registrations++;
        }
    return stats;
  };
}
