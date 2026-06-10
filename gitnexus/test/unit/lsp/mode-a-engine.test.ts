/**
 * Unit Tests: Mode A decision engine (WI-4b, issue #159 P3).
 *
 * The engine is the WRITE half of Mode A. It is a pure layer
 * on top of the session (WI-4a): the session issues LSP
 * `textDocument/definition` requests and hands the normalized
 * `Location[]` payload to the engine. The engine:
 *
 *   1. Maps the `Location[]` to a graph nodeId (via
 *      `mapLocationToNodeId` + the in-memory adapter from
 *      WI-3).
 *   2. Runs the P1∧P2 gate (mapper→node; label ∈
 *      `CALLABLE_SYMBOL_TYPES`).
 *   3. Selects an action from the decision table:
 *        confirm | correct | add | keep | refuse.
 *   4. Builds a `Decision` tuple (per-decision, no graph
 *      writes — the pure function `decideForCandidate`).
 *   5. `applyDecisions` mutates the in-memory graph with
 *      atomic correction + the final `(from,to,type)` collapse.
 *   6. `dryRun` skips every mutation but returns full tuples.
 *
 * Test surface: every decision-table cell, the callee gate
 * (AC-4), atomic correction (AC-5), collapse precedence, the
 * dryRun invariant (AC-6), the no-write invariant (AC-8).
 *
 * The test does NOT spawn a real LSP. The mapper and
 * `findExistingRel` are injected via the dep bag. The
 * `KnowledgeGraph` is built from `createKnowledgeGraph()`.
 */

import { describe, it, expect } from 'vitest';

import {
  decideForCandidate,
  applyDecisions,
  reconcileDecisions,
  LSP_CONFIDENCE,
  HEURISTIC_GLOBAL_CONFIDENCE,
  REASON_LSP_CONFIRMED,
  REASON_LSP_CORRECTED,
  REASON_LSP_RECALL,
  __engineTest__ as engineTest,
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
  mkCandidate,
  mkLoc,
  heuristicRel,
} from './mode-a-engine.fixtures.js';

// ─── Decision table — confirm (KD-5) ──────────────────────────────────

describe('WI-4b — decideForCandidate: confirm (LSP agrees with heuristic)', () => {
  it('global-0.50 → A, callable B==A → confirm (lsp-confirmed, 0.70, restamp oldRelId)', () => {
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/a.ts:foo' },
      { existingRel: rel, callableLabels: CALLABLE, targetLabel: 'Function' },
    );
    expect(decision.action).toBe('confirm');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBe('Function:src/a.ts:foo');
    expect(decision.source).toBe('lsp-confirmed');
    expect(decision.reason).toBe(REASON_LSP_CONFIRMED);
    expect(decision.oldRelId).toBe(rel.id);
    expect(decision.oldTargetId).toBe('Function:src/a.ts:foo');
  });
});

// ─── Decision table — correct (KD-5) ──────────────────────────────────

describe('WI-4b — decideForCandidate: correct (LSP disagrees with heuristic)', () => {
  it('global-0.50 → A, callable B≠A → correct (lsp-corrected, atomic remove+insert)', () => {
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/b.ts:bar' },
      { existingRel: rel, callableLabels: CALLABLE, targetLabel: 'Function' },
    );
    expect(decision.action).toBe('correct');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBe('Function:src/b.ts:bar');
    expect(decision.source).toBe('lsp-corrected');
    expect(decision.reason).toBe(REASON_LSP_CORRECTED);
    expect(decision.oldRelId).toBe(rel.id);
    expect(decision.oldTargetId).toBe('Function:src/a.ts:foo');
  });
});

// ─── Decision table — add (KD-5) ──────────────────────────────────────

describe('WI-4b — decideForCandidate: add (heuristic missed, LSP found it)', () => {
  it('no oldTargetId, callable B → add (lsp-recall, 0.70, no oldRelId)', () => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/b.ts:bar' },
      { callableLabels: CALLABLE, targetLabel: 'Function' },
    );
    expect(decision.action).toBe('add');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBe('Function:src/b.ts:bar');
    expect(decision.source).toBe('lsp-recall');
    expect(decision.reason).toBe(REASON_LSP_RECALL);
    expect(decision.oldRelId).toBeUndefined();
    expect(decision.oldTargetId).toBeUndefined();
  });

  it('oldTargetId present but no matching existingRel (stale feed) → add (recall)', () => {
    // The candidate carries an oldTargetId but the graph has
    // no matching edge. The decision table collapses this
    // into the `add` branch — we should mint a fresh edge
    // rather than treat the stale id as a confirm target.
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/b.ts:bar' },
      { existingRel: undefined, callableLabels: CALLABLE, targetLabel: 'Function' },
    );
    expect(decision.action).toBe('add');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBe('Function:src/b.ts:bar');
    expect(decision.source).toBe('lsp-recall');
  });
});

// ─── Decision table — keep (KD-4) ─────────────────────────────────────

describe('WI-4b — decideForCandidate: keep (heuristic stays, LSP refused)', () => {
  it('global-0.50 → A, LSP NO_NODE → keep (reason=no_node, no mutation)', () => {
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const decision = decideForCandidate(
      cand,
      { kind: 'NO_NODE' },
      { existingRel: rel, callableLabels: CALLABLE },
    );
    expect(decision.action).toBe('keep');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBeNull();
    expect(decision.source).toBeNull();
    expect(decision.reason).toBe('no_node');
    expect(decision.oldRelId).toBe(rel.id);
  });

  it('global-0.50 → A, LSP AMBIGUOUS → keep (reason=ambiguous, no mutation)', () => {
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const decision = decideForCandidate(
      cand,
      { kind: 'AMBIGUOUS' },
      { existingRel: rel, callableLabels: CALLABLE },
    );
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('ambiguous');
    expect(decision.to).toBeNull();
  });
});

// ─── Decision table — refuse (KD-4) ───────────────────────────────────

describe('WI-4b — decideForCandidate: refuse (no heuristic edge + LSP refused)', () => {
  it('no oldTargetId, LSP NO_NODE → refuse (reason=no_node, no edge minted)', () => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision = decideForCandidate(
      cand,
      { kind: 'NO_NODE' },
      { callableLabels: CALLABLE },
    );
    expect(decision.action).toBe('refuse');
    expect(decision.from).toBe(cand.sourceId);
    expect(decision.to).toBeNull();
    expect(decision.source).toBeNull();
    expect(decision.reason).toBe('no_node');
  });

  it('no oldTargetId, LSP AMBIGUOUS → refuse (reason=ambiguous, no edge minted)', () => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision = decideForCandidate(
      cand,
      { kind: 'AMBIGUOUS' },
      { callableLabels: CALLABLE },
    );
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('ambiguous');
  });
});

// ─── Callee-label precondition (AC-4 / I-3 / KD-3) ────────────────────

describe('WI-4b — callee gate: refuse non-callable Class hit', () => {
  it('Callable B is a Class → refuse on recall path (no CALLS→Class edge)', () => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Class:src/b.ts:Bar' },
      { callableLabels: CALLABLE, targetLabel: 'Class' },
    );
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('non_callable');
    expect(decision.to).toBeNull();
    expect(decision.source).toBeNull();
  });

  it('non-callable B (Class) on a heuristic edge → keep (no mutation, reason=non_callable)', () => {
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const decision = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Class:src/b.ts:Bar' },
      { existingRel: rel, callableLabels: CALLABLE, targetLabel: 'Class' },
    );
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('non_callable');
  });

  it.each([
    'Struct',
    'Interface',
    'Enum',
    'Trait',
    'TypeAlias',
  ])('non-callable B (%s) on recall → refuse', (label) => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const d = decideForCandidate(
      cand,
      { kind: 'node', nodeId: `${label}:src/b.ts:X` },
      { callableLabels: CALLABLE, targetLabel: label },
    );
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('non_callable');
  });

  it.each([
    'Function',
    'Method',
    'Constructor',
    'Macro',
    'Delegate',
  ])('callable B (%s) on recall → add (not refused)', (label) => {
    const cand = mkCandidate({ oldTargetId: undefined });
    const d = decideForCandidate(
      cand,
      { kind: 'node', nodeId: `${label}:src/b.ts:X` },
      { callableLabels: CALLABLE, targetLabel: label },
    );
    expect(d.action).toBe('add');
    expect(d.source).toBe('lsp-recall');
  });

  it('targetLabel=null (label unknown) → bypasses callee gate (defensive passthrough)', () => {
    // The `decideForCandidate` pure function is label-agnostic
    // when the upstream didn't provide a label (null). The
    // production path (`reconcileDecisions`) always resolves
    // the label from the in-memory node list; the null case
    // is only hit in tests that exercise the pure function in
    // isolation. The gate should not fire on a null label.
    const cand = mkCandidate({ oldTargetId: undefined });
    const d = decideForCandidate(
      cand,
      { kind: 'node', nodeId: 'Function:src/b.ts:bar' },
      { callableLabels: CALLABLE, targetLabel: null },
    );
    expect(d.action).toBe('add');
  });
});

// ─── Self-loop guard (EdgeCases self-loop row / I-8) ──────────────────

describe('WI-4b — self-loop guard: refuse when LSP target == source', () => {
  it('LSP target == source on recall → refuse (reason=self_loop)', () => {
    const cand = mkCandidate({ sourceId: 'Method:src/a.ts:foo', oldTargetId: undefined });
    const d = decideForCandidate(
      cand,
      { kind: 'node', nodeId: cand.sourceId },
      { callableLabels: CALLABLE, targetLabel: 'Method' },
    );
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('self_loop');
  });

  it('LSP target == source on heuristic edge → keep (reason=self_loop)', () => {
    const cand = mkCandidate({ sourceId: 'Method:src/a.ts:foo', oldTargetId: 'Function:src/a.ts:other' });
    const rel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    const d = decideForCandidate(
      cand,
      { kind: 'node', nodeId: cand.sourceId },
      { existingRel: rel, callableLabels: CALLABLE, targetLabel: 'Method' },
    );
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('self_loop');
  });
});

// ─── applyDecisions — mutations ───────────────────────────────────────

describe('WI-4b — applyDecisions: mutations', () => {
  it('add: inserts a fresh CALLS edge with confidence 0.70 and source=lsp-recall', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision: Decision = {
      candidate: cand,
      action: 'add',
      from: cand.sourceId,
      to: 'Function:src/b.ts:bar',
      source: 'lsp-recall',
      reason: REASON_LSP_RECALL,
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.sourceId).toBe(cand.sourceId);
    expect(rel.targetId).toBe('Function:src/b.ts:bar');
    expect(rel.confidence).toBe(LSP_CONFIDENCE);
    expect(rel.source).toBe('lsp-recall');
    expect(rel.reason).toBe(REASON_LSP_RECALL);
  });

  it('confirm: re-stamps the existing edge in place (id, source, confidence)', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    const decision: Decision = {
      candidate: cand,
      action: 'confirm',
      from: cand.sourceId,
      to: 'Function:src/a.ts:foo',
      source: 'lsp-confirmed',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CONFIRMED,
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.id).toBe(oldRel.id); // id preserved (collapse-stable)
    expect(rel.confidence).toBe(LSP_CONFIDENCE);
    expect(rel.source).toBe('lsp-confirmed');
  });

  it('keep: no mutation', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    const decision: Decision = {
      candidate: cand,
      action: 'keep',
      from: cand.sourceId,
      to: null,
      source: null,
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: 'no_node',
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.confidence).toBe(HEURISTIC_GLOBAL_CONFIDENCE);
    expect(rel.source).toBe('heuristic');
  });

  it('refuse: no mutation (and no edge minted)', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision: Decision = {
      candidate: cand,
      action: 'refuse',
      from: cand.sourceId,
      to: null,
      source: null,
      reason: 'no_node',
    };
    const result = applyDecisions(graph, [decision]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(graph.relationshipCount).toBe(0);
  });
});

// ─── Atomic correction: never net-delete (AC-5 / I-4 / KD-8) ──────────

describe('WI-4b — atomic correction: never net-deletes on collision', () => {
  it('correct: removes old edge + inserts new edge (idempotent on (from,to,type) collapse)', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    // The new target. A correction from A → B.
    const newTarget = 'Function:src/b.ts:bar';
    const decision: Decision = {
      candidate: cand,
      action: 'correct',
      from: cand.sourceId,
      to: newTarget,
      source: 'lsp-corrected',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CORRECTED,
    };
    const result = applyDecisions(graph, [decision]);
    // Atomic correction: 1 add + 1 remove.
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(graph.relationshipCount).toBe(1);
    const rel = graph.relationships[0];
    expect(rel.targetId).toBe(newTarget);
    expect(rel.source).toBe('lsp-corrected');
    expect(rel.confidence).toBe(LSP_CONFIDENCE);
  });

  it('correct on a higher-tier collision: pre-existing lsp-corrected edge wins; correction does not net-delete', () => {
    // The I-4 / KD-8 invariant under collision. The graph
    // has TWO edges from `caller1`:
    //   - caller1 → A   (heuristic 0.50, OLD)
    //   - caller1 → B   (lsp-corrected 0.70, NEW — a prior
    //                    reconciler pass already corrected
    //                    the same candidate to a different
    //                    target. The new target is the
    //                    "higher-tier" row this comment refers
    //                    to.)
    // The CURRENT `correct` decision has `oldTargetId=A` and
    // wants to write caller1 → B at 0.70. After the per-
    // decision add+remove (atomic correction):
    //   - caller1 → A is removed (the old target).
    //   - caller1 → B is re-added (the new row; the
    //     id is regenerated by `generateId`, so it's a
    //     different id from the pre-existing one).
    // The final collapse groups the two caller1→B rows
    // by (from,to,type) and keeps the higher-confidence
    // winner. With both rows at 0.70, the source-
    // precedence tiebreak picks `lsp-corrected` (the
    // pre-existing row, which has the lower id). The
    // pre-existing row is the survivor — the new
    // re-stamp row is dropped.
    //
    // Final graph: caller1 → B at 0.70, source =
    // `lsp-corrected`, id = the pre-existing id.
    // No net loss: the count stays at 2 (one A, one B),
    // then the collapse drops the duplicate B (count=1
    // after collapse), then A is removed by the
    // correction (count=1, just B).
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    // The pre-existing "higher-tier" row: a prior pass
    // already corrected this candidate to B at 0.70 with
    // `lsp-corrected`. This is the row the test would be
    // silently passing without.
    const higherTierTarget = 'Function:src/b.ts:bar';
    const higherTierRel: GraphRelationship = {
      id: 'CALLS:caller1->B:prior',
      sourceId: cand.sourceId,
      targetId: higherTierTarget,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: REASON_LSP_CORRECTED,
      source: 'lsp-corrected',
    };
    graph.addRelationship(higherTierRel);

    // The current correct decision — same target as the
    // pre-existing row. After apply, the per-decision
    // add+remove + collapse should NOT net-delete the
    // pre-existing B row.
    const decision: Decision = {
      candidate: cand,
      action: 'correct',
      from: cand.sourceId,
      to: higherTierTarget,
      source: 'lsp-corrected',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CORRECTED,
    };
    const result = applyDecisions(graph, [decision]);

    // Atomic correction invariant: the correction MUST FIRE —
    // exactly 1 remove (old A row) + exactly 1 add (new B row).
    // Without these, a no-op (0 ≤ 0) would silently satisfy
    // the weaker toBeLessThanOrEqual guard.
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    // removed ≤ added (redundant but pinned for documentation).
    expect(result.removed).toBeLessThanOrEqual(result.added);
    // The graph still has exactly one caller1→B edge —
    // never a net-deleted, never a duplicated outcome.
    const caller1Edges = graph.relationships.filter(
      (r) => r.sourceId === cand.sourceId,
    );
    expect(caller1Edges).toHaveLength(1);
    expect(caller1Edges[0].targetId).toBe(higherTierTarget);
    expect(caller1Edges[0].confidence).toBe(LSP_CONFIDENCE);
    expect(caller1Edges[0].source).toBe('lsp-corrected');
    // The pre-existing id is the survivor — the new
    // re-stamp row was dropped by the collapse.
    expect(caller1Edges[0].id).toBe(higherTierRel.id);
    // And the A row is gone (it was the `oldRelId`).
    expect(
      graph.relationships.find((r) => r.targetId === cand.oldTargetId),
    ).toBeUndefined();
  });

  it('correct adds collide with an existing (from,to,type) duplicate: collapse picks the higher-precedence winner; no net loss', () => {
    // I-4 / KD-8 invariant under duplicate-key collision.
    // Setup: the graph already has a `caller1 → B` row at
    // 0.70 from `lsp-corrected` (a prior pass wrote it).
    // The CURRENT candidate has `oldTargetId=A` and the
    // reconciler chose B again (the LSP verdict agrees
    // with the prior correction). The `correct` action
    // issues an atomic remove+insert that adds a SECOND
    // `caller1 → B` row. The post-decision collapse groups
    // the two rows on (caller1, B, CALLS) and keeps the
    // higher-precedence winner.
    //
    // Invariant pinned: regardless of which row the
    // collapse picks, the graph has exactly one
    // `caller1 → B` edge after `applyDecisions` returns;
    // the per-decision `removed ≤ added` contract holds;
    // the net edge count is preserved (no row is silently
    // dropped because the add collision short-circuited
    // the remove).
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    // The pre-existing duplicate row — same (from,to,type)
    // as the upcoming add. The id is distinct (the
    // `applyDecisions` path regenerates it via
    // `generateId`).
    const targetB = 'Function:src/b.ts:bar';
    const preExistingB: GraphRelationship = {
      id: 'CALLS:caller1->B:prior-pass',
      sourceId: cand.sourceId,
      targetId: targetB,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: REASON_LSP_CORRECTED,
      source: 'lsp-corrected',
    };
    graph.addRelationship(preExistingB);

    const decision: Decision = {
      candidate: cand,
      action: 'correct',
      from: cand.sourceId,
      to: targetB,
      source: 'lsp-corrected',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CORRECTED,
    };
    const result = applyDecisions(graph, [decision]);

    // Atomic correction liveness: the correction MUST FIRE.
    // An !addedOk guard that silently skips the remove would
    // leave result.removed=0 and result.added=0, satisfying
    // the weaker toBeLessThanOrEqual guard but making the
    // test a tautology.
    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    // Atomic correction contract: per-decision removed ≤
    // added (no net loss at the per-decision step).
    expect(result.removed).toBeLessThanOrEqual(result.added);
    // The collapse MUST have removed at least one duplicate
    // (the add collision on (caller1, B, CALLS) left two
    // rows in the graph; the collapse prunes to one).
    expect(result.collapsed).toBeGreaterThanOrEqual(1);
    // Graph has exactly one caller1 → B edge.
    const bEdges = graph.relationships.filter(
      (r) => r.sourceId === cand.sourceId && r.targetId === targetB,
    );
    expect(bEdges).toHaveLength(1);
    expect(bEdges[0].source).toBe('lsp-corrected');
    expect(bEdges[0].confidence).toBe(LSP_CONFIDENCE);
    // The A row is gone.
    expect(
      graph.relationships.find((r) => r.targetId === cand.oldTargetId),
    ).toBeUndefined();
  });
});

// ─── Collapse: one edge per (from,to,type) (AC-5 / I-4) ──────────────

describe('WI-4b — collapse: one edge per (from,to,type) with conf-DESC precedence', () => {
  it('two rows with same (from,to,type) and different confidence → keep higher confidence', () => {
    const graph = createKnowledgeGraph();
    const sourceId = 'src:1';
    const targetId = 'Function:src/b.ts:bar';
    // Lower-confidence (heuristic 0.50) inserted FIRST.
    const low: GraphRelationship = {
      id: 'CALLS:low',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: HEURISTIC_GLOBAL_CONFIDENCE,
      reason: 'fuzzy-global',
      source: 'heuristic',
    };
    const high: GraphRelationship = {
      id: 'CALLS:high',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: 'lsp-recall',
      source: 'lsp-recall',
    };
    graph.addRelationship(low);
    graph.addRelationship(high);

    const result = engineTest.collapseDuplicates(graph);
    expect(result).toBe(1);
    expect(graph.relationshipCount).toBe(1);
    expect(graph.relationships[0].id).toBe('CALLS:high');
  });

  it('source-precedence tiebreak: lsp-corrected > lsp-recall > lsp-confirmed > heuristic at same confidence', () => {
    // Four rows, same (from,to,type), same confidence, different
    // source. The collapse must keep lsp-corrected.
    const graph = createKnowledgeGraph();
    const sourceId = 'src:1';
    const targetId = 'Function:src/b.ts:bar';
    for (const s of ['heuristic', 'lsp-confirmed', 'lsp-recall', 'lsp-corrected'] as const) {
      graph.addRelationship({
        id: `CALLS:${s}`,
        sourceId,
        targetId,
        type: 'CALLS',
        confidence: LSP_CONFIDENCE,
        reason: s,
        source: s,
      });
    }
    engineTest.collapseDuplicates(graph);
    expect(graph.relationshipCount).toBe(1);
    expect(graph.relationships[0].source).toBe('lsp-corrected');
  });

  it('id-ASC tiebreak: when conf and source are equal, lowest id wins', () => {
    const graph = createKnowledgeGraph();
    const sourceId = 'src:1';
    const targetId = 'Function:src/b.ts:bar';
    graph.addRelationship({
      id: 'CALLS:z',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: 'lsp-recall',
      source: 'lsp-recall',
    });
    graph.addRelationship({
      id: 'CALLS:a',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: 'lsp-recall',
      source: 'lsp-recall',
    });
    engineTest.collapseDuplicates(graph);
    expect(graph.relationshipCount).toBe(1);
    expect(graph.relationships[0].id).toBe('CALLS:a');
  });

  it('no duplicates → no removals, no mutation', () => {
    const graph = createKnowledgeGraph();
    graph.addRelationship(heuristicRel('s1', 't1'));
    graph.addRelationship(heuristicRel('s1', 't2'));
    graph.addRelationship(heuristicRel('s2', 't1'));
    const result = engineTest.collapseDuplicates(graph);
    expect(result).toBe(0);
    expect(graph.relationshipCount).toBe(3);
  });
});

// ─── dryRun: mutates nothing, returns full tuples (AC-6 / KD-11) ─────

describe('WI-4b — applyDecisions dryRun: mutates nothing, returns full tuples', () => {
  it('dryRun=true on add: graph unchanged, added=0, removed=0, decision returned', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: undefined });
    const decision: Decision = {
      candidate: cand,
      action: 'add',
      from: cand.sourceId,
      to: 'Function:src/b.ts:bar',
      source: 'lsp-recall',
      reason: REASON_LSP_RECALL,
    };
    const result = applyDecisions(graph, [decision], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.collapsed).toBe(0);
    expect(graph.relationshipCount).toBe(0);
    // The decision is returned verbatim (so the report can
    // print it).
    expect(result.decisions).toEqual([decision]);
  });

  it('dryRun=true on correct: graph unchanged, decision returned', () => {
    const graph = createKnowledgeGraph();
    const cand = mkCandidate({ oldTargetId: 'Function:src/a.ts:foo' });
    const oldRel = heuristicRel(cand.sourceId, cand.oldTargetId!);
    graph.addRelationship(oldRel);

    const decision: Decision = {
      candidate: cand,
      action: 'correct',
      from: cand.sourceId,
      to: 'Function:src/b.ts:bar',
      source: 'lsp-corrected',
      oldTargetId: cand.oldTargetId,
      oldRelId: oldRel.id,
      reason: REASON_LSP_CORRECTED,
    };
    const result = applyDecisions(graph, [decision], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(graph.relationshipCount).toBe(1);
    expect(graph.relationships[0].id).toBe(oldRel.id);
    expect(graph.relationships[0].source).toBe('heuristic');
  });

  it('dryRun=true on a duplicate set: NO collapse is performed', () => {
    const graph = createKnowledgeGraph();
    const sourceId = 'src:1';
    const targetId = 'Function:src/b.ts:bar';
    graph.addRelationship({
      id: 'CALLS:a',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: HEURISTIC_GLOBAL_CONFIDENCE,
      reason: 'heuristic',
      source: 'heuristic',
    });
    graph.addRelationship({
      id: 'CALLS:b',
      sourceId,
      targetId,
      type: 'CALLS',
      confidence: LSP_CONFIDENCE,
      reason: 'lsp-recall',
      source: 'lsp-recall',
    });
    const result = applyDecisions(graph, [], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.collapsed).toBe(0);
    // The duplicates are STILL present (no collapse ran).
    expect(graph.relationshipCount).toBe(2);
  });
});

// ─── reconcileDecisions (top-level dispatch) ──────────────────────────

describe('WI-4b — reconcileDecisions: end-to-end dispatch', () => {
  function makeDeps(over: Partial<ReconcileDecisionsDeps> = {}): ReconcileDecisionsDeps {
    return {
      mapLocationToNodeId: over.mapLocationToNodeId ?? (async () => ({ kind: 'NO_NODE' as const })),
      findExistingRel: over.findExistingRel ?? ((g, s, t) => {
        for (const r of g.iterRelationships()) {
          if (r.sourceId === s && r.targetId === t) return r;
        }
        return undefined;
      }),
      callableLabels: over.callableLabels ?? CALLABLE,
      repoId: over.repoId ?? 'repo-1',
    };
  }

  it('returns counters that match the action distribution (confirm/correct/add/keep/refuse)', async () => {
    const graph = createKnowledgeGraph();
    const locs = new Map<string, Location[]>();
    const candidates: Candidate[] = [
      mkCandidate({ oldTargetId: 'Function:src/a.ts:foo', sourceId: 's1' }),
      mkCandidate({ oldTargetId: 'Function:src/a.ts:foo', sourceId: 's2' }),
      mkCandidate({ oldTargetId: undefined, sourceId: 's3' }),
      mkCandidate({ oldTargetId: undefined, sourceId: 's4' }),
    ];
    // s1 → confirm, s2 → correct, s3 → add, s4 → refuse.
    graph.addNode({ id: 's1', label: 'Method', properties: { name: 's1' } });
    graph.addNode({ id: 's2', label: 'Method', properties: { name: 's2' } });
    graph.addNode({ id: 's3', label: 'Method', properties: { name: 's3' } });
    graph.addNode({ id: 's4', label: 'Method', properties: { name: 's4' } });
    graph.addNode({ id: 'Function:src/a.ts:foo', label: 'Function', properties: { name: 'foo' } });
    graph.addNode({ id: 'Function:src/b.ts:bar', label: 'Function', properties: { name: 'bar' } });
    graph.addRelationship(heuristicRel('s1', 'Function:src/a.ts:foo'));
    graph.addRelationship(heuristicRel('s2', 'Function:src/a.ts:foo'));

    const key = (c: Candidate) => `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`;
    for (const c of candidates) locs.set(key(c), [mkLoc()]);

    const mapFn = async (loc: Location) => {
      if (candidates[0] && locs.get(key(candidates[0]))?.includes(loc)) {
        return { kind: 'node' as const, nodeId: 'Function:src/a.ts:foo' }; // s1 confirm
      }
      if (candidates[1] && locs.get(key(candidates[1]))?.includes(loc)) {
        return { kind: 'node' as const, nodeId: 'Function:src/b.ts:bar' }; // s2 correct
      }
      if (candidates[2] && locs.get(key(candidates[2]))?.includes(loc)) {
        return { kind: 'node' as const, nodeId: 'Function:src/b.ts:bar' }; // s3 add
      }
      return { kind: 'NO_NODE' as const }; // s4 refuse
    };

    const report = await reconcileDecisions(graph, candidates, locs, makeDeps({ mapLocationToNodeId: mapFn }));
    expect(report.confirmed).toBe(1);
    expect(report.corrected).toBe(1);
    expect(report.recall).toBe(1);
    expect(report.refused).toBe(1);
    expect(report.decisions).toHaveLength(4);
    expect(report.decisions[0].action).toBe('confirm');
    expect(report.decisions[1].action).toBe('correct');
    expect(report.decisions[2].action).toBe('add');
    expect(report.decisions[3].action).toBe('refuse');
  });

  it('multi-Location (length>1) is treated as AMBIGUOUS at the LSP layer (refuse over guess)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'src:1', label: 'Method', properties: { name: 'caller' } });
    const cand = mkCandidate({ oldTargetId: undefined });
    const locs = new Map<string, Location[]>();
    locs.set(`${cand.sourceId}|${cand.calledName}|${cand.line}|${cand.character}`, [
      mkLoc({ range: { start: { line: 1, character: 0 } } }),
      mkLoc({ range: { start: { line: 2, character: 0 } } }),
    ]);
    const mapFn = vi_fn_no_map();
    const report = await reconcileDecisions(graph, [cand], locs, makeDeps({ mapLocationToNodeId: mapFn }));
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('ambiguous');
    expect(mapFn.getCalls()).toBe(0);
  });

  it('mapper throws → treated as NO_NODE (refuse over guess)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'src:1', label: 'Method', properties: { name: 'caller' } });
    const cand = mkCandidate({ oldTargetId: undefined });
    const locs = new Map<string, Location[]>();
    locs.set(`${cand.sourceId}|${cand.calledName}|${cand.line}|${cand.character}`, [mkLoc()]);
    const mapFn = async () => {
      throw new Error('mapper crashed');
    };
    const report = await reconcileDecisions(graph, [cand], locs, makeDeps({ mapLocationToNodeId: mapFn }));
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('no_node');
  });

  it('callee-label gate fires via the in-memory graph lookup (Class hit refused)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'src:1', label: 'Method', properties: { name: 'caller' } });
    graph.addNode({ id: 'Class:src/b.ts:Bar', label: 'Class', properties: { name: 'Bar' } });
    const cand = mkCandidate({ oldTargetId: undefined });
    const locs = new Map<string, Location[]>();
    locs.set(`${cand.sourceId}|${cand.calledName}|${cand.line}|${cand.character}`, [mkLoc()]);
    const mapFn = async () => ({ kind: 'node' as const, nodeId: 'Class:src/b.ts:Bar' });
    const report = await reconcileDecisions(graph, [cand], locs, makeDeps({ mapLocationToNodeId: mapFn }));
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('non_callable');
  });

  it('callableLabels: undefined exercises the production ?? CALLABLE_SYMBOL_TYPES fallback and still refuses a Class hit', async () => {
    // M2 (AC-4): when callers of `reconcileDecisions` omit
    // `callableLabels` (undefined), the reconciler falls back
    // to `CALLABLE_SYMBOL_TYPES` from call-processor.ts
    // (mode-a-reconciler.ts:~1473). This test passes
    // `callableLabels: undefined` explicitly so that the
    // `?? CALLABLE_SYMBOL_TYPES` branch is the ONLY active
    // gate — proving the fallback is correctly wired.
    //
    // A Class target must still be refused, even without an
    // explicit `callableLabels` argument. If the fallback
    // were broken (e.g. replaced with `new Set()` or omitted
    // entirely), the callee gate would silently pass a Class
    // hit as `add`, and this test would fail.
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'src:1', label: 'Method', properties: { name: 'caller' } });
    graph.addNode({ id: 'Class:src/b.ts:Bar', label: 'Class', properties: { name: 'Bar' } });
    const cand = mkCandidate({ oldTargetId: undefined });
    const locs = new Map<string, Location[]>();
    locs.set(`${cand.sourceId}|${cand.calledName}|${cand.line}|${cand.character}`, [mkLoc()]);
    const mapFn = async () => ({ kind: 'node' as const, nodeId: 'Class:src/b.ts:Bar' });
    // Omit callableLabels entirely — exercises the ?? fallback.
    const report = await reconcileDecisions(
      graph,
      [cand],
      locs,
      {
        mapLocationToNodeId: mapFn,
        repoId: 'repo-1',
        // callableLabels is intentionally absent — must resolve
        // to CALLABLE_SYMBOL_TYPES from call-processor.ts.
      },
    );
    expect(report.decisions[0].action).toBe('refuse');
    expect(report.decisions[0].reason).toBe('non_callable');
  });
});

// Tiny test helper — returns a plain async fn plus a manual
// call counter so the test can assert "not called" without
// needing vi.
function vi_fn_no_map() {
  let calls = 0;
  const f: any = async () => {
    calls++;
    return { kind: 'NO_NODE' as const };
  };
  (f as any).getCalls = () => calls;
  return f;
}

// ─── Confidence + reason constants are pinned ─────────────────────────

describe('WI-4b — exported constants', () => {
  it('LSP_CONFIDENCE is 0.70 (KD-6)', () => {
    expect(LSP_CONFIDENCE).toBe(0.7);
  });
  it('HEURISTIC_GLOBAL_CONFIDENCE is 0.50', () => {
    expect(HEURISTIC_GLOBAL_CONFIDENCE).toBe(0.5);
  });
  it('reason constants are the exact strings the spec uses', () => {
    expect(REASON_LSP_CONFIRMED).toBe('lsp-confirmed');
    expect(REASON_LSP_CORRECTED).toBe('lsp-corrected');
    expect(REASON_LSP_RECALL).toBe('lsp-recall');
  });
});

// ─── No-write invariant: the SUT does not import a DB writer ─────────

describe('WI-4b — no-write invariant: mode-a-reconciler.ts does not import a LadybugDB writer', () => {
  it('reconciler source does not import addRelationship / executeQuery / initLbug from lbug-adapter', async () => {
    // AC-8: `core/ingestion/mode-a-reconciler.ts` must NEVER
    // import the LadybugDB write API. The reconciler is
    // allowed to call the IN-MEMORY graph's `addRelationship`
    // (a different function from the lbug-adapter export), but
    // must never reach for the lbug-adapter write path.
    //
    // We scan the ACTUAL SUT source file — not this test file —
    // so the assertion fails if someone adds such an import to
    // the reconciler. Scanning the test file is a tautology
    // (the test never imports lbug-adapter either) and would
    // pass even if the production code had a violation.
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
    const sutPath = path.resolve(thisDir, '../../../src/core/ingestion/mode-a-reconciler.ts');
    const src = fs.readFileSync(sutPath, 'utf-8');
    // The SUT must not import addRelationship from lbug-adapter.
    expect(/import\s*\{[^}]*\baddRelationship\b[^}]*\}\s*from\s*['"][^'"]*lbug-adapter/.test(src)).toBe(false);
    // Nor executeQuery.
    expect(/import\s*\{[^}]*\bexecuteQuery\b[^}]*\}\s*from\s*['"][^'"]*lbug-adapter/.test(src)).toBe(false);
    // Nor initLbug.
    expect(/import\s*\{[^}]*\binitLbug\b[^}]*\}\s*from\s*['"][^'"]*lbug-adapter/.test(src)).toBe(false);
  });
});
