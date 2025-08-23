import { SimpleKnowledgeGraph } from '../graph/graph.js';
import type { KnowledgeGraph } from '../graph/types.ts';
import { StructureProcessor } from './structure-processor.ts';
import { ParsingProcessor } from './parsing-processor.ts';
import { ImportProcessor } from './import-processor.ts';
import { CallProcessor } from './call-processor.ts';

export interface PipelineInput {
  projectRoot: string;
  projectName: string;
  filePaths: string[];
  fileContents: Map<string, string>;
  options?: {
    directoryFilter?: string;
    fileExtensions?: string;
  };
}

export class GraphPipeline {
  private structureProcessor: StructureProcessor;
  private parsingProcessor: ParsingProcessor;
  private importProcessor: ImportProcessor;
  private callProcessor!: CallProcessor;

  constructor() {
    this.structureProcessor = new StructureProcessor();
    this.parsingProcessor = new ParsingProcessor();
    this.importProcessor = new ImportProcessor();
    
  }

  public async run(input: PipelineInput): Promise<KnowledgeGraph> {
    const { projectRoot, projectName, filePaths, fileContents, options } = input;
    
    const graph = new SimpleKnowledgeGraph();

    console.log(`🚀 Starting 4-pass ingestion for project: ${projectName}`);
    
    // Pass 1: Structure Analysis
    console.log('📁 Pass 1: Analyzing project structure...');
    await this.structureProcessor.process(graph, {
      projectRoot,
      projectName,
      filePaths
    });
    
    // Pass 2: Code Parsing and Definition Extraction (populates FunctionRegistryTrie)
    console.log('🔍 Pass 2: Parsing code and extracting definitions...');
    await this.parsingProcessor.process(graph, {
      filePaths,
      fileContents,
      options  // Pass filtering options to ParsingProcessor
    });
    
    // Get AST map and function registry from parsing processor
    const astMap = this.parsingProcessor.getASTMap();
    const functionTrie = this.parsingProcessor.getFunctionRegistry();
    
    this.callProcessor = new CallProcessor(functionTrie);
    
    // Pass 3: Import Resolution (builds complete import map)
    console.log('🔗 Pass 3: Resolving imports and building dependency map...');
    await this.importProcessor.process(graph, astMap, fileContents);
    
    // Pass 4: Call Resolution (uses import map and function trie)
    console.log('📞 Pass 4: Resolving function calls with 3-stage strategy...');
    const importMap = this.importProcessor.getImportMap();
    await this.callProcessor.process(graph, astMap, importMap);
    
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
    
    console.log('📊 Graph Statistics:');
    console.log('Nodes by type:', nodesByType);
    console.log('Relationships by type:', relationshipsByType);
    
    // Debug: Find isolated nodes (nodes with no relationships)
    const connectedNodeIds = new Set<string>();
    graph.relationships.forEach(rel => {
      connectedNodeIds.add(rel.source);
      connectedNodeIds.add(rel.target);
    });
    
    const isolatedNodes = graph.nodes.filter(node => !connectedNodeIds.has(node.id));
    if (isolatedNodes.length > 0) {
      console.warn(`⚠️ Found ${isolatedNodes.length} isolated nodes:`);
      const isolatedByType = isolatedNodes.reduce((acc, node) => {
        acc[node.label] = (acc[node.label] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.warn('Isolated nodes by type:', isolatedByType);
      
      // Show some examples
      console.warn('Sample isolated nodes:', isolatedNodes.slice(0, 5).map(n => ({
        type: n.label,
        name: n.properties.name || n.properties.filePath || n.id,
        properties: Object.keys(n.properties)
      })));
    }
    
    // Debug: Check for files without content
    const fileNodes = graph.nodes.filter(n => n.label === 'File');
    const filesWithoutDefinitions = fileNodes.filter(fileNode => {
      const hasDefinitions = graph.relationships.some(rel => 
        rel.source === fileNode.id && 
        rel.type === 'DEFINES' && 
        graph.nodes.some(targetNode => 
          targetNode.id === rel.target && 
          ['Function', 'Class', 'Method', 'Variable'].includes(targetNode.label)
        )
      );
      return !hasDefinitions;
    });
    
    if (filesWithoutDefinitions.length > 0) {
      console.warn(`⚠️ Found ${filesWithoutDefinitions.length} files without definitions:`);
      console.warn('Files without content:', filesWithoutDefinitions.slice(0, 5).map(n => 
        n.properties.filePath || n.properties.name
      ));
    }
    
    // Validate graph integrity
    this.validateGraphIntegrity(graph);
    
    return graph;
  }

  /**
   * Get detailed diagnostic information about parsing results
   */
  public getParsingDiagnostics() {
    return this.parsingProcessor.getDiagnosticInfo();
  }

  /**
   * Analyze a specific file to understand why it might not have definitions
   */
  public async analyzeSpecificFile(filePath: string, content: string) {
    return await this.parsingProcessor.analyzeFile(filePath, content);
  }

  /**
   * Validate graph integrity and identify potential issues
   */
  private validateGraphIntegrity(graph: KnowledgeGraph): void {
    console.log('🔍 Validating graph integrity...');
    
    const issues: string[] = [];
    
    // Check 1: Orphaned relationships (references to non-existent nodes)
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    const orphanedRels = graph.relationships.filter(rel => 
      !nodeIds.has(rel.source) || !nodeIds.has(rel.target)
    );
    
    if (orphanedRels.length > 0) {
      issues.push(`${orphanedRels.length} relationships reference non-existent nodes`);
    }
    
    // Check 2: Files without proper structure connections
    const projectNodes = graph.nodes.filter(n => n.label === 'Project');
    const folderNodes = graph.nodes.filter(n => n.label === 'Folder');
    const fileNodes = graph.nodes.filter(n => n.label === 'File');
    
    const filesNotConnectedToStructure = fileNodes.filter(fileNode => {
      const hasStructuralParent = graph.relationships.some(rel =>
        rel.target === fileNode.id && 
        rel.type === 'CONTAINS' &&
        (projectNodes.some(p => p.id === rel.source) || folderNodes.some(f => f.id === rel.source))
      );
      return !hasStructuralParent;
    });
    
    if (filesNotConnectedToStructure.length > 0) {
      issues.push(`${filesNotConnectedToStructure.length} files not connected to project structure`);
    }
    
    // Check 3: Source files without any definitions
    const sourceFileExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs'];
    const sourceFiles = fileNodes.filter(fileNode => {
      const filePath = fileNode.properties.filePath as string || '';
      return sourceFileExtensions.some(ext => filePath.endsWith(ext));
    });
    
    const sourceFilesWithoutDefinitions = sourceFiles.filter(fileNode => {
      const hasDefinitions = graph.relationships.some(rel =>
        rel.source === fileNode.id && 
        rel.type === 'DEFINES' &&
        graph.nodes.some(n => 
          n.id === rel.target && 
          ['Function', 'Class', 'Method', 'Variable'].includes(n.label)
        )
      );
      return !hasDefinitions;
    });
    
    if (sourceFilesWithoutDefinitions.length > 0) {
      issues.push(`${sourceFilesWithoutDefinitions.length} source files contain no parsed definitions`);
      console.warn('Source files without definitions:', 
        sourceFilesWithoutDefinitions.slice(0, 3).map(n => n.properties.filePath)
      );
    }
    
    // Check 4: Functions/Classes without file parents
    const definitionNodes = graph.nodes.filter(n => 
      ['Function', 'Class', 'Method', 'Variable'].includes(n.label)
    );
    
    const definitionsWithoutFiles = definitionNodes.filter(defNode => {
      const hasFileParent = graph.relationships.some(rel =>
        rel.target === defNode.id &&
        rel.type === 'DEFINES' &&
        graph.nodes.some(n => n.id === rel.source && n.label === 'File')
      );
      return !hasFileParent;
    });
    
    if (definitionsWithoutFiles.length > 0) {
      issues.push(`${definitionsWithoutFiles.length} definitions not connected to files`);
    }
    
    // Check 5: Import/Call relationship issues
    const importRels = graph.relationships.filter(r => r.type === 'IMPORTS');
    const callRels = graph.relationships.filter(r => r.type === 'CALLS');
    
    if (sourceFiles.length > 1 && importRels.length === 0) {
      issues.push('No import relationships found between files');
    }
    
    if (definitionNodes.length > 1 && callRels.length === 0) {
      issues.push('No function call relationships found');
    }
    
    // Report results
    if (issues.length === 0) {
      console.log('✅ Graph integrity validation passed');
    } else {
      console.warn('⚠️ Graph integrity issues found:');
      issues.forEach((issue, i) => console.warn(`  ${i + 1}. ${issue}`));
    }
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

  public getCallStats() {
    return this.callProcessor.getStats();
  }
} 
