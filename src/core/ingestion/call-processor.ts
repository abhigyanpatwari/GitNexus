import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { generateId } from '../../lib/utils.ts';

// @ts-expect-error - npm: imports are resolved at runtime in Deno
import type Parser from 'npm:web-tree-sitter';

export interface CallResolutionInput {
  graph: KnowledgeGraph;
  astCache: Map<string, any>;
  fileContents: Map<string, string>;
}

interface FunctionCall {
  callerFilePath: string;
  callerFunction: string;
  calledName: string;
  callType: 'function' | 'method' | 'attribute';
  line: number;
  column: number;
  isChained?: boolean;
  objectName?: string;
}

interface ImportInfo {
  filePath: string;
  importedName: string;
  alias?: string;
  fromModule: string;
  importType: 'function' | 'class' | 'module' | 'attribute';
}

const BUILTIN_FUNCTIONS = new Set([
  'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set',
  'range', 'enumerate', 'zip', 'map', 'filter', 'sum', 'max', 'min', 'abs',
  'round', 'sorted', 'reversed', 'any', 'all', 'type', 'isinstance', 'hasattr',
  'getattr', 'setattr', 'delattr', 'dir', 'vars', 'id', 'hash', 'repr',
  'open', 'input', 'format', 'exec', 'eval', 'compile', 'globals', 'locals'
]);

export class CallProcessor {
  private importCache: Map<string, ImportInfo[]> = new Map();
  private functionNodes: Map<string, GraphNode> = new Map();

  public async process(input: CallResolutionInput): Promise<void> {
    const { graph, astCache, fileContents } = input;
    
    // Build function node lookup for fast resolution
    this.buildFunctionNodeLookup(graph);
    
    // Extract imports from all files first
    for (const [filePath, ast] of astCache) {
      if (this.isPythonFile(filePath)) {
        const content = fileContents.get(filePath);
        if (content && ast) {
          await this.extractImports(filePath, ast, content);
        }
      }
    }
    
    // Process function calls in all files
    for (const [filePath, ast] of astCache) {
      if (this.isPythonFile(filePath)) {
        const content = fileContents.get(filePath);
        if (content && ast) {
          await this.processFunctionCalls(graph, filePath, ast, content);
        }
      }
    }
  }

  private buildFunctionNodeLookup(graph: KnowledgeGraph): void {
    for (const node of graph.nodes) {
      if (node.label === 'Function' || node.label === 'Method') {
        const filePath = node.properties.filePath as string;
        const functionName = node.properties.name as string;
        const key = `${filePath}:${functionName}`;
        this.functionNodes.set(key, node);
      }
    }
  }

  private async extractImports(filePath: string, ast: any, content: string): Promise<void> {
    const imports: ImportInfo[] = [];
    
    this.traverseNode(ast.rootNode, (node: any) => {
      if (node.type === 'import_statement') {
        this.processImportStatement(node, imports, filePath);
      } else if (node.type === 'import_from_statement') {
        this.processImportFromStatement(node, imports, filePath);
      }
    });
    
    this.importCache.set(filePath, imports);
  }

  private processImportStatement(node: any, imports: ImportInfo[], filePath: string): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const moduleName = nameNode.text;
      
      // Handle aliased imports (import module as alias)
      const asNode = node.children.find((child: any) => child.type === 'as_pattern');
      const alias = asNode ? asNode.childForFieldName('alias')?.text : undefined;
      
      imports.push({
        filePath,
        importedName: moduleName,
        alias,
        fromModule: moduleName,
        importType: 'module'
      });
    }
  }

  private processImportFromStatement(node: any, imports: ImportInfo[], filePath: string): void {
    const moduleNameNode = node.childForFieldName('module_name');
    const importListNode = node.children.find((child: any) => child.type === 'import_list');
    
    if (moduleNameNode && importListNode) {
      const moduleName = moduleNameNode.text;
      
      this.traverseNode(importListNode, (child: any) => {
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          const importedName = child.text;
          imports.push({
            filePath,
            importedName,
            fromModule: moduleName,
            importType: 'function' // Default assumption, could be refined
          });
        } else if (child.type === 'as_pattern') {
          const nameNode = child.childForFieldName('name');
          const aliasNode = child.childForFieldName('alias');
          
          if (nameNode && aliasNode) {
            imports.push({
              filePath,
              importedName: nameNode.text,
              alias: aliasNode.text,
              fromModule: moduleName,
              importType: 'function'
            });
          }
        }
      });
    }
  }

  private async processFunctionCalls(
    graph: KnowledgeGraph, 
    filePath: string, 
    ast: any, 
    content: string
  ): Promise<void> {
    const functionCalls: FunctionCall[] = [];
    let currentFunction: string | null = null;
    
    this.traverseNode(ast.rootNode, (node: any) => {
      // Track current function context
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          currentFunction = nameNode.text;
        }
      }
      
      // Find function calls
      if (node.type === 'call') {
        const callInfo = this.extractCallInfo(node, filePath, currentFunction, content);
        if (callInfo) {
          functionCalls.push(callInfo);
        }
      }
    });
    
    // Resolve calls and create relationships
    for (const call of functionCalls) {
      await this.resolveAndCreateCallRelationship(graph, call);
    }
  }

  private extractCallInfo(
    callNode: any, 
    filePath: string, 
    currentFunction: string | null,
    content: string
  ): FunctionCall | null {
    const functionNode = callNode.childForFieldName('function');
    if (!functionNode) return null;
    
    const position = callNode.startPosition;
    const line = position.row + 1;
    const column = position.column + 1;
    
    if (functionNode.type === 'identifier') {
      // Simple function call: func()
      return {
        callerFilePath: filePath,
        callerFunction: currentFunction || '<module>',
        calledName: functionNode.text,
        callType: 'function',
        line,
        column
      };
    } else if (functionNode.type === 'attribute') {
      // Method call: obj.method()
      const objectNode = functionNode.childForFieldName('object');
      const attributeNode = functionNode.childForFieldName('attribute');
      
      if (objectNode && attributeNode) {
        return {
          callerFilePath: filePath,
          callerFunction: currentFunction || '<module>',
          calledName: attributeNode.text,
          callType: 'method',
          line,
          column,
          objectName: objectNode.text
        };
      }
    }
    
    return null;
  }

  private async resolveAndCreateCallRelationship(
    graph: KnowledgeGraph, 
    call: FunctionCall
  ): Promise<void> {
    const callerNode = this.findCallerNode(graph, call);
    if (!callerNode) return;
    
    // Try different resolution strategies
    const targetNode = 
      this.resolveBuiltinFunction(call) ||
      this.resolveImportedFunction(call) ||
      this.resolveLocalFunction(call) ||
      this.resolveMethodCall(graph, call);
    
    if (targetNode) {
      const relationship = this.createCallRelationship(callerNode.id, targetNode.id, call);
      graph.relationships.push(relationship);
    }
  }

  private findCallerNode(graph: KnowledgeGraph, call: FunctionCall): GraphNode | null {
    if (call.callerFunction === '<module>') {
      // Call is at module level
      return graph.nodes.find(node => 
        node.label === 'Module' && 
        node.properties.path === call.callerFilePath
      ) || null;
    } else {
      // Call is within a function
      const key = `${call.callerFilePath}:${call.callerFunction}`;
      return this.functionNodes.get(key) || null;
    }
  }

  private resolveBuiltinFunction(call: FunctionCall): GraphNode | null {
    if (BUILTIN_FUNCTIONS.has(call.calledName)) {
      return this.getOrCreateBuiltinNode(call.calledName);
    }
    return null;
  }

  private resolveImportedFunction(call: FunctionCall): GraphNode | null {
    const imports = this.importCache.get(call.callerFilePath) || [];
    
    for (const importInfo of imports) {
      // Check direct import match
      if (importInfo.importedName === call.calledName || importInfo.alias === call.calledName) {
        // For now, create a placeholder node for imported functions
        // In a full implementation, this would resolve to actual function nodes
        return this.getOrCreateImportedNode(call.calledName, importInfo.fromModule);
      }
      
      // Check module.function pattern
      if (call.callType === 'method' && call.objectName === importInfo.importedName) {
        return this.getOrCreateImportedNode(call.calledName, importInfo.fromModule);
      }
    }
    
    return null;
  }

  private resolveLocalFunction(call: FunctionCall): GraphNode | null {
    const key = `${call.callerFilePath}:${call.calledName}`;
    return this.functionNodes.get(key) || null;
  }

  private resolveMethodCall(graph: KnowledgeGraph, call: FunctionCall): GraphNode | null {
    if (call.callType !== 'method') return null;
    
    // Look for method in the same file
    const methods = graph.nodes.filter(node => 
      node.label === 'Method' && 
      node.properties.filePath === call.callerFilePath &&
      node.properties.name === call.calledName
    );
    
    // Return first matching method (could be refined with class context)
    return methods[0] || null;
  }

  private getOrCreateBuiltinNode(functionName: string): GraphNode {
    const id = generateId('builtin', functionName);
    return {
      id,
      label: 'Function',
      properties: {
        name: functionName,
        type: 'builtin',
        language: 'python'
      }
    };
  }

  private getOrCreateImportedNode(functionName: string, moduleName: string): GraphNode {
    const id = generateId('imported', `${moduleName}.${functionName}`);
    return {
      id,
      label: 'Function',
      properties: {
        name: functionName,
        module: moduleName,
        type: 'imported',
        language: 'python'
      }
    };
  }

  private createCallRelationship(
    callerId: string, 
    targetId: string, 
    call: FunctionCall
  ): GraphRelationship {
    return {
      id: generateId('relationship', `${callerId}-calls-${targetId}`),
      type: 'CALLS',
      source: callerId,
      target: targetId,
      properties: {
        callType: call.callType,
        line: call.line,
        column: call.column,
        ...(call.objectName && { objectName: call.objectName })
      }
    };
  }

  private traverseNode(node: any, callback: (node: any) => void): void {
    callback(node);
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.traverseNode(child, callback);
      }
    }
  }

  private isPythonFile(filePath: string): boolean {
    return filePath.endsWith('.py');
  }

  public getImportInfo(filePath: string): ImportInfo[] {
    return this.importCache.get(filePath) || [];
  }

  public getCallStats(): { totalCalls: number; callTypes: Record<string, number> } {
    const stats = {
      totalCalls: 0,
      callTypes: {
        function: 0,
        method: 0,
        builtin: 0,
        imported: 0,
        local: 0
      }
    };
    
    // This would be populated during processing
    return stats;
  }
} 