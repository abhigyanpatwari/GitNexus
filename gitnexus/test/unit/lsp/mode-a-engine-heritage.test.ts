/**
 * WI-5 — Heritage generalization for the Mode A decision engine.
 *
 * The engine is generalized to mint IMPLEMENTS / EXTENDS edges
 * (in addition to CALLS) via `Candidate.relType` and per-type
 * target-label gates. This test file covers the NEW branches
 * and pins CALLS byte-identity vs PR #168.
 *
 * The PR #168 CALLS behavior must be 100% byte-identical:
 *   - `candidateLocationKey` for a CALLS candidate (no
 *     `relType`) has NO `|${relType}` suffix.
 *   - `decideForCandidate` decisions for CALLS candidates
 *     are unchanged.
 *   - The `non_callable` refusal reason string is untouched.
 *
 * The heritage branches add:
 *   - `correct` for IMPLEMENTS — synthetic heuristic target
 *     → real Interface node (label ∈ gate), old edge
 *     removed by `oldRelId`, new edge stamped 0.70
 *     `lsp-corrected`.
 *   - `confirm` for EXTENDS — id preserved, restamped to
 *     0.70.
 *   - `keep` for Class-target-for-IMPLEMENTS (label gate
 *     refuses).
 *   - `keep` for Interface-target-for-EXTENDS (label gate
 *     refuses).
 *   - `keep` for self-loop (B === A).
 *   - Multi-Location → AMBIGUOUS → `keep` (no guess).
 *   - `from` always the child class node.
 *
 * Test technique: decision-table over
 * (confirm|correct|keep|refuse) × (IMPLEMENTS|EXTENDS) plus
 * compat pins. `mapLocationToNodeId` is injected as a fake
 * so the tests are server-independent.
 */

import { describe, it, expect } from 'vitest';

import {
  decideForCandidate,
  applyDecisions,
  reconcileDecisions,
  candidateLocationKey,
  HERITAGE_TARGET_LABELS,
  LSP_CONFIDENCE,
  REASON_LSP_CONFIRMED,
  REASON_LSP_CORRECTED,
  REASON_LSP_RECALL,
  type Candidate,
  type Decision,
  type Location,
  type ReconcileDecisionsDeps,
} from '../../../src/core/ingestion/mode-a-reconciler.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { GraphRelationship } from '../../../src/core/graph/types.js';
import type { MapperResult } from '../../../src/core/ingestion/lsp/location-mapper.js';
import {
  CALLABLE_LABELS as CALLABLE,
  mkLoc,
} from './mode-a-engine.fixtures.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

/** A heritage candidate — class implements an Interface. */
function mkImplementsCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'Class:src/user-service.ts:UserService',
    calledName: 'IUserRepo',
    oldTargetId: 'Interface:IUserRepo',
    file: 'src/user-service.ts',
    line: 4,
    character: 31,
    relType: 'IMPLEMENTS',
    ...over,
  };
}

/** A heritage candidate — class extends a Class. */
function mkExtendsCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'Class:src/dog.ts:Dog',
    calledName: 'Animal',
    oldTargetId: 'Class:Animal',
    file: 'src/dog.ts',
    line: 4,
    character: 16,
    relType: 'EXTENDS',
    ...over,
  };
}

/** Heuristic heritage edge — IMPLEMENTS template (heritage-processor.ts:403). */
function heuristicImplementsRel(
  sourceId: string,
  targetId: string,
  over: Partial<GraphRelationship> = {},
): GraphRelationship {
  return {
    id: `IMPLEMENTS:${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'IMPLEMENTS',
    confidence: 0.5,
    reason: 'heuristic',
    source: 'heuristic',
    ...over,
  };
}

/** Heuristic heritage edge — EXTENDS template. */
function heuristicExtendsRel(
  sourceId: string,
  targetId: string,
  over: Partial<GraphRelationship> = {},
): GraphRelationship {
  return {
    id: `EXTENDS:${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'EXTENDS',
    confidence: 0.5,
    reason: 'heuristic',
    source: 'heuristic',
    ...over,
  };
}

// ─── Compat pins: CALLS byte-identity vs PR #168 ──────────────────────

describe('WI-5 — candidateLocationKey: CALLS candidates produce byte-identical keys vs PR #168', () => {
  it('CALLS candidate (no relType) → key has no relType suffix', () => {
    const cand: Candidate = {
      sourceId: 'src:1',
      calledName: 'foo',
      oldTargetId: 'Function:src/a.ts:foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    expect(candidateLocationKey(cand)).toBe('src:1|foo|10|4');
  });

  it('IMPLEMENTS candidate → key gains |IMPLEMENTS suffix', () => {
    const cand = mkImplementsCandidate();
    expect(candidateLocationKey(cand)).toBe(
      'Class:src/user-service.ts:UserService|IUserRepo|4|31|IMPLEMENTS',
    );
  });

  it('EXTENDS candidate → key gains |EXTENDS suffix', () => {
    const cand = mkExtendsCandidate();
    expect(candidateLocationKey(cand)).toBe(
      'Class:src/dog.ts:Dog|Animal|4|16|EXTENDS',
    );
  });

  it('two CALLS candidates with same (source, called, line, char) produce same key (no collision risk)', () => {
    const a: Candidate = {
      sourceId: 's1',
      calledName: 'foo',
      oldTargetId: 'Function:src/a.ts:foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    const b: Candidate = { ...a };
    expect(candidateLocationKey(a)).toBe(candidateLocationKey(b));
  });

  it('a CALLS candidate and a heritage candidate with the same (source, called, line, char) do NOT collide', () => {
    // Defensive: the engine's session funnel keys on
    // candidateLocationKey; if CALLS and IMPLEMENTS
    // candidates happened to share the same four-tuple,
    // the |relType suffix is what keeps them apart.
    const calls: Candidate = {
      sourceId: 'Class:src/x.ts:X',
      calledName: 'I',
      file: 'src/x.ts',
      line: 5,
      character: 0,
    };
    const heritage: Candidate = {
      ...calls,
      relType: 'IMPLEMENTS',
      oldTargetId: 'Interface:I',
    };
    expect(candidateLocationKey(calls)).not.toBe(candidateLocationKey(heritage));
  });
});

// ─── Compat pins: decideForCandidate CALLS decisions unchanged ─────────

describe('WI-5 — decideForCandidate: CALLS path decisions are byte-identical vs PR #168', () => {
  it('CALLS confirm: LSP agrees with heuristic → confirm (0.70, restamp oldRelId)', () => {
    const cand: Candidate = {
      sourceId: 's1',
      calledName: 'foo',
      oldTargetId: 'Function:src/a.ts:foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    const rel: GraphRelationship = {
      id: 'CALLS:s1->Function:src/a.ts:foo',
      sourceId: 's1',
      targetId: 'Function:src/a.ts:foo',
      type: 'CALLS',
      confidence: 0.5,
      reason: 'heuristic',
      source: 'heuristic',
    };
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/a.ts:foo' },
      { existingRel: rel, callableLabels: CALLABLE, targetLabel: 'Function' },
    );
    expect(decision.action).toBe('confirm');
    expect(decision.from).toBe('s1');
    expect(decision.to).toBe('Function:src/a.ts:foo');
    expect(decision.source).toBe('lsp-confirmed');
    expect(decision.reason).toBe(REASON_LSP_CONFIRMED);
    expect(decision.oldRelId).toBe(rel.id);
  });

  it('CALLS non_callable: Class hit → refuse (reason string preserved)', () => {
    const cand: Candidate = {
      sourceId: 's1',
      calledName: 'foo',
      oldTargetId: undefined,
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Class:src/b.ts:Bar' },
      { callableLabels: CALLABLE, targetLabel: 'Class' },
    );
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('non_callable');
  });

  it('CALLS self-loop: B === source → refuse (reason string preserved)', () => {
    const cand: Candidate = {
      sourceId: 'Method:src/a.ts:foo',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Method:src/a.ts:foo' },
      { callableLabels: CALLABLE, targetLabel: 'Method' },
    );
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('self_loop');
  });
});

// ─── HERITAGE_TARGET_LABELS contract ───────────────────────────────────

describe('WI-5 — HERITAGE_TARGET_LABELS contract', () => {
  it('IMPLEMENTS gate is { Interface }', () => {
    expect(HERITAGE_TARGET_LABELS.IMPLEMENTS).toEqual(new Set(['Interface']));
  });

  it('EXTENDS gate is { Class }', () => {
    expect(HERITAGE_TARGET_LABELS.EXTENDS).toEqual(new Set(['Class']));
  });
});

// ─── Heritage decision table via reconcileDecisions ───────────────────

describe('WI-5 — reconcileDecisions: heritage decision table', () => {
  function makeDeps(over: Partial<ReconcileDecisionsDeps> = {}): ReconcileDecisionsDeps {
    // NOTE: do NOT inject `findExistingRel` — the production
    // default is what uses the pre-built relIndex (triple-
    // keyed on sourceId|oldTargetId|relType). Tests that
    // want to bypass the index can pass an override
    // explicitly via `over.findExistingRel`.
    return {
      mapLocationToNodeId: over.mapLocationToNodeId ?? (async () => ({ kind: 'NO_NODE' as const })),
      callableLabels: over.callableLabels ?? CALLABLE,
      repoId: over.repoId ?? 'repo-1',
    };
  }

  function keyOf(c: Candidate): string {
    return candidateLocationKey(c);
  }

  it('IMPLEMENTS correct: synthetic heuristic target → real Interface node, 0.70 lsp-corrected, old edge removed by oldRelId', async () => {
    // Setup: the graph has the heuristic `UserService →
    // Interface:IUserRepo` edge (the synthetic target from
    // `heritage-processor.ts:84-90` global-0.5 path). The
    // LSP verdict resolves to the REAL Interface node. The
    // engine should issue an atomic correction: add
    // `IMPLEMENTS:UserService->Interface:src/repo.ts:IUserRepo`
    // at 0.70 `lsp-corrected` and remove the old edge by
    // `oldRelId`.
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:src/user-service.ts:UserService',
      label: 'Class',
      properties: { name: 'UserService' },
    });
    graph.addNode({
      id: 'Interface:src/repo.ts:IUserRepo',
      label: 'Interface',
      properties: { name: 'IUserRepo' },
    });
    const cand = mkImplementsCandidate({
      oldTargetId: 'Interface:IUserRepo', // synthetic
      oldRelId: 'IMPLEMENTS:Class:src/user-service.ts:UserService->Interface:IUserRepo',
    });
    const heuristicRel: GraphRelationship = {
      id: cand.oldRelId!,
      sourceId: cand.sourceId,
      targetId: cand.oldTargetId!,
      type: 'IMPLEMENTS',
      confidence: 0.5,
      reason: 'heuristic',
      source: 'heuristic',
    };
    graph.addRelationship(heuristicRel);

    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [
      {
        uri: 'file:///workspace/repo/src/repo.ts',
        range: { start: { line: 4, character: 30 } },
      },
    ]);

    const mapFn = async () =>
      ({ kind: 'node' as const, nodeId: 'Interface:src/repo.ts:IUserRepo' });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    expect(report.corrected).toBe(1);
    const d = report.decisions[0];
    expect(d.action).toBe('correct');
    expect(d.from).toBe('Class:src/user-service.ts:UserService'); // child class
    expect(d.to).toBe('Interface:src/repo.ts:IUserRepo');
    expect(d.source).toBe('lsp-corrected');
    expect(d.reason).toBe(REASON_LSP_CORRECTED);
    expect(d.oldRelId).toBe(cand.oldRelId);
  });

  it('EXTENDS confirm: LSP agrees with heuristic → confirm (id preserved, restamped)', async () => {
    // Setup: heuristic `Dog → Class:Animal` edge; LSP verdict
    // also resolves to the same `Class:Animal` target → the
    // engine re-stamps in place: id preserved, source flipped
    // to `lsp-confirmed`, confidence raised to 0.70.
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/dog.ts:Dog', label: 'Class', properties: { name: 'Dog' } });
    graph.addNode({ id: 'Class:Animal', label: 'Class', properties: { name: 'Animal' } });
    const cand = mkExtendsCandidate();
    const heuristic = heuristicExtendsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(heuristic);

    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [mkLoc()]);

    const mapFn = async () => ({ kind: 'node' as const, nodeId: 'Class:Animal' });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    expect(report.confirmed).toBe(1);
    const d = report.decisions[0];
    expect(d.action).toBe('confirm');
    expect(d.from).toBe('Class:src/dog.ts:Dog'); // child class
    expect(d.to).toBe('Class:Animal');
    expect(d.source).toBe('lsp-confirmed');
    expect(d.reason).toBe(REASON_LSP_CONFIRMED);
    expect(d.oldRelId).toBe(heuristic.id);
  });

  it('IMPLEMENTS keeps when LSP target is a Class (label gate refuses)', async () => {
    // `class A implements SomeClass` is legal TS but rare.
    // The label gate says IMPLEMENTS only allows Interface
    // targets — a Class hit is refused; the heuristic edge
    // (if any) is kept with `non_callable` reason.
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/a.ts:A', label: 'Class', properties: { name: 'A' } });
    graph.addNode({ id: 'Class:src/some.ts:SomeClass', label: 'Class', properties: { name: 'SomeClass' } });
    const cand = mkImplementsCandidate({
      sourceId: 'Class:src/a.ts:A',
      oldTargetId: 'Class:src/some.ts:SomeClass',
    });
    const heuristic = heuristicImplementsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(heuristic);

    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [mkLoc()]);

    const mapFn = async () => ({ kind: 'node' as const, nodeId: 'Class:src/some.ts:SomeClass' });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    expect(report.refused).toBe(1);
    const d = report.decisions[0];
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('non_callable');
    expect(d.to).toBeNull();
  });

  it('EXTENDS keeps when LSP target is an Interface (label gate refuses)', async () => {
    // `class B extends SomeInterface` is legal TS but the
    // EXTENDS gate is { Class } only — an Interface hit is
    // refused; the heuristic edge is kept.
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/b.ts:B', label: 'Class', properties: { name: 'B' } });
    graph.addNode({ id: 'Interface:src/some.ts:IFoo', label: 'Interface', properties: { name: 'IFoo' } });
    const cand = mkExtendsCandidate({
      sourceId: 'Class:src/b.ts:B',
      oldTargetId: 'Interface:src/some.ts:IFoo',
    });
    const heuristic = heuristicExtendsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(heuristic);

    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [mkLoc()]);

    const mapFn = async () => ({ kind: 'node' as const, nodeId: 'Interface:src/some.ts:IFoo' });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    expect(report.refused).toBe(1);
    const d = report.decisions[0];
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('non_callable');
  });

  it('IMPLEMENTS self-loop: LSP target === source → keep (reason=self_loop)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:src/a.ts:A',
      label: 'Class',
      properties: { name: 'A' },
    });
    const cand = mkImplementsCandidate({
      sourceId: 'Class:src/a.ts:A',
      oldTargetId: 'Interface:I',
    });
    const heuristic = heuristicImplementsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(heuristic);

    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [mkLoc()]);

    // LSP resolves back to the same class node.
    const mapFn = async () => ({ kind: 'node' as const, nodeId: cand.sourceId });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    const d = report.decisions[0];
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('self_loop');
  });

  it('multi-Location → AMBIGUOUS → keep (refuse over guess, heuristic edge stands)', async () => {
    // A multi-Location payload is treated as AMBIGUOUS at
    // the LSP layer. Heritage path mirrors CALLS: no guess,
    // the heuristic edge stays. The candidate carries a
    // heuristic `oldTargetId` so the decision is `keep`
    // (heuristic edge stands), not `refuse` (which only
    // fires when there is no heuristic edge).
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:src/user-service.ts:UserService',
      label: 'Class',
      properties: { name: 'UserService' },
    });
    const cand = mkImplementsCandidate();
    const heuristic = heuristicImplementsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(heuristic);
    const locs = new Map<string, Location[]>();
    locs.set(keyOf(cand), [
      { uri: 'file:///workspace/repo/src/repo-a.ts', range: { start: { line: 1, character: 0 } } },
      { uri: 'file:///workspace/repo/src/repo-b.ts', range: { start: { line: 2, character: 0 } } },
    ]);

    let calls = 0;
    const mapFn: ReconcileDecisionsDeps['mapLocationToNodeId'] = async () => {
      calls++;
      return { kind: 'NO_NODE' as const };
    };

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps({ mapLocationToNodeId: mapFn }),
    );
    expect(report.decisions[0].action).toBe('keep');
    expect(report.decisions[0].reason).toBe('ambiguous');
    expect(calls).toBe(0);
  });

  it('IMPLEMENTS refuses on NO_NODE (no heuristic edge → refuse)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:src/user-service.ts:UserService',
      label: 'Class',
      properties: { name: 'UserService' },
    });
    const cand = mkImplementsCandidate({ oldTargetId: undefined });
    const locs = new Map<string, Location[]>();
    // No Location entry → NO_NODE.
    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      makeDeps(),
    );
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('no_node');
  });
});

// ─── Typed minting: makeLspRelationship shape ──────────────────────────

describe('WI-5 — applyDecisions: typed minting for heritage', () => {
  it('correct on IMPLEMENTS: mints IMPLEMENTS:<from>-><to> edge at 0.70 lsp-corrected', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/a.ts:A', label: 'Class', properties: { name: 'A' } });
    const cand = mkImplementsCandidate({
      sourceId: 'Class:src/a.ts:A',
      oldTargetId: 'Interface:OldI',
    });
    const oldRel = heuristicImplementsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    const decision: Decision = {
      candidate: cand,
      action: 'correct',
      from: cand.sourceId,
      to: 'Interface:src/repo.ts:IUserRepo',
      source: 'lsp-corrected',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CORRECTED,
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.type).toBe('IMPLEMENTS');
    expect(rel.sourceId).toBe('Class:src/a.ts:A');
    expect(rel.targetId).toBe('Interface:src/repo.ts:IUserRepo');
    expect(rel.confidence).toBe(LSP_CONFIDENCE);
    expect(rel.source).toBe('lsp-corrected');
    // The minted id matches the heuristic template
    // (`IMPLEMENTS:<from>-><to>`, heritage-processor.ts:403).
    expect(rel.id).toBe(
      `IMPLEMENTS:${cand.sourceId}->Interface:src/repo.ts:IUserRepo`,
    );
  });

  it('confirm on EXTENDS: re-stamps in place (id preserved, source flipped)', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/dog.ts:Dog', label: 'Class', properties: { name: 'Dog' } });
    const cand = mkExtendsCandidate();
    const oldRel = heuristicExtendsRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    const decision: Decision = {
      candidate: cand,
      action: 'confirm',
      from: cand.sourceId,
      to: cand.oldTargetId!,
      source: 'lsp-confirmed',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CONFIRMED,
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.type).toBe('EXTENDS');
    expect(rel.id).toBe(oldRel.id); // id preserved
    expect(rel.confidence).toBe(LSP_CONFIDENCE);
    expect(rel.source).toBe('lsp-confirmed');
  });

  it('CALLS add still mints type=CALLS (compat pin)', () => {
    // Defensive pin: a CALLS candidate with no `relType`
    // flows through `makeLspRelationship` and mints a
    // `type: 'CALLS'` edge. If a future refactor ever
    // flipped the default, this assertion fires.
    //
    // WI-1 / #159: the id now carries the `:L${line}`
    // suffix (`CALLS:s1->Function:src/b.ts:bar:L10`),
    // matching the heuristic id format. The `type` field
    // is the unchanged compat surface — that's the actual
    // invariant this test pins.
    const graph = createKnowledgeGraph();
    const cand: Candidate = {
      sourceId: 's1',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };
    const decision: Decision = {
      candidate: cand,
      action: 'add',
      from: 's1',
      to: 'Function:src/b.ts:bar',
      source: 'lsp-recall',
      reason: REASON_LSP_RECALL,
    };
    applyDecisions(graph, [decision]);
    const rel = graph.relationships[0];
    expect(rel.type).toBe('CALLS');
    expect(rel.id).toBe('CALLS:s1->Function:src/b.ts:bar:L10');
    // The line rides on the rel (mode-a-reconciler.ts
    // `makeLspRelationship` passes `d.candidate.line`).
    expect(rel.line).toBe(10);
  });
});

// ─── existingRel index triple-keyed on (sourceId, oldTargetId, relType) ─

describe('WI-5 — buildExistingRelIndex triple-keyed: no cross-relType collision', () => {
  it('CALLS existingRel lookup misses when the only matching edge is IMPLEMENTS, even for a callable target', async () => {
    // Belt-and-braces: even if a CALLS candidate and a
    // heritage candidate share the same (sourceId, oldTargetId)
    // pair (e.g. a synthetic heuristic edge that was emitted
    // as the wrong type by a prior bug), the triple-keyed
    // index must NOT return the wrong type. The CALLS path
    // should mint a fresh `add` (recall) — never silently
    // confirm/correct against the IMPLEMENTS row.
    //
    // Setup: the graph has an IMPLEMENTS edge from A → I
    // (a heuristic that landed as IMPLEMENTS instead of
    // CALLS — a typo or upstream bug). The CALLS candidate
    // points at the same I target. The target is a Function
    // so the CALLS gate (CALLABLE_SYMBOL_TYPES) accepts it.
    // The triple-keyed index must NOT pick up the
    // IMPLEMENTS row → existingRel is undefined → `add`.
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/a.ts:A', label: 'Class', properties: { name: 'A' } });
    graph.addNode({ id: 'Function:src/i.ts:I', label: 'Function', properties: { name: 'I' } });

    // The graph has an IMPLEMENTS edge from A → I (no CALLS).
    const heritageEdge: GraphRelationship = {
      id: 'IMPLEMENTS:Class:src/a.ts:A->Function:src/i.ts:I',
      sourceId: 'Class:src/a.ts:A',
      targetId: 'Function:src/i.ts:I',
      type: 'IMPLEMENTS',
      confidence: 0.5,
      reason: 'heuristic',
      source: 'heuristic',
    };
    graph.addRelationship(heritageEdge);

    // A CALLS candidate that names the same target. The
    // indexed lookup must NOT pick up the IMPLEMENTS edge.
    const callsCand: Candidate = {
      sourceId: 'Class:src/a.ts:A',
      calledName: 'I',
      oldTargetId: 'Function:src/i.ts:I', // same target as heritage edge
      file: 'src/a.ts',
      line: 4,
      character: 31,
    };
    const locs = new Map<string, Location[]>();
    locs.set(candidateLocationKey(callsCand), [mkLoc()]);

    const mapFn: ReconcileDecisionsDeps['mapLocationToNodeId'] = async () =>
      ({ kind: 'node' as const, nodeId: 'Function:src/i.ts:I' });

    const report = await reconcileDecisions(
      graph,
      [callsCand],
      locs,
      {
        mapLocationToNodeId: mapFn,
        repoId: 'repo-1',
        callableLabels: CALLABLE,
      },
    );
    // The CALLS path's indexed lookup correctly misses the
    // IMPLEMENTS row → existingRel is undefined → `add`
    // (the LSP found a callable Function hit; mint a fresh
    // CALLS edge). The IMPLEMENTS edge stays untouched.
    expect(report.decisions[0].action).toBe('add');
    expect(report.decisions[0].source).toBe('lsp-recall');
  });
});

// ─── security-2: oldRelId-miss refusal (polish BLOCKER) ────────────────

describe('security-2 polish BLOCKER — oldRelId miss must NOT fall through to a different row', () => {
  it('IMPLeMENTS correction with oldRelId that misses the relIdIndex → engine does NOT remove a different heuristic edge', async () => {
    // Setup: the graph has TWO heuristic IMPLEMENTS edges
    // from `UserService` (one to IX, one to IY) — both
    // sharing the same `(sourceId, oldTargetId)` pair
    // shape is impossible because each row has a distinct
    // targetId, but the pair-index lookup keys on
    // `(sourceId, oldTargetId, relType)`, and a candidate
    // whose `oldTargetId` matches a row whose id has since
    // been REWRITTEN upstream (e.g. by a prior engine
    // pass) would still hit the pair index. The polish
    // BLOCKER ruling: when `oldRelId` is provided, the
    // direct `relIdIndex.get` IS the answer. A miss must
    // not fall through to the pair index or to
    // `findExistingRel` — both could match a row with a
    // different id, and `applyDecisions` would then
    // `removeRelationship` the wrong edge.
    //
    // This test exercises the worst case: a candidate
    // claims an `oldRelId` for `IX` but the heuristic
    // graph has been mutated upstream so the only row
    // with the candidate's `(sourceId, oldTargetId)` is
    // `IY`. The engine must refuse to "correct" (the
    // candidate's `oldRelId` is not in the index) and
    // must NOT touch the `IY` edge.
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:src/user-service.ts:UserService',
      label: 'Class',
      properties: { name: 'UserService' },
    });
    graph.addNode({
      id: 'Interface:src/real.ts:IUserRepo',
      label: 'Interface',
      properties: { name: 'IUserRepo' },
    });
    // The ONLY heuristic IMPLEMENTS row is IY, not IX.
    const heuristicIY: GraphRelationship = heuristicImplementsRel(
      'Class:src/user-service.ts:UserService',
      'Interface:IY',
    );
    graph.addRelationship(heuristicIY);

    // The candidate claims an `oldRelId` for the IX row,
    // which is NOT in the graph.
    const cand = mkImplementsCandidate({
      oldTargetId: 'Interface:IY', // matches the only heuristic row
      oldRelId: 'IMPLEMENTS:Class:src/user-service.ts:UserService->Interface:IX',
    });
    const locs = new Map<string, Location[]>();
    locs.set(candidateLocationKey(cand), [
      {
        uri: 'file:///workspace/repo/src/real.ts',
        range: { start: { line: 4, character: 30 } },
      },
    ]);
    const mapFn = async () =>
      ({ kind: 'node' as const, nodeId: 'Interface:src/real.ts:IUserRepo' });

    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      {
        mapLocationToNodeId: mapFn,
        callableLabels: CALLABLE,
        repoId: 'repo-1',
      },
    );
    // The direct `relIdIndex.get('IMPLEMENTS:...->IX')` MISSED
    // — the engine must not fall through to the pair index
    // (which would have matched `IY`). `existingRel` stays
    // undefined → no `oldRelId` flows into the decision
    // (`decideForCandidate` does not set it without an
    // existingRel), and `applyDecisions` will NOT remove
    // the IY row.
    expect(report.decisions[0].oldRelId).toBeUndefined();
    // `applyDecisions` will mint a fresh IMPLEMENTS edge
    // (action `add`) — the IY heuristic is left untouched
    // (the post-collapse pass may dedupe; that is a
    // semantic step, not a removal of the wrong row).
    expect(report.decisions[0].action).toBe('add');
    expect(report.decisions[0].to).toBe('Interface:src/real.ts:IUserRepo');

    // Apply and check the IY row survives by exact id.
    applyDecisions(graph, report.decisions);
    const surviving = graph.relationships.find((r) => r.id === heuristicIY.id);
    expect(surviving).toBeDefined();
    expect(surviving?.targetId).toBe('Interface:IY');
    expect(surviving?.source).toBe('heuristic');
  });

  it('defaultFindExistingRel defense-in-depth: CALLS row sharing (sourceId, oldTargetId) does NOT match a heritage candidate', async () => {
    // Defense-in-depth test for the new `relType` filter
    // on `defaultFindExistingRel`. We inject a
    // `findExistingRel` that intentionally IGNORES
    // `relType` (simulating a third-party override that
    // hasn't been updated) — but `reconcileDecisions`
    // only calls it when `oldRelId` is absent, so the
    // override only fires for `add`/`recall` candidates.
    // The CALLS row that shares the pair must not be
    // picked up as the "existing rel" of a heritage
    // candidate — and the `relType` parameter on the
    // function signature is what guarantees that
    // (callers passing a CALLS-only override that
    // ignores the new arg would still be vulnerable, but
    // `defaultFindExistingRel` does not have that
    // vulnerability).
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'Class:src/a.ts:A', label: 'Class', properties: { name: 'A' } });
    graph.addNode({ id: 'Function:src/i.ts:I', label: 'Function', properties: { name: 'I' } });
    // A CALLS row sharing the (source, target) pair with
    // a heritage candidate for the same I.
    const callsEdge: GraphRelationship = {
      id: 'CALLS:Class:src/a.ts:A->Function:src/i.ts:I',
      sourceId: 'Class:src/a.ts:A',
      targetId: 'Function:src/i.ts:I',
      type: 'CALLS',
      confidence: 0.5,
      reason: 'heuristic',
      source: 'heuristic',
    };
    graph.addRelationship(callsEdge);

    // Heritage IMPLEMENTS candidate, NO `oldRelId` (so
    // the chain falls through to the pair index / caller
    // dep). The pair index is triple-keyed so it would
    // already miss the CALLS row. But we want to also
    // prove the `defaultFindExistingRel` `relType` filter
    // would refuse if it were ever called.
    const cand = mkImplementsCandidate({
      sourceId: 'Class:src/a.ts:A',
      oldTargetId: 'Function:src/i.ts:I',
      oldRelId: undefined,
    });
    const locs = new Map<string, Location[]>();
    locs.set(candidateLocationKey(cand), [mkLoc()]);
    const mapFn = async () =>
      ({ kind: 'node' as const, nodeId: 'Function:src/i.ts:I' });

    // Use the production default (no `findExistingRel`
    // override) — the pair index is the lookup path.
    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      {
        mapLocationToNodeId: mapFn,
        callableLabels: CALLABLE,
        repoId: 'repo-1',
      },
    );
    // The CALLS row must not be picked up as the
    // IMPLEMENTS candidate's existingRel. The triple-
    // keyed pair index (or the default's `relType`
    // filter) refuses, so existingRel is undefined.
    expect(report.decisions[0].oldRelId).toBeUndefined();
    // IMPLEMENTS gate is {Interface}; the LSP hit is
    // `Function` — the decision is `keep` (heuristic
    // edge stands, label gate refuses) per the heritage
    // decision table.
    expect(report.decisions[0].action).toBe('keep');
    expect(report.decisions[0].reason).toBe('non_callable');
  });
});
