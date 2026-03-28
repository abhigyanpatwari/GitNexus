import { describe, it, expect } from 'vitest';
import { NODE_TABLES, REL_TYPES, RELATION_SCHEMA } from '../../src/core/lbug/schema.js';
import type { NodeLabel, RelationshipType } from '../../src/core/graph/types.js';

describe('parameter schema', () => {
  it('NODE_TABLES includes Parameter', () => {
    expect(NODE_TABLES).toContain('Parameter');
  });

  it('REL_TYPES includes PASSES_TO', () => {
    expect(REL_TYPES).toContain('PASSES_TO');
  });

  it('REL_TYPES includes DATA_FLOWS_TO', () => {
    expect(REL_TYPES).toContain('DATA_FLOWS_TO');
  });

  it('RELATION_SCHEMA has FROM Function TO Parameter', () => {
    expect(RELATION_SCHEMA).toContain('FROM Function TO Parameter');
  });

  it('RELATION_SCHEMA has FROM Parameter TO Parameter (cross-function flow)', () => {
    expect(RELATION_SCHEMA).toContain('FROM Parameter TO Parameter');
  });

  it('NodeLabel union accepts Parameter', () => {
    const label: NodeLabel = 'Parameter';
    expect(label).toBe('Parameter');
  });

  it('RelationshipType union accepts PASSES_TO', () => {
    const rel: RelationshipType = 'PASSES_TO';
    expect(rel).toBe('PASSES_TO');
  });

  it('RelationshipType union accepts DATA_FLOWS_TO', () => {
    const rel: RelationshipType = 'DATA_FLOWS_TO';
    expect(rel).toBe('DATA_FLOWS_TO');
  });
});
