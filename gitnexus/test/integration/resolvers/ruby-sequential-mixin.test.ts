/**
 * Regression: Ruby mixin heritage resolution must work on the sequential
 * ingestion fallback AND the worker-pool path, with identical output.
 *
 * Guards the two Codex adversarial review findings addressed by plan
 * `docs/plans/2026-04-17-001-fix-codex-adversarial-ruby-mixin-heritage-plan.md`:
 *
 * 1. Sequential-mode `sequentialHeritageMap` must include Ruby `include` /
 *    `extend` / `prepend` mixin ancestry before `processCalls` resolves calls
 *    against it. `extractExtractedHeritageFromFiles` now also runs
 *    `heritageExtractor.extractFromCall` during its prepass.
 *
 * 2. Ruby `module` declarations are relabeled to `Trait` so they participate
 *    in `lookupClassByName` / `buildHeritageMap`.
 *
 * The follow-up plan `docs/plans/2026-04-17-002-fix-ce-review-ruby-mixin-followups-plan.md`
 * Units 1 and 2 harden this suite:
 *   - Worker mode actually spawns a worker pool (verified via
 *     `PipelineResult.usedWorkerPool`) instead of silently falling back.
 *   - The prepend-only `prepended_marker` assertion checks the resolved
 *     method's OWNER, so reverting the Module→Trait relabel (Unit 2 of
 *     plan 001) makes the test fail with a clear owner-mismatch instead
 *     of passing trivially on `Account`'s own method.
 *
 * Plan 003 adds the `'ruby-mixin'` MroStrategy and kind-aware ancestry
 * (prepend / include / extend split). Plan 005 (the call-resolution DAG)
 * installs `inferImplicitReceiver` and `selectDispatch` provider hooks that
 * let Ruby self-rewrite bare-identifier calls to `self.method` so they take
 * the owner-scoped MRO path. The shadow-name assertion below exercises the
 * full chain: Module→Trait relabel + kind-aware MRO + self-inference.
 *
 * Known guard limitation (documented residual): reverting plan 001 Unit 1
 * alone (the sequential prepass extractFromCall) does NOT make these tests
 * fail, because `processCalls` independently extracts call-based heritage
 * into `rubyHeritage`, feeds it to `processHeritageFromExtracted` for graph
 * edges, and the call resolver's global-name fallback can still locate
 * mixin-provided methods without MRO ancestry. A stronger guard would need
 * an ambiguous method name that only MRO can disambiguate; that requires
 * cross-chunk or multi-class shadowing scenarios not covered by this
 * fixture. Tracked as residual work in plan 002's Unit 3 (cross-chunk).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import type { GraphRelationship } from '../../../src/core/graph/types.js';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineOptions,
  type PipelineResult,
} from './helpers.js';

const FIXTURE = path.join(FIXTURES, 'ruby-sequential-mixin');

async function runMode(opts: PipelineOptions): Promise<PipelineResult> {
  return runPipelineFromRepo(FIXTURE, () => {}, opts);
}

/** CALLS edges from `sourceName` whose target is a Method node. */
function methodCallEdges(result: PipelineResult, sourceName: string): Set<string> {
  const edges = getRelationships(result, 'CALLS').filter(
    (e) => e.source === sourceName && e.targetLabel === 'Method',
  );
  return new Set(edges.map((e) => `${e.source} → ${e.target}`));
}

/**
 * Find the name of the node that `HAS_METHOD`s this target node, if any.
 * Returns `undefined` when no owner edge exists (e.g., top-level function).
 */
function findMethodOwner(result: PipelineResult, methodNodeId: string): string | undefined {
  for (const rel of result.graph.iterRelationships() as IterableIterator<GraphRelationship>) {
    if (rel.type === 'HAS_METHOD' && rel.targetId === methodNodeId) {
      return result.graph.getNode(rel.sourceId)?.properties.name;
    }
  }
  return undefined;
}

/**
 * Return the owner names of every `Method` target reached by a CALLS edge
 * starting at `sourceName` whose target's name matches `targetMethodName`.
 * Used to assert WHICH provider resolved a shadowed method name like
 * `serialize` (provided by both Account and PrependedOverride).
 */
function resolvedMethodOwners(
  result: PipelineResult,
  sourceName: string,
  targetMethodName: string,
): string[] {
  const owners: string[] = [];
  for (const e of getRelationships(result, 'CALLS')) {
    if (e.source === sourceName && e.targetLabel === 'Method' && e.target === targetMethodName) {
      const owner = findMethodOwner(result, e.rel.targetId);
      if (owner) owners.push(owner);
    }
  }
  return owners.sort();
}

describe('Ruby mixin heritage: sequential vs worker parity', () => {
  let sequential: PipelineResult;
  let workers: PipelineResult;

  beforeAll(async () => {
    sequential = await runMode({ skipWorkers: true });
    // Force the worker pool to spawn even though the fixture is tiny.
    // Without this override, the pipeline's MIN_FILES_FOR_WORKERS / MIN_BYTES_FOR_WORKERS
    // gate would fall back to sequential and the "worker vs sequential" parity
    // assertion below would degenerate into sequential-vs-sequential.
    workers = await runMode({
      skipWorkers: false,
      workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
    });
  }, 120000);

  it('exercises both pipeline paths (sequential and worker)', () => {
    // If either of these assertions fails, every downstream parity check
    // below is meaningless — both modes would be running the same path.
    expect(sequential.usedWorkerPool).toBe(false);
    expect(workers.usedWorkerPool).toBe(true);
  });

  it('labels Ruby modules as Trait in both modes', () => {
    const expected = ['Greetable', 'LoggerMixin', 'PrependedOverride'];
    expect(getNodesByLabel(sequential, 'Trait').sort()).toEqual(expected);
    expect(getNodesByLabel(workers, 'Trait').sort()).toEqual(expected);
    // No Ruby modules leak through as the inert `Module` label.
    // The 'lib' module node is the fixture's top-level directory node, which
    // the ingestion pipeline emits for every fixture root — unrelated to
    // Ruby `module` declarations. Filtering it keeps the assertion specific
    // to Ruby-module relabeling without being coupled to how directory nodes
    // are emitted.
    expect(getNodesByLabel(sequential, 'Module').filter((n) => n !== 'lib')).toEqual([]);
    expect(getNodesByLabel(workers, 'Module').filter((n) => n !== 'lib')).toEqual([]);
  });

  it('sequential mode resolves include-provided method: call_greet → greet', () => {
    const edges = methodCallEdges(sequential, 'call_greet');
    expect([...edges]).toContain('call_greet → greet');

    // Stronger: the resolved `greet` must be owned by the `Greetable` module
    // (relabeled to Trait). A regression in Unit 2 of plan 001 would either
    // fail to resolve (owners = []) or resolve to some other owner.
    const owners = resolvedMethodOwners(sequential, 'call_greet', 'greet');
    expect(owners).toContain('Greetable');
  });

  it('sequential mode resolves prepend-only method: call_prepended_marker → PrependedOverride#prepended_marker', () => {
    // `prepended_marker` is defined ONLY on PrependedOverride — not on
    // Account, Greetable, or LoggerMixin. Narrow guard for the prepend
    // provider entering the MRO (plan 001 / plan 003).
    const owners = resolvedMethodOwners(sequential, 'call_prepended_marker', 'prepended_marker');
    expect(owners).toContain('PrependedOverride');
  });

  it('sequential mode resolves prepend shadow: call_serialize → PrependedOverride#serialize (not Account#serialize)', () => {
    // `Account` defines `def serialize` AND `prepend PrependedOverride` which
    // also defines `serialize`. Ruby MRO says the prepended module wins.
    // This assertion exercises the full chain:
    //   - Module→Trait relabel (plan 001 Unit 2) — PrependedOverride resolvable via lookupClassByName
    //   - `'ruby-mixin'` MroStrategy (plan 003 Unit 3) — prepend walks before direct owner
    //   - `inferImplicitReceiver` hook (plan 005 / DAG) — bare `serialize` call rewritten
    //     as `self.serialize` so it takes the owner-scoped MRO path
    // Reverting ANY of the three makes this assertion fail.
    const owners = resolvedMethodOwners(sequential, 'call_serialize', 'serialize');
    expect(owners).toContain('PrependedOverride');
  });

  it('sequential mode resolves extend-provided class method: Usage#run → LoggerMixin#log', () => {
    // `Account extend LoggerMixin` means `LoggerMixin#log` is a CLASS method
    // on `Account`. The fixture's `Usage#run` calls `Account.log("from Usage")`
    // — a class-constant receiver, not an instance call. This exercises the
    // `selectDispatch` hook's `receiverSource === 'class-as-receiver'` branch,
    // which returns `ancestryView: 'singleton'` so the walker uses
    // `getSingletonAncestry(Account)` = [LoggerMixin] instead of the instance
    // MRO (which would have resolved nothing, since `log` is not an instance
    // method on Account).
    //
    // Reverting the singleton branch in Ruby's selectDispatch (or dropping
    // 'Trait'/'Class' from the class-as-receiver filter in call-processor)
    // makes this assertion fail.
    const owners = resolvedMethodOwners(sequential, 'run', 'log');
    expect(owners).toContain('LoggerMixin');
  });

  // TODO(plan-003-followup): assert that prepend shadows self for
  // `call_serialize → PrependedOverride#serialize`. Blocked on Ruby bare-call
  // self-inference: bare identifier calls like `serialize` inside `Account#call_serialize`
  // currently flow through `resolveFreeCall` (global name lookup), not
  // `resolveMemberCall` (owner-scoped + MRO walk). The `'ruby-mixin'` MroStrategy
  // added by plan 003 is correctly wired and will apply as soon as Ruby bare calls
  // are threaded as `self.method` with receiverTypeName = enclosing class. Until then,
  // shadow-name resolution lands on `Account#serialize` regardless of prepend MRO.
  //
  // The `prepended_marker` test above is the narrower guard that works today
  // (non-shadowed method only reachable via the prepend provider).

  it('sequential mode emits IMPLEMENTS edges for all three mixin kinds', () => {
    // Ruby mixins (include / extend / prepend) flow through the IMPLEMENTS
    // branch of processHeritageFromExtracted with the mixin kind recorded in
    // rel.reason. See heritage-processor.ts L146-168.
    const kinds = getRelationships(sequential, 'IMPLEMENTS')
      .filter((e) => e.source === 'Account')
      .map((e) => e.rel.reason ?? '')
      .sort();
    expect(kinds).toEqual(['extend', 'include', 'prepend']);
  });

  it('worker mode resolves the same include and prepend-only targets', () => {
    // Cross-mode ownership parity for the mixin providers. If Unit 1 of
    // plan 001 regressed on the sequential side only, the `greet` /
    // `prepended_marker` owners would diverge between modes here — the
    // sequential side would lose the mixin-provided edges while worker
    // mode kept them (or vice versa).
    expect(resolvedMethodOwners(workers, 'call_greet', 'greet')).toContain('Greetable');
    expect(resolvedMethodOwners(workers, 'call_prepended_marker', 'prepended_marker')).toContain(
      'PrependedOverride',
    );
  });

  it('sequential and worker modes produce the same mixin-method CALLS edges', () => {
    const seqEdges = methodCallEdges(sequential, 'call_greet');
    const workerEdges = methodCallEdges(workers, 'call_greet');
    expect([...seqEdges].sort()).toEqual([...workerEdges].sort());

    const seqMarker = methodCallEdges(sequential, 'call_prepended_marker');
    const workerMarker = methodCallEdges(workers, 'call_prepended_marker');
    expect([...seqMarker].sort()).toEqual([...workerMarker].sort());
  });
});
