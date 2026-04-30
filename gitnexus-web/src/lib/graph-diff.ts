import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';

export interface GraphDiffSummary {
  addedNodes: number;
  removedNodes: number;
  changedNodes: number;
  addedRelationships: number;
  removedRelationships: number;
  changedRelationships: number;
}

export interface GraphDiff {
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  addedRelationshipIds: string[];
  removedRelationshipIds: string[];
  changedRelationshipIds: string[];
  hasChanges: boolean;
  summary: GraphDiffSummary;
}

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
};

const nodeFingerprint = (node: GraphNode): string =>
  stableSerialize({
    label: node.label,
    properties: node.properties,
  });

const relationshipFingerprint = (relationship: GraphRelationship): string =>
  stableSerialize({
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    type: relationship.type,
    confidence: relationship.confidence,
    reason: relationship.reason,
    step: relationship.step,
    evidence: relationship.evidence,
  });

const byId = <T extends { id: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

export const diffKnowledgeGraphs = (previous: KnowledgeGraph, next: KnowledgeGraph): GraphDiff => {
  const previousNodes = byId(previous.nodes);
  const nextNodes = byId(next.nodes);
  const previousRelationships = byId(previous.relationships);
  const nextRelationships = byId(next.relationships);

  const addedNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const changedNodeIds: string[] = [];
  const addedRelationshipIds: string[] = [];
  const removedRelationshipIds: string[] = [];
  const changedRelationshipIds: string[] = [];

  nextNodes.forEach((node, id) => {
    const before = previousNodes.get(id);
    if (!before) {
      addedNodeIds.push(id);
    } else if (nodeFingerprint(before) !== nodeFingerprint(node)) {
      changedNodeIds.push(id);
    }
  });

  previousNodes.forEach((_, id) => {
    if (!nextNodes.has(id)) removedNodeIds.push(id);
  });

  nextRelationships.forEach((relationship, id) => {
    const before = previousRelationships.get(id);
    if (!before) {
      addedRelationshipIds.push(id);
    } else if (relationshipFingerprint(before) !== relationshipFingerprint(relationship)) {
      changedRelationshipIds.push(id);
    }
  });

  previousRelationships.forEach((_, id) => {
    if (!nextRelationships.has(id)) removedRelationshipIds.push(id);
  });

  const summary: GraphDiffSummary = {
    addedNodes: addedNodeIds.length,
    removedNodes: removedNodeIds.length,
    changedNodes: changedNodeIds.length,
    addedRelationships: addedRelationshipIds.length,
    removedRelationships: removedRelationshipIds.length,
    changedRelationships: changedRelationshipIds.length,
  };
  const hasChanges = Object.values(summary).some((count) => count > 0);

  return {
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    addedRelationshipIds,
    removedRelationshipIds,
    changedRelationshipIds,
    hasChanges,
    summary,
  };
};

export const describeGraphDiff = (diff: GraphDiff): string => {
  const parts = [
    diff.summary.addedNodes ? `+${diff.summary.addedNodes} nodes` : '',
    diff.summary.removedNodes ? `-${diff.summary.removedNodes} nodes` : '',
    diff.summary.changedNodes ? `${diff.summary.changedNodes} changed nodes` : '',
    diff.summary.addedRelationships ? `+${diff.summary.addedRelationships} edges` : '',
    diff.summary.removedRelationships ? `-${diff.summary.removedRelationships} edges` : '',
    diff.summary.changedRelationships ? `${diff.summary.changedRelationships} changed edges` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : 'No graph changes';
};
