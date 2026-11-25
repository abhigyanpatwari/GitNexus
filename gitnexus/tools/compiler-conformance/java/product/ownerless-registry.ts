import assert from 'node:assert/strict';
import { cp, glob, mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { graphIdentity } from '../../../../test/helpers/graph-identity.js';
import { probe } from '../support/ownerless-reconciliation.mjs';

it(
  'preserves the Java fixture graph when ownerless registry entries are removed',
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'gn-java-ownerless-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixtures = fileURLToPath(
      new URL('../../../../test/fixtures/lang-resolution/', import.meta.url),
    );
    const projects = new Set<string>();
    for await (const source of glob('**/*.java', { cwd: fixtures })) {
      projects.add(source.split(path.sep)[0]);
    }
    await Promise.all(
      Array.from(projects, async (name) => {
        await cp(path.join(fixtures, name), path.join(root, name), {
          recursive: true,
          filter: (source) => path.basename(source) !== '.gitnexus',
        });
      }),
    );
    const original = new URL(
      '../../../../dist/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js',
      import.meta.url,
    ).href;
    const instrumented = new URL('../support/ownerless-reconciliation.mjs', import.meta.url).href;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        return resolved.url === original ? { ...resolved, url: instrumented } : resolved;
      },
    });
    t.after(() => hook.deregister());
    const { runPipelineFromRepo } = await import('../../../../dist/core/ingestion/pipeline.js');
    const options = { skipGraphPhases: true, workerPoolSize: 2 };
    const snapshot = async () => {
      const { graph, scopeExtractionFailures } = await runPipelineFromRepo(root, () => {}, options);
      return { graph: graphIdentity(graph), scopeExtractionFailures };
    };
    const before = await snapshot();
    assert.ok(probe.registrations > 100, 'legacy ownerless registrations');
    assert.equal(probe.reads, 0);
    probe.legacy = false;
    assert.deepEqual(await snapshot(), before);
    assert.equal(probe.reads, 0);
  },
);
