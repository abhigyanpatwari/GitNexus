/**
 * Corpus-derived coverage for the HAND-DECLARED half of `RELATION_SCHEMA`.
 *
 * `test/unit/schema-pair-coverage.test.ts` derives its requirement from
 * schema.ts's two rules — the scope-resolution bridge cross product, and
 * `DEFINITION_ANCHOR_LABELS × ATTACHMENT_TARGET_LABELS` for the framework and
 * pipeline-phase overlays — so both generated halves are covered there. What
 * neither rule can reach is `STRUCTURAL_PAIR_DDL`: the containment, inheritance
 * and import pairs BETWEEN TWO DEFINITION LABELS. Eleven node tables are absent
 * from every rule's target side (`CodeElement`, `Impl`, `Namespace`,
 * `Template`, `TypeAlias`, `Typedef`, `Union`, `Static`, `Section`, `Folder`,
 * and the PDG-only `BasicBlock`), so a pair pointing at one is hand-declared or
 * it does not exist. No predicate describes that surface — any container can
 * hold any definition — so this asks the emitters directly: run the real
 * pipeline and require every FROM/TO pair it produces to be declared.
 *
 * Each entry also pins the pair it exists to guard. Without that the suite is
 * vacuous: `undeclared` is derived from what the pipeline emitted, so a fixture
 * that stopped emitting — renamed directory, grammar that failed to load,
 * swallowed parse error — yields an empty set and passes green while guarding
 * nothing. `sentinels` turns each case from "nothing undeclared" into "this
 * emitter still fires, and everything it emits is declared".
 *
 * Coverage is bounded by `NON_BRIDGE_CORPUS`: a sample, not a proof. A
 * language whose fixture is absent is unguarded, so a new structural emitter
 * should land with an entry here.
 *
 * Deliberately isolated from the resolver suites that already build three of
 * these graphs (`resolvers/cobol.test.ts`, `resolvers/vue.test.ts`,
 * `resolvers/php.test.ts`) — see NOTE below the corpus before re-raising that.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { NODE_TABLES } from 'gitnexus-shared';
import { FIXTURES, runPipelineFromRepo } from './resolvers/helpers.js';
import { RELATION_SCHEMA } from '../../src/core/lbug/schema.js';
import { parseRelationSchemaPairs, relPairKeyFor } from '../../src/core/lbug/rel-pair-routing.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 180_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

type CorpusEntry = {
  /** Fixture directory under `test/fixtures/lang-resolution`. */
  readonly fixture: string;
  /**
   * The emitter this fixture exists to exercise, short enough that vitest does
   * not truncate it out of the case title (~36 chars).
   */
  readonly emitter: string;
  /**
   * FROM|TO pairs the fixture MUST still emit. These are the anti-vacuity
   * check: they fail loudly when the fixture stops reaching the emitter,
   * which is the failure mode "no undeclared pairs" cannot see.
   */
  readonly sentinels: readonly string[];
};

/**
 * Fixtures chosen to reach a structural emitter that no other suite drives.
 *
 * The sentinels are the anti-vacuity anchor: each names an emitter that must
 * still fire. Two of them (`CodeElement|Property`, `Module|Namespace`) are also
 * the only pairs here that no generated rule can reach; the other nine are
 * rule-derived, and stay because a rule DECLARING a pair says nothing about
 * whether any emitter still PRODUCES it — which is the failure this corpus
 * exists to catch.
 */
const NON_BRIDGE_CORPUS = [
  {
    // `cobol-processor.ts`: CONTAINS/CALLS/ACCESSES over Module / Namespace /
    // Record / Property / CodeElement.
    fixture: 'cobol-app',
    emitter: 'cobol-processor containment',
    sentinels: ['CodeElement|Property', 'Module|Namespace', 'Module|Record', 'Record|Record'],
  },
  {
    // Same processor, DECLARATIVES section: the USE-procedure Namespace
    // ACCESSES a file Record.
    fixture: 'cobol-declaratives',
    emitter: 'cobol-processor DECLARATIVES',
    sentinels: ['Namespace|Record'],
  },
  {
    // `languages/vue/scope-resolver.ts`: the only edge whose target is a
    // `File`. Function→File from `<script setup>` (App.vue), Method→File from
    // the Options-API `methods:` host (OptionsHost.vue).
    fixture: 'vue-basic',
    emitter: 'vue BINDS_EVENT_HANDLER',
    sentinels: ['Function|File', 'Method|File'],
  },
  {
    // The inheritance pass, including trait-to-trait IMPLEMENTS.
    fixture: 'php-transitive-traits',
    emitter: 'inheritance-pass IMPLEMENTS',
    sentinels: ['Class|Trait', 'Trait|Trait'],
  },
  {
    // `frameworks/spring/conditionals.ts`: @ConditionalOn* on a @Bean method,
    // in both Java and Kotlin.
    fixture: 'spring-conditional-app',
    emitter: 'spring CONDITIONAL_ON',
    sentinels: ['Method|Annotation'],
  },
  {
    // `pipeline-phases/tools.ts`: a class-based MCP tool handler.
    fixture: 'mcp-tool-class',
    emitter: 'tools-phase HANDLES_TOOL',
    sentinels: ['Class|Tool'],
  },
] as const satisfies readonly CorpusEntry[];

/*
 * NOTE — why this suite runs its own pipelines instead of reusing the resolver
 * suites' graphs (measured, not assumed):
 *
 *   1. Vitest runs with `pool: 'forks'` and default isolation, so every test
 *      FILE gets its own child process. A fixture-keyed result cache in
 *      `resolvers/helpers.ts` would be per-file module state and would share
 *      nothing across files — zero saving.
 *   2. The graphs are not interchangeable. `resolvers/cobol.test.ts` builds
 *      cobol-app with `{ skipGraphPhases: true }`, which drops the phase-emitted
 *      edges (`Function|Process`, `Function|Community`, and the whole class of
 *      pair `mcp-tool-class` exists to guard: HANDLES_TOOL is a pipeline phase).
 *      Asserting there would silently cover LESS surface than here.
 *   3. Half the corpus has no existing home anyway, and the cases run
 *      concurrently, so they overlap into roughly one fixture's wall time: all
 *      6 measured ~6s of test time against the ~16s this file spends on
 *      transform+import before the first case starts. Hosting only the 3
 *      homeless ones measured ~5s — a ~1s saving that still cannot remove a
 *      file, so it cannot remove that ~16s.
 */

const DECLARED = parseRelationSchemaPairs(RELATION_SCHEMA);
const VALID_TABLES = new Set<string>(NODE_TABLES);

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to the schema (#1741).
// Safe under `it.concurrent`: env stubs are process-global, but `pool: 'forks'`
// gives this file its own process and every case wants the same value.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

/**
 * The FROM/TO pairs a fixture emits, deduped.
 *
 * Classifies through `relPairKeyFor` — the same call the emit path routes with
 * — so this guard and the router cannot disagree about which edges are skipped.
 * It keys off the node IDS, which is what `assertDeclaredPair` actually sees,
 * not the node's `label` field.
 */
const pairsEmittedBy = async (fixture: string): Promise<Set<string>> => {
  const result = await runPipelineFromRepo(path.join(FIXTURES, fixture), () => {}, {
    workerPoolSize: 1,
    workerUrlForTest: DIST_WORKER_URL,
  });
  const emitted = new Set<string>();
  for (const rel of result.graph.iterRelationships()) {
    const pair = relPairKeyFor(rel.sourceId, rel.targetId, VALID_TABLES);
    if (pair !== undefined) emitted.add(pair);
  }
  return emitted;
};

describeIfWorkerBuilt('RELATION_SCHEMA covers the non-bridge emitters', () => {
  // Concurrent because the cases share nothing but cost ~5s each serially,
  // almost all of it worker spawn and grammar load, which overlaps well.
  it.concurrent.each(NON_BRIDGE_CORPUS)(
    '$fixture emits only declared FROM/TO pairs, and still reaches $emitter',
    async ({ fixture, sentinels }) => {
      const emitted = await pairsEmittedBy(fixture);
      // Sorted so a failure is stable and names the pair to declare.
      expect({
        undeclaredPairs: [...emitted].filter((pair) => !DECLARED.has(pair)).sort(),
        missingSentinelPairs: sentinels.filter((pair) => !emitted.has(pair)),
      }).toEqual({ undeclaredPairs: [], missingSentinelPairs: [] });
    },
  );
});
