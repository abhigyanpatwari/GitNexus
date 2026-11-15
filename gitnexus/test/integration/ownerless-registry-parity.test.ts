import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { graphIdentity } from '../helpers/graph-identity.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { simpleQualifiedName } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';

const probe = vi.hoisted(() => ({ legacy: false, registrations: 0, reads: 0 }));

vi.mock(
  '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js',
  async (original) => {
    const real =
      await original<
        typeof import('../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js')
      >();
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
    return {
      ...real,
      reconcileOwnership: (...args: Parameters<typeof real.reconcileOwnership>) => {
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
        const stats = real.reconcileOwnership(...args);
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
      },
    };
  },
);

describe('ownerless registry removal', () => {
  it('preserves the complete language-fixture graph without any ownerless bucket reader', async () => {
    const repo = path.resolve(import.meta.dirname, '../fixtures/lang-resolution');
    const options = { skipGraphPhases: true, workerPoolSize: 2 };
    probe.legacy = true;
    const before = await runPipelineFromRepo(repo, () => {}, options);
    const identity = graphIdentity(before.graph);
    expect(probe.registrations).toBeGreaterThan(100);
    expect(probe.reads).toBe(0);
    probe.legacy = false;
    const after = await runPipelineFromRepo(repo, () => {}, options);
    expect(after.scopeExtractionFailures).toEqual(before.scopeExtractionFailures);
    expect(graphIdentity(after.graph)).toEqual(identity);
    expect(probe.reads).toBe(0);
  }, 180000);
});
