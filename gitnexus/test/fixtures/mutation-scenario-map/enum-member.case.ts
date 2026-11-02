// Scenario-map controls fixture (Phase 1 U17), adversarial pair `enum-member` (KTD6 residual-
// difference guard): the bodies differ only in a const-object member passed outside the expect
// subject. No literal differs and no mutant tells the members apart. Expected: Review
// (expected.json, which records the plan conflict for this pair).
import { describe, expect, it } from 'vitest';
import { MiniGraph, NodeLabel } from './src/enum-member.js';

describe('enum-member', () => {
  it('finds a callable after adding a function node', () => {
    const graph = new MiniGraph();
    graph.addNode(NodeLabel.Function);
    expect(graph.hasCallableNode()).toBe(true);
  });

  it('finds a callable after adding a method node', () => {
    const graph = new MiniGraph();
    graph.addNode(NodeLabel.Method);
    expect(graph.hasCallableNode()).toBe(true);
  });
});
