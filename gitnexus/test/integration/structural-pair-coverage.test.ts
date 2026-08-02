/**
 * Corpus-derived coverage for the HAND-DECLARED half of `RELATION_SCHEMA`
 * (#2789 follow-up to #2792).
 *
 * `schema-pair-coverage.test.ts` derives its requirement from `LINKABLE_LABELS`
 * and `CALL_TARGET_TYPES`, so it covers exactly the pairs the scope-resolution
 * bridge can emit — the half that is now GENERATED and therefore cannot go
 * stale. It is structurally blind to everything else: the containment,
 * inheritance and route emitters run outside the bridge and put labels on
 * endpoints (`CodeElement`, `Namespace`, `Record`, `File`) that are in neither
 * set, so no pair they produce can ever appear in that test's requirement.
 *
 * That blind spot is not hypothetical. With #2791's `Function→Variable` fix
 * applied, `analyze` still aborted on this repo's own fixtures with
 * `Module→Property is not declared`; a full sweep found 13 undeclared pairs
 * across COBOL, Vue and PHP. A predicate cannot describe that surface — only a
 * corpus can — so this test asks the emitters directly: run the real pipeline
 * over fixtures that exercise the non-bridge paths, and require every FROM/TO
 * pair they produce to be declared.
 *
 * Failing here means adding the pairs to `STRUCTURAL_PAIR_DDL`, not relaxing
 * the assertion: an undeclared pair does not degrade, it throws in
 * `assertDeclaredPair` and takes down `analyze` for every user of that language.
 *
 * Coverage is bounded by the fixtures listed in `NON_BRIDGE_CORPUS`. It is a
 * sample, not a proof — a language whose fixture is absent is unguarded, so a
 * new structural emitter should land with an entry here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { NODE_TABLES } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { RELATION_SCHEMA } from '../../src/core/lbug/schema.js';
import { getNodeLabel, parseRelationSchemaPairs } from '../../src/core/lbug/rel-pair-routing.js';
import { DIST_WORKER_URL } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 180_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(here, '..', 'fixtures', 'lang-resolution');

/**
 * Fixtures whose graphs are built by emitters OUTSIDE the scope-resolution
 * bridge, i.e. the ones the predicate-derived test cannot reach:
 *
 * - `cobol-app` — `cobol-processor.ts` mints `Module` / `Namespace` / `Record` /
 *   `Property` / `CodeElement` and wires them with CONTAINS, CALLS and ACCESSES.
 * - `vue-basic` — `vue-sfc-extractor.ts` emits BINDS_EVENT_HANDLER, the only
 *   edge in the graph whose target is a `File`.
 * - `php-transitive-traits` — trait-to-trait IMPLEMENTS, from the inheritance
 *   pass rather than the call bridge.
 */
const NON_BRIDGE_CORPUS = ['cobol-app', 'vue-basic', 'php-transitive-traits'] as const;

const DECLARED = parseRelationSchemaPairs(RELATION_SCHEMA);
const VALID_TABLES = new Set<string>(NODE_TABLES);

// Three pipeline runs mean three cold worker-pool startups, so this file has 3x
// the usual exposure to the 5s default ready budget — enough to fail on a loaded
// CI runner for reasons that have nothing to do with the schema. Raise it here so
// a failure means an undeclared pair and never a slow host (#1741).
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

/**
 * The undeclared FROM/TO pairs a fixture emits, as `From|To`, deduped and
 * sorted so a failure is stable and names the pair to declare.
 *
 * Mirrors `RelPairRouter.route`: derive both labels with the router's own
 * `getNodeLabel`, drop any edge whose endpoint is not a real node table (the
 * router counts those as `skipped` and never routes them), then keep what is
 * left undeclared. Using the router's function rather than the node's `label`
 * field is deliberate — the router derives from the id, and that derivation is
 * what `assertDeclaredPair` actually sees.
 */
const undeclaredPairsIn = async (fixture: string): Promise<string[]> => {
  const result = await runPipelineFromRepo(path.join(FIXTURE_ROOT, fixture), () => {}, {
    workerPoolSize: 1,
    workerUrlForTest: DIST_WORKER_URL,
  });
  const undeclared = new Set<string>();
  for (const rel of result.graph.iterRelationships()) {
    const from = getNodeLabel(rel.sourceId);
    const to = getNodeLabel(rel.targetId);
    const routable = VALID_TABLES.has(from) && VALID_TABLES.has(to);
    const pairKey = `${from}|${to}`;
    const missing = routable && !DECLARED.has(pairKey);
    undeclared.add(missing ? pairKey : '');
  }
  undeclared.delete('');
  return [...undeclared].sort();
};

describe('RELATION_SCHEMA covers the non-bridge emitters', () => {
  it.each(NON_BRIDGE_CORPUS)('%s emits only declared FROM/TO pairs', async (fixture) => {
    expect(await undeclaredPairsIn(fixture)).toEqual([]);
  });

  it('pins the pairs whose absence aborted analyze after #2791', () => {
    // COBOL containment/call/access plus the Vue handler→component edge. Listed
    // explicitly so deleting a fixture above cannot silently drop the guard.
    const regressions = [
      'CodeElement|CodeElement',
      'CodeElement|Module',
      'CodeElement|Property',
      'CodeElement|Record',
      'Function|File',
      'Module|CodeElement',
      'Module|Namespace',
      'Module|Record',
      'Namespace|Function',
      'Record|Record',
    ];
    expect(regressions.filter((pair) => !DECLARED.has(pair))).toEqual([]);
  });
});
