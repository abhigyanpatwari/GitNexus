/**
 * Corpus-derived coverage for the HAND-DECLARED half of `RELATION_SCHEMA`.
 *
 * `test/unit/schema-pair-coverage.test.ts` derives its requirement from
 * `LINKABLE_LABELS` and `CALL_TARGET_TYPES`, so it covers the generated
 * scope-bridge half and is structurally blind to everything else: the
 * containment and inheritance emitters put labels on endpoints (`CodeElement`,
 * `Namespace`, `Record`, `File`) that are in neither set. No predicate
 * describes that surface, so this asks the emitters directly — run the real
 * pipeline and require every FROM/TO pair it produces to be declared.
 *
 * Coverage is bounded by `NON_BRIDGE_CORPUS`: a sample, not a proof. A
 * language whose fixture is absent is unguarded, so a new structural emitter
 * should land with an entry here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { NODE_TABLES } from 'gitnexus-shared';
import { FIXTURES, runPipelineFromRepo } from './resolvers/helpers.js';
import { RELATION_SCHEMA } from '../../src/core/lbug/schema.js';
import { getNodeLabel, parseRelationSchemaPairs } from '../../src/core/lbug/rel-pair-routing.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 180_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

/**
 * Fixtures whose graphs are built OUTSIDE the scope-resolution bridge:
 * `cobol-processor.ts` (CONTAINS/CALLS/ACCESSES over Module / Namespace /
 * Record / Property / CodeElement), `languages/vue/scope-resolver.ts`
 * (BINDS_EVENT_HANDLER, the only edge whose target is a `File`), and the
 * inheritance pass (trait-to-trait IMPLEMENTS).
 */
const NON_BRIDGE_CORPUS = ['cobol-app', 'vue-basic', 'php-transitive-traits'] as const;

const DECLARED = parseRelationSchemaPairs(RELATION_SCHEMA);
const VALID_TABLES = new Set<string>(NODE_TABLES);

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to the schema (#1741).
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

/**
 * The undeclared FROM/TO pairs a fixture emits, deduped and sorted so a failure
 * is stable and names the pair to declare.
 *
 * Mirrors `RelPairRouter.route`: derive both labels with the router's own
 * `getNodeLabel` (from the id, which is what `assertDeclaredPair` actually
 * sees, not the node's `label` field) and drop any edge whose endpoint is not a
 * real node table, exactly as the router's `skipped` branch does.
 */
const undeclaredPairsIn = async (fixture: string): Promise<string[]> => {
  const result = await runPipelineFromRepo(path.join(FIXTURES, fixture), () => {}, {
    workerPoolSize: 1,
    workerUrlForTest: DIST_WORKER_URL,
  });
  const emitted = new Set<string>();
  for (const rel of result.graph.iterRelationships()) {
    emitted.add(`${getNodeLabel(rel.sourceId)}|${getNodeLabel(rel.targetId)}`);
  }
  return [...emitted]
    .filter((pair) => pair.split('|').every((label) => VALID_TABLES.has(label)))
    .filter((pair) => !DECLARED.has(pair))
    .sort();
};

describeIfWorkerBuilt('RELATION_SCHEMA covers the non-bridge emitters', () => {
  // Concurrent because the cases share nothing but cost ~12s each serially,
  // almost all of it worker spawn and grammar load, which overlaps well.
  it.concurrent.each(NON_BRIDGE_CORPUS)('%s emits only declared FROM/TO pairs', async (fixture) => {
    expect(await undeclaredPairsIn(fixture)).toEqual([]);
  });
});
