import type { KnowledgeGraph } from '../graph/types.ts';
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
    
    return graph;
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