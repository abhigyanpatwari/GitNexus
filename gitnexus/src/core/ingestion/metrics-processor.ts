/**
 * Code Complexity Metrics Processor
 * 
 * Calculates code complexity metrics for Function/Method nodes:
 * - Cyclomatic Complexity: Decision point count
 * - Fan-In: Incoming CALLS edges
 * - Fan-Out: Outgoing CALLS edges
 * - LOC: Lines of code
 * - Instability: fanOut / (fanIn + fanOut)
 * - Complexity Rank: low/medium/high/critical
 */

import { KnowledgeGraph, GraphNode } from '../graph/types';
import { ASTCache } from './ast-cache';
import { FileEntry } from '../../services/zip';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader';
import { getLanguageFromFilename } from './utils';
import Parser from 'web-tree-sitter';

// ============================================================================
// TYPES
// ============================================================================

export type ComplexityRank = 'low' | 'medium' | 'high' | 'critical';

export interface MetricsResult {
  stats: {
    totalNodesProcessed: number;
    avgComplexity: number;
    maxComplexity: number;
    criticalCount: number;
    highCount: number;
  };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const COMPLEXITY_THRESHOLDS = {
  low: 5,      // 1-5
  medium: 10,  // 6-10
  high: 20,    // 11-20
  critical: Infinity, // 21+
};

/**
 * Decision nodes that increase cyclomatic complexity by language
 * Each node type adds 1 to the complexity count
 */
const DECISION_NODES: Record<string, string[]> = {
  typescript: [
    'if_statement',
    'else_clause',
    'switch_case',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
    'conditional_expression',
  ],
  javascript: [
    'if_statement',
    'else_clause',
    'switch_case',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
    'conditional_expression',
  ],
  python: [
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'list_comprehension',
    'dictionary_comprehension',
    'set_comprehension',
  ],
  java: [
    'if_statement',
    'else_clause',
    'switch_expression',
    'switch_block_statement_group',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
    'conditional_expression',
  ],
  go: [
    'if_statement',
    'for_statement',
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
    'communication_case',
  ],
  rust: [
    'if_expression',
    'else_clause',
    'match_expression',
    'match_arm',
    'for_expression',
    'while_expression',
    'loop_expression',
  ],
  c: [
    'if_statement',
    'else_clause',
    'switch_statement',
    'case_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'conditional_expression',
  ],
  cpp: [
    'if_statement',
    'else_clause',
    'switch_statement',
    'case_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
  ],
  csharp: [
    'if_statement',
    'else_clause',
    'switch_statement',
    'switch_section',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
  ],
};

/**
 * Binary operators that add to complexity (&&, ||)
 */
const LOGICAL_OPERATORS: Record<string, { nodeType: string; operators: string[] }> = {
  typescript: { nodeType: 'binary_expression', operators: ['&&', '||', '??'] },
  javascript: { nodeType: 'binary_expression', operators: ['&&', '||', '??'] },
  python: { nodeType: 'boolean_operator', operators: ['and', 'or'] },
  java: { nodeType: 'binary_expression', operators: ['&&', '||'] },
  go: { nodeType: 'binary_expression', operators: ['&&', '||'] },
  rust: { nodeType: 'binary_expression', operators: ['&&', '||'] },
  c: { nodeType: 'binary_expression', operators: ['&&', '||'] },
  cpp: { nodeType: 'binary_expression', operators: ['&&', '||'] },
  csharp: { nodeType: 'binary_expression', operators: ['&&', '||', '??'] },
};

// ============================================================================
// CYCLOMATIC COMPLEXITY CALCULATION
// ============================================================================

/**
 * Calculate cyclomatic complexity for a given AST subtree
 */
const calculateCyclomaticComplexity = (
  node: Parser.SyntaxNode,
  language: string
): number => {
  let complexity = 1; // Base complexity (one path through the code)
  
  const decisionNodes = DECISION_NODES[language] || DECISION_NODES.typescript;
  const logicalOps = LOGICAL_OPERATORS[language] || LOGICAL_OPERATORS.typescript;
  
  const visit = (current: Parser.SyntaxNode) => {
    // Check if this is a decision node
    if (decisionNodes.includes(current.type)) {
      complexity++;
    }
    
    // Check for logical operators (&&, ||)
    if (current.type === logicalOps.nodeType) {
      // Get the operator text
      const operatorNode = current.childForFieldName('operator') || 
                          current.children.find(c => logicalOps.operators.includes(c.text));
      if (operatorNode && logicalOps.operators.includes(operatorNode.text)) {
        complexity++;
      }
    }
    
    // Recursively visit children
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child) {
        visit(child);
      }
    }
  };
  
  visit(node);
  return complexity;
};

/**
 * Get complexity rank from cyclomatic complexity value
 */
const getComplexityRank = (complexity: number): ComplexityRank => {
  if (complexity <= COMPLEXITY_THRESHOLDS.low) return 'low';
  if (complexity <= COMPLEXITY_THRESHOLDS.medium) return 'medium';
  if (complexity <= COMPLEXITY_THRESHOLDS.high) return 'high';
  return 'critical';
};

// ============================================================================
// FAN-IN / FAN-OUT CALCULATION
// ============================================================================

/**
 * Calculate fan-in and fan-out for all nodes based on CALLS relationships
 */
const calculateCoupling = (graph: KnowledgeGraph): Map<string, { fanIn: number; fanOut: number }> => {
  const coupling = new Map<string, { fanIn: number; fanOut: number }>();
  
  // Initialize all callable nodes
  graph.nodes.forEach(node => {
    if (['Function', 'Method', 'Class'].includes(node.label)) {
      coupling.set(node.id, { fanIn: 0, fanOut: 0 });
    }
  });
  
  // Count CALLS relationships
  graph.relationships.forEach(rel => {
    if (rel.type === 'CALLS') {
      // Increment fan-out for source
      const sourceMetrics = coupling.get(rel.sourceId);
      if (sourceMetrics) {
        sourceMetrics.fanOut++;
      }
      
      // Increment fan-in for target
      const targetMetrics = coupling.get(rel.targetId);
      if (targetMetrics) {
        targetMetrics.fanIn++;
      }
    }
  });
  
  return coupling;
};

/**
 * Calculate instability metric: Ce / (Ca + Ce)
 * Where Ce = fan-out (efferent coupling), Ca = fan-in (afferent coupling)
 * 0 = maximally stable, 1 = maximally unstable
 */
const calculateInstability = (fanIn: number, fanOut: number): number => {
  const total = fanIn + fanOut;
  if (total === 0) return 0;
  return Math.round((fanOut / total) * 100) / 100;
};

// ============================================================================
// MAIN PROCESSOR
// ============================================================================

/**
 * Find the AST node for a given graph node (Function/Method)
 */
const findASTNodeForSymbol = (
  tree: Parser.Tree,
  nodeName: string,
  startLine: number,
  language: string
): Parser.SyntaxNode | null => {
  const functionTypes: Record<string, string[]> = {
    typescript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
    javascript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
    python: ['function_definition'],
    java: ['method_declaration', 'constructor_declaration'],
    go: ['function_declaration', 'method_declaration'],
    rust: ['function_item'],
    c: ['function_definition'],
    cpp: ['function_definition'],
    csharp: ['method_declaration', 'constructor_declaration'],
  };
  
  const targetTypes = functionTypes[language] || functionTypes.typescript;
  let result: Parser.SyntaxNode | null = null;
  
  const visit = (node: Parser.SyntaxNode) => {
    if (result) return; // Already found
    
    // Check if this node matches
    if (targetTypes.includes(node.type) && node.startPosition.row === startLine) {
      result = node;
      return;
    }
    
    // Visit children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  
  visit(tree.rootNode);
  return result;
};

/**
 * Process metrics for all Function/Method nodes in the graph
 */
export const processMetrics = async (
  graph: KnowledgeGraph,
  files: FileEntry[],
  astCache: ASTCache,
  onProgress?: (message: string, progress: number) => void
): Promise<MetricsResult> => {
  onProgress?.('Calculating code metrics...', 0);
  
  const parser = await loadParser();
  
  // Step 1: Calculate fan-in/fan-out from CALLS relationships
  onProgress?.('Calculating coupling metrics...', 10);
  const couplingMap = calculateCoupling(graph);
  
  // Step 2: Find all Function/Method nodes that need complexity calculation
  const callableNodes = graph.nodes.filter(n => 
    ['Function', 'Method'].includes(n.label)
  );
  
  // Group nodes by file for efficient AST reuse
  const nodesByFile = new Map<string, GraphNode[]>();
  callableNodes.forEach(node => {
    const filePath = node.properties.filePath;
    if (!nodesByFile.has(filePath)) {
      nodesByFile.set(filePath, []);
    }
    nodesByFile.get(filePath)!.push(node);
  });
  
  // Step 3: Calculate cyclomatic complexity for each node
  let processedCount = 0;
  const totalFiles = nodesByFile.size;
  let totalComplexity = 0;
  let maxComplexity = 0;
  let criticalCount = 0;
  let highCount = 0;
  
  for (const [filePath, nodes] of nodesByFile) {
    const language = getLanguageFromFilename(filePath);
    if (!language) continue;
    
    // Try to get AST from cache, or parse the file
    let tree = astCache.get(filePath);
    
    if (!tree) {
      // Find file content and parse
      const file = files.find(f => f.path === filePath);
      if (!file) continue;
      
      await loadLanguage(language, filePath);
      tree = parser.parse(file.content);
      astCache.set(filePath, tree);
    }
    
    // Process each node in this file
    for (const node of nodes) {
      const startLine = node.properties.startLine ?? 0;
      const endLine = node.properties.endLine ?? startLine;
      
      // Calculate LOC
      const loc = endLine - startLine + 1;
      
      // Find the AST node
      const astNode = findASTNodeForSymbol(tree, node.properties.name, startLine, language);
      
      // Calculate cyclomatic complexity
      let complexity = 1;
      if (astNode) {
        complexity = calculateCyclomaticComplexity(astNode, language);
      }
      
      // Get coupling metrics
      const coupling = couplingMap.get(node.id) || { fanIn: 0, fanOut: 0 };
      const instability = calculateInstability(coupling.fanIn, coupling.fanOut);
      
      // Determine complexity rank
      const rank = getComplexityRank(complexity);
      
      // Update node properties
      node.properties.cyclomaticComplexity = complexity;
      node.properties.fanIn = coupling.fanIn;
      node.properties.fanOut = coupling.fanOut;
      node.properties.loc = loc;
      node.properties.instability = instability;
      node.properties.complexityRank = rank;
      
      // Track stats
      totalComplexity += complexity;
      if (complexity > maxComplexity) maxComplexity = complexity;
      if (rank === 'critical') criticalCount++;
      if (rank === 'high') highCount++;
    }
    
    processedCount++;
    const progress = 10 + (processedCount / totalFiles) * 90;
    onProgress?.(`Processing metrics: ${processedCount}/${totalFiles} files`, progress);
  }
  
  onProgress?.('Metrics calculation complete!', 100);
  
  const avgComplexity = callableNodes.length > 0 
    ? Math.round((totalComplexity / callableNodes.length) * 10) / 10 
    : 0;
  
  return {
    stats: {
      totalNodesProcessed: callableNodes.length,
      avgComplexity,
      maxComplexity,
      criticalCount,
      highCount,
    },
  };
};
