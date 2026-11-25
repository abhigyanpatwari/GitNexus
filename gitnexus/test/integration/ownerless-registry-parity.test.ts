import { cpSync } from 'node:fs';
import path from 'node:path';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { describe, expect, it, vi } from 'vitest';
import { graphIdentity } from '../helpers/graph-identity.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const probe = vi.hoisted(() => ({ legacy: false, registrations: 0, reads: 0 }));

vi.mock(
  '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js',
  async (original) => {
    const real =
      await original<
        typeof import('../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js')
      >();
    const { probeOwnership } = await import('../helpers/ownerless-registry-probe.js');
    return { ...real, reconcileOwnership: probeOwnership(real.reconcileOwnership, probe) };
  },
);

const repos = createTempDirPool('gn-ownerless-fixtures-');
describe('ownerless registry removal', () => {
  it('preserves the complete language-fixture graph without any ownerless bucket reader', async () => {
    const repo = repos.dir();
    cpSync(path.resolve(import.meta.dirname, '../fixtures/lang-resolution'), repo, {
      recursive: true,
      filter: (source) => !source.endsWith('.java') && path.basename(source) !== '.gitnexus',
    });
    const options = { skipGraphPhases: true, workerPoolSize: 2 };
    const snapshot = async () => {
      const { graph, scopeExtractionFailures } = await runPipelineFromRepo(repo, () => {}, options);
      return { graph: graphIdentity(graph), scopeExtractionFailures };
    };
    probe.legacy = true;
    const before = await snapshot();
    expect(probe.registrations).toBeGreaterThan(100);
    expect(probe.reads).toBe(0);
    probe.legacy = false;
    expect(await snapshot()).toEqual(before);
    expect(probe.reads).toBe(0);
  }, 180000);
});
