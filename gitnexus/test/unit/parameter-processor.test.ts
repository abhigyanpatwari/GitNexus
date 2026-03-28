import { describe, it, expect } from 'vitest';
import {
  createParameterNodes,
  buildPassesToEdges,
  type ParameterNode,
  type PassesToEdge,
} from '../../src/core/ingestion/parameter-processor.js';
import type { ExtractedParameter } from '../../src/core/ingestion/workers/parse-worker.js';

describe('createParameterNodes', () => {
  it('creates Parameter nodes from extracted parameters', () => {
    const params: ExtractedParameter[] = [
      { filePath: 'route.ts', functionName: 'handlePOST', functionId: 'Function:route.ts:handlePOST', paramName: 'request', paramIndex: 0, declaredType: 'NextRequest', isRest: false },
      { filePath: 'route.ts', functionName: 'handlePOST', functionId: 'Function:route.ts:handlePOST', paramName: 'context', paramIndex: 1, isRest: false },
    ];

    const nodes = createParameterNodes(params);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('request');
    expect(nodes[0].paramIndex).toBe(0);
    expect(nodes[0].declaredType).toBe('NextRequest');
    expect(nodes[0].ownerId).toBe('Function:route.ts:handlePOST');
    expect(nodes[1].name).toBe('context');
    expect(nodes[1].paramIndex).toBe(1);
  });

  it('deduplicates by id', () => {
    const params: ExtractedParameter[] = [
      { filePath: 'a.ts', functionName: 'foo', functionId: 'Function:a.ts:foo', paramName: 'x', paramIndex: 0, isRest: false },
      { filePath: 'a.ts', functionName: 'foo', functionId: 'Function:a.ts:foo', paramName: 'x', paramIndex: 0, isRest: false },
    ];
    const nodes = createParameterNodes(params);
    expect(nodes).toHaveLength(1);
  });

  it('handles rest parameters', () => {
    const params: ExtractedParameter[] = [
      { filePath: 'a.ts', functionName: 'merge', functionId: 'Function:a.ts:merge', paramName: 'args', paramIndex: 0, isRest: true },
    ];
    const nodes = createParameterNodes(params);
    expect(nodes[0].isRest).toBe(true);
  });
});

describe('buildPassesToEdges', () => {
  it('maps call arguments to callee parameters by position', () => {
    const calls = [
      { sourceId: 'Function:handler.ts:handlePOST', targetId: 'Function:validate.ts:validate', argCount: 1 },
    ];

    const calleeParams = new Map<string, ExtractedParameter[]>([
      ['Function:validate.ts:validate', [
        { filePath: 'validate.ts', functionName: 'validate', functionId: 'Function:validate.ts:validate', paramName: 'input', paramIndex: 0, isRest: false },
      ]],
    ]);

    const edges = buildPassesToEdges(calls, calleeParams);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceParamIndex).toBe(0);
    expect(edges[0].targetParamId).toContain('input');
    expect(edges[0].callerId).toBe('Function:handler.ts:handlePOST');
  });

  it('skips parameters beyond argCount', () => {
    const calls = [
      { sourceId: 'f:caller', targetId: 'f:callee', argCount: 1 },
    ];

    const calleeParams = new Map<string, ExtractedParameter[]>([
      ['f:callee', [
        { filePath: 'a.ts', functionName: 'callee', functionId: 'f:callee', paramName: 'a', paramIndex: 0, isRest: false },
        { filePath: 'a.ts', functionName: 'callee', functionId: 'f:callee', paramName: 'b', paramIndex: 1, isRest: false },
      ]],
    ]);

    const edges = buildPassesToEdges(calls, calleeParams);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceParamIndex).toBe(0);
  });

  it('includes rest parameter even when beyond argCount', () => {
    const calls = [
      { sourceId: 'f:caller', targetId: 'f:callee', argCount: 1 },
    ];

    const calleeParams = new Map<string, ExtractedParameter[]>([
      ['f:callee', [
        { filePath: 'a.ts', functionName: 'callee', functionId: 'f:callee', paramName: 'first', paramIndex: 0, isRest: false },
        { filePath: 'a.ts', functionName: 'callee', functionId: 'f:callee', paramName: 'rest', paramIndex: 1, isRest: true },
      ]],
    ]);

    const edges = buildPassesToEdges(calls, calleeParams);
    // first (index 0) matches, rest (index 1) also matches because isRest
    expect(edges).toHaveLength(2);
  });

  it('returns empty when callee has no parameters', () => {
    const calls = [
      { sourceId: 'f:caller', targetId: 'f:callee', argCount: 0 },
    ];
    const calleeParams = new Map<string, ExtractedParameter[]>();
    const edges = buildPassesToEdges(calls, calleeParams);
    expect(edges).toHaveLength(0);
  });

  it('handles multiple calls to different callees', () => {
    const calls = [
      { sourceId: 'f:main', targetId: 'f:a', argCount: 2 },
      { sourceId: 'f:main', targetId: 'f:b', argCount: 1 },
    ];

    const calleeParams = new Map<string, ExtractedParameter[]>([
      ['f:a', [
        { filePath: 'a.ts', functionName: 'a', functionId: 'f:a', paramName: 'x', paramIndex: 0, isRest: false },
        { filePath: 'a.ts', functionName: 'a', functionId: 'f:a', paramName: 'y', paramIndex: 1, isRest: false },
      ]],
      ['f:b', [
        { filePath: 'b.ts', functionName: 'b', functionId: 'f:b', paramName: 'data', paramIndex: 0, isRest: false },
      ]],
    ]);

    const edges = buildPassesToEdges(calls, calleeParams);
    expect(edges).toHaveLength(3); // 2 for f:a + 1 for f:b
  });
});
