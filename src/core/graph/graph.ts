/**
 * Graph interfaces and types
 */

import { GraphNode, GraphRelationship, NodeProperties, RelationshipProperties } from './types.js';

export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  addNode(node: GraphNode): void;
  addRelationship(relationship: GraphRelationship): void;
}

export interface GraphProcessor<T> {
  process(graph: KnowledgeGraph, input: T): Promise<void>;
}

// Simple implementation of KnowledgeGraph
export class SimpleKnowledgeGraph implements KnowledgeGraph {
  nodes: GraphNode[] = [];
  relationships: GraphRelationship[] = [];

  addNode(node: GraphNode): void {
    this.nodes.push(node);
  }

  addRelationship(relationship: GraphRelationship): void {
    this.relationships.push(relationship);
  }
}