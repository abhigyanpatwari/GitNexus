/**
 * Type validation utilities for ensuring data integrity
 */

import { z } from 'zod';
import type { GraphNode, GraphRelationship, NodeProperties, RelationshipProperties } from '../core/graph/types';

// Validation schemas for nodes and relationships
const NodePropertiesSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  filePath: z.string().optional(),
  extension: z.string().optional(),
  language: z.string().optional(),
  size: z.number().nonnegative().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  definitionCount: z.number().nonnegative().optional(),
  lineCount: z.number().nonnegative().optional(),
  type: z.string().optional(),
  startLine: z.number().positive().optional(),
  endLine: z.number().positive().optional(),
  qualifiedName: z.string().optional(),
  parameters: z.array(z.string()).optional(),
  returnType: z.string().optional(),
  relationshipType: z.string().optional()
}).catchall(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.undefined()]));

const RelationshipPropertiesSchema = z.object({
  strength: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  importType: z.enum(['default', 'named', 'namespace']).optional(),
  alias: z.string().optional(),
  callType: z.enum(['function', 'method', 'constructor']).optional(),
  arguments: z.array(z.string()).optional(),
  dependencyType: z.enum(['direct', 'transitive', 'dev']).optional(),
  version: z.string().optional()
}).catchall(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.undefined()]));

const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.enum([
    'Project', 'Package', 'Module', 'Folder', 'File', 'Class', 'Function', 
    'Method', 'Variable', 'Interface', 'Enum', 'Decorator'
  ]),
  properties: NodePropertiesSchema
});

const GraphRelationshipSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'CONTAINS', 'CALLS', 'INHERITS', 'OVERRIDES', 'IMPORTS', 'USES', 
    'DEFINES', 'DECORATES', 'IMPLEMENTS', 'ACCESSES'
  ]),
  source: z.string().min(1),
  target: z.string().min(1),
  properties: RelationshipPropertiesSchema
});

/**
 * Validation utilities for graph data
 */
export class ValidationService {
  /**
   * Validate a node object
   */
  static validateNode(node: unknown): GraphNode {
    try {
      return GraphNodeSchema.parse(node);
    } catch (error) {
      throw new Error(`Invalid node: ${error}`);
    }
  }

  /**
   * Validate a relationship object
   */
  static validateRelationship(relationship: unknown): GraphRelationship {
    try {
      return GraphRelationshipSchema.parse(relationship);
    } catch (error) {
      throw new Error(`Invalid relationship: ${error}`);
    }
  }

  /**
   * Validate node properties
   */
  static validateNodeProperties(properties: unknown): NodeProperties {
    try {
      return NodePropertiesSchema.parse(properties);
    } catch (error) {
      throw new Error(`Invalid node properties: ${error}`);
    }
  }

  /**
   * Validate relationship properties
   */
  static validateRelationshipProperties(properties: unknown): RelationshipProperties {
    try {
      return RelationshipPropertiesSchema.parse(properties);
    } catch (error) {
      throw new Error(`Invalid relationship properties: ${error}`);
    }
  }

  /**
   * Validate a complete graph
   */
  static validateGraph(graph: { nodes: unknown[]; relationships: unknown[] }): void {
    const errors: string[] = [];

    // Validate nodes
    const nodeIds = new Set<string>();
    graph.nodes.forEach((node, index) => {
      try {
        const validated = this.validateNode(node);
        if (nodeIds.has(validated.id)) {
          errors.push(`Duplicate node ID: ${validated.id} at index ${index}`);
        }
        nodeIds.add(validated.id);
      } catch (error) {
        errors.push(`Node at index ${index}: ${error}`);
      }
    });

    // Validate relationships
    const relationshipIds = new Set<string>();
    graph.relationships.forEach((relationship, index) => {
      try {
        const validated = this.validateRelationship(relationship);
        if (relationshipIds.has(validated.id)) {
          errors.push(`Duplicate relationship ID: ${validated.id} at index ${index}`);
        }
        relationshipIds.add(validated.id);

        // Check if referenced nodes exist
        if (!nodeIds.has(validated.source)) {
          errors.push(`Relationship at index ${index} references non-existent source: ${validated.source}`);
        }
        if (!nodeIds.has(validated.target)) {
          errors.push(`Relationship at index ${index} references non-existent target: ${validated.target}`);
        }
      } catch (error) {
        errors.push(`Relationship at index ${index}: ${error}`);
      }
    });

    if (errors.length > 0) {
      throw new Error(`Graph validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Sanitize string inputs
   */
  static sanitizeString(input: string): string {
    return input
      .trim()
      .replace(/[<>]/g, '') // Remove potential XSS vectors
      .substring(0, 1000); // Limit length
  }

  /**
   * Validate file path
   */
  static validateFilePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw new Error('Invalid file path');
    }
    
    const sanitized = path.trim();
    if (sanitized.length === 0 || sanitized.length > 500) {
      throw new Error('File path too long or empty');
    }
    
    // Check for directory traversal
    if (sanitized.includes('..') || sanitized.includes('~')) {
      throw new Error('Invalid file path: contains directory traversal');
    }
    
    return sanitized;
  }

  /**
   * Validate language identifier
   */
  static validateLanguage(language: string): string {
    const validLanguages = [
      'javascript', 'typescript', 'python', 'java', 'cpp', 'c', 'csharp',
      'php', 'ruby', 'go', 'rust', 'swift', 'kotlin', 'scala', 'dart'
    ];
    
    const normalized = language.toLowerCase();
    if (!validLanguages.includes(normalized)) {
      throw new Error(`Invalid language: ${language}`);
    }
    
    return normalized;
  }
}
