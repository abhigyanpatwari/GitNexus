/**
 * R: S4/RefClass definitions are named by the call's first argument only. A string
 * in any other argument (`contains = "Base"`, `valueClass = "numeric"`, the class
 * slot of `setMethod("show", "Derived", ...)`) is not a definition, so it must not
 * mint a graph node. End-to-end companion to the `R_QUERIES` unit test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, getNodesByLabel, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

function nodesByLabel(result: PipelineResult, label: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) out.push({ id: n.id, name: n.properties.name as string });
  });
  return out;
}

describe('R S4/RefClass definitions are named by their first argument only', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-anchors'), () => {});
  }, 60000);

  it('defines every setClass / setRefClass class exactly once (positive control)', () => {
    expect(getNodesByLabel(result, 'Class').filter((n) => n !== 'VIRTUAL')).toEqual([
      'Abstract',
      'Base',
      'Derived',
      'Named',
      'Ref',
    ]);
  });

  it('mints no file-scoped Class from contains = "VIRTUAL"', () => {
    const virtual = nodesByLabel(result, 'Class').filter((n) => n.name === 'VIRTUAL');
    expect(virtual.map((n) => n.id)).toEqual(['Class:VIRTUAL']);
  });

  it('still emits EXTENDS Abstract -> VIRTUAL to the single placeholder node', () => {
    const edge = getRelationships(result, 'EXTENDS').find(
      (e) => e.source === 'Abstract' && e.target === 'VIRTUAL',
    );
    expect(edge?.rel.targetId).toBe('Class:VIRTUAL');
  });

  it('does not duplicate a base class named only by contains = "Base"', () => {
    expect(nodesByLabel(result, 'Class').filter((n) => n.name === 'Base')).toHaveLength(1);
  });

  it('keeps the EXTENDS edges to the base class defined in the other file', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.some((e) => e.source === 'Ref' && e.target === 'Base')).toBe(true);
    expect(extends_.some((e) => e.source === 'Derived' && e.target === 'Base')).toBe(true);
  });

  it('defines the generics once, with no Function from valueClass = "numeric"', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions.filter((n) => n === 'describe')).toHaveLength(1);
    expect(functions.filter((n) => n === 'summarise')).toHaveLength(1);
    expect(functions).not.toContain('numeric');
  });

  it('defines the setMethod method once, owned by the class named in the signature', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter((n) => n === 'show')).toHaveLength(1);
    expect(methods.filter((n) => n === 'describe')).toHaveLength(1);
    expect(methods).not.toContain('Derived');
    const hasMethod = getRelationships(result, 'HAS_METHOD').filter((e) => e.source === 'Derived');
    // `signature("Derived")` (a call, not a string) names no owner today; that is
    // unchanged by the anchor, so only the string-signature `show` is owned.
    expect(hasMethod.map((e) => e.target)).toEqual(['show']);
  });

  it('keeps slot, field and representation properties', () => {
    expect(getNodesByLabel(result, 'Property')).toEqual(['count', 'label', 'size', 'tag']);
  });
});
