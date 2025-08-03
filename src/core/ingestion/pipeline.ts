import type { KnowledgeGraph, GraphRelationship } from '../graph/types.ts';
import { StructureProcessor } from './structure-processor.ts';
import { ParsingProcessor } from './parsing-processor.ts';
import { CallProcessor } from './call-processor.ts';

export interface PipelineInput {
  projectRoot: string;
  projectName: string;
  filePaths: string[];
  fileContents: Map<string, string>;
}

export class GraphPipeline {
  private structureProcessor: StructureProcessor;
  private parsingProcessor: ParsingProcessor;
  private callProcessor: CallProcessor;

  constructor() {
    this.structureProcessor = new StructureProcessor();
    this.parsingProcessor = new ParsingProcessor();
    this.callProcessor = new CallProcessor();
  }

  public async run(input: PipelineInput): Promise<KnowledgeGraph> {
    const { projectRoot, projectName, filePaths, fileContents } = input;
    
    const graph: KnowledgeGraph = {
      nodes: [],
      relationships: []
    };

    console.log(`Starting 3-pass ingestion for project: ${projectName}`);
    
    // Pass 1: Structure Analysis
    console.log('Pass 1: Analyzing project structure...');
    await this.structureProcessor.process(graph, {
      projectRoot,
      projectName,
      filePaths
    });
    
    // Pass 2: Code Parsing and Definition Extraction
    console.log('Pass 2: Parsing code and extracting definitions...');
    await this.parsingProcessor.process(graph, {
      filePaths,
      fileContents
    });
    
    // Pass 3: Call Resolution
    console.log('Pass 3: Resolving function calls and references...');
    await this.callProcessor.process({
      graph,
      astCache: this.parsingProcessor.getCachedAsts(),
      fileContents
    });
    
    console.log(`Ingestion complete. Graph contains ${graph.nodes.length} nodes and ${graph.relationships.length} relationships.`);
    
    // Debug: Show graph structure
    const nodesByType = graph.nodes.reduce((acc, node) => {
      acc[node.label] = (acc[node.label] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const relationshipsByType = graph.relationships.reduce((acc, rel) => {
      acc[rel.type] = (acc[rel.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log('Node distribution:', nodesByType);
    console.log('Relationship distribution:', relationshipsByType);
    
    // Validate graph integrity
    this.validateGraph(graph);
    
    return graph;
  }

  private validateGraph(graph: KnowledgeGraph): void {
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const orphanedRelationships: GraphRelationship[] = [];
    
    for (const relationship of graph.relationships) {
      if (!nodeIds.has(relationship.source)) {
        console.warn(`Orphaned relationship: source node '${relationship.source}' not found for relationship '${relationship.id}'`);
        orphanedRelationships.push(relationship);
      }
      
      if (!nodeIds.has(relationship.target)) {
        console.warn(`Orphaned relationship: target node '${relationship.target}' not found for relationship '${relationship.id}'`);
        orphanedRelationships.push(relationship);
      }
    }
    
    // Remove orphaned relationships to prevent graph errors
    if (orphanedRelationships.length > 0) {
      console.warn(`Removing ${orphanedRelationships.length} orphaned relationships`);
      const orphanedIds = new Set(orphanedRelationships.map(rel => rel.id));
      graph.relationships = graph.relationships.filter(rel => !orphanedIds.has(rel.id));
    }
    
    console.log(`Graph validation complete. Final graph: ${graph.nodes.length} nodes, ${graph.relationships.length} relationships`);
  }

  public getStats(graph: KnowledgeGraph): { nodeStats: Record<string, number>; relationshipStats: Record<string, number> } {
    const nodeStats: Record<string, number> = {};
    const relationshipStats: Record<string, number> = {};
    
    for (const node of graph.nodes) {
      nodeStats[node.label] = (nodeStats[node.label] || 0) + 1;
    }
    
    for (const relationship of graph.relationships) {
      relationshipStats[relationship.type] = (relationshipStats[relationship.type] || 0) + 1;
    }
    
    return { nodeStats, relationshipStats };
  }

  public getCallStats(): { totalCalls: number; callTypes: Record<string, number> } {
    return this.callProcessor.getCallStats();
  }
} 
