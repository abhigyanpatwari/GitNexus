import { describe, it, expect } from 'vitest';
import { NODE_TABLES, RELATION_SCHEMA, FUNCTION_SCHEMA, METHOD_SCHEMA } from '../../src/core/lbug/schema.js';
import type { NodeProperties, GraphRelationship } from '../../src/core/graph/types.js';

describe('guard clause schema', () => {
  it('NodeProperties accepts guardClauses field', () => {
    const props: NodeProperties = {
      name: 'handlePOST',
      filePath: 'route.ts',
      guardClauses: [{ condition: '!session', returnStatus: 401, line: 5 }],
    };
    expect(props.guardClauses).toHaveLength(1);
  });

  it('GraphRelationship accepts guard field', () => {
    const rel: GraphRelationship = {
      id: 'test',
      sourceId: 'a',
      targetId: 'b',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'guarded-call',
      guard: "grant.status === 'submitted'",
    };
    expect(rel.guard).toBe("grant.status === 'submitted'");
  });

  it('RELATION_SCHEMA includes guard column', () => {
    expect(RELATION_SCHEMA).toContain('guard STRING');
  });

  it('FUNCTION_SCHEMA includes guardClauses column', () => {
    expect(FUNCTION_SCHEMA).toContain('guardClauses STRING');
  });

  it('METHOD_SCHEMA includes guardClauses column', () => {
    expect(METHOD_SCHEMA).toContain('guardClauses STRING');
  });
});
