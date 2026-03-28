/**
 * Shared test data factories for graph structures.
 * No test code — pure data exports.
 */

import type { GraphNode, GraphRelationship } from '../../src/core/graph/types';

export function createFileNode(name: string, filePath?: string): GraphNode {
  return {
    id: `File:${filePath ?? name}`,
    label: 'File',
    properties: { name, filePath: filePath ?? name },
  };
}

export function createFunctionNode(name: string, filePath: string, line = 1): GraphNode {
  return {
    id: `Function:${filePath}:${name}:${line}`,
    label: 'Function',
    properties: { name, filePath, startLine: line, endLine: line + 10 },
  };
}

export function createClassNode(name: string, filePath: string): GraphNode {
  return {
    id: `Class:${filePath}:${name}`,
    label: 'Class',
    properties: { name, filePath },
  };
}

export function createProcessNode(
  id: string,
  label: string,
  type: 'cross_community' | 'intra_community' = 'cross_community',
): GraphNode {
  return {
    id,
    label: 'Process',
    properties: {
      name: label,
      heuristicLabel: label,
      processType: type,
      stepCount: 3,
      communities: ['cluster-a', 'cluster-b'],
    } as any,
  };
}

export function createCallsRelationship(sourceId: string, targetId: string): GraphRelationship {
  return {
    id: `${sourceId}_CALLS_${targetId}`,
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: 0.9,
    reason: 'same-file',
  };
}

export function createContainsRelationship(sourceId: string, targetId: string): GraphRelationship {
  return {
    id: `${sourceId}_CONTAINS_${targetId}`,
    sourceId,
    targetId,
    type: 'CONTAINS',
    confidence: 1.0,
    reason: '',
  };
}
