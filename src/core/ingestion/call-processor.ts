import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { generateId } from '../../lib/utils.ts';

import type Parser from 'web-tree-sitter';

export interface CallResolutionInput {
  graph: KnowledgeGraph;
  astCache: Map<string, any>;
  fileContents: Map<string, string>;
}

interface FunctionCall {
  callerFilePath: string;
  callerFunction: string;
  calledName: string;
  callType: 'function' | 'method' | 'attribute' | 'super';
  line: number;
  column: number;
  isChained?: boolean;
  objectName?: string;
  superMethodName?: string;
  assignedToVariable?: string;
  chainedFromVariable?: string;
}

interface ImportInfo {
  filePath: string;
  importedName: string;
  alias?: string;
  fromModule: string;
  importType: 'function' | 'class' | 'module' | 'attribute';
}

interface VariableTypeInfo {
  variableName: string;
  inferredType: string;
  filePath: string;
  functionContext: string;
  line: number;
  confidence: 'high' | 'medium' | 'low';
  source: 'constructor' | 'method_return' | 'factory' | 'assignment' | 'parameter';
}

interface MethodReturnTypeInfo {
  methodId: string;
  methodName: string;
  className: string;
  returnType?: string;
  filePath: string;
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
  private variableTypes: Map<string, VariableTypeInfo> = new Map();
  private methodReturnTypes: Map<string, MethodReturnTypeInfo> = new Map();
  private classConstructors: Map<string, GraphNode> = new Map();

  public async process(input: CallResolutionInput): Promise<void> {
    const { graph, astCache, fileContents } = input;
    
    // Build function node lookup for fast resolution
    this.buildFunctionNodeLookup(graph);
    
    console.log(`CallProcessor: Processing ${astCache.size} files with ASTs`);
    
    // Extract imports from all files first
    for (const [filePath, ast] of astCache) {
      if (this.isPythonFile(filePath)) {
        const content = fileContents.get(filePath);
        if (content && ast) {
          await this.extractImports(filePath, ast, content);
        }
      }
    }
    
    // For files without ASTs, try regex-based import extraction
    const pythonFiles = Array.from(fileContents.keys()).filter(path => this.isPythonFile(path));
    const filesWithoutAST = pythonFiles.filter(path => !astCache.has(path));
    
    if (filesWithoutAST.length > 0) {
      console.log(`CallProcessor: ${filesWithoutAST.length} files don't have ASTs, using regex fallback for imports`);
      for (const filePath of filesWithoutAST) {
        const content = fileContents.get(filePath);
        if (content) {
          await this.extractImportsRegex(filePath, content);
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
    
    console.log(`CallProcessor: Found imports in ${this.importCache.size} files`);
    
    // Create import relationships between files
    this.createImportRelationships(graph);
  }

  private createImportRelationships(graph: KnowledgeGraph): void {
    let importRelationshipsCreated = 0;
    
    for (const [filePath, imports] of this.importCache) {
      const sourceFileNode = graph.nodes.find(node => 
        node.label === 'File' && node.properties.filePath === filePath
      );
      
      if (!sourceFileNode) continue;
      
      for (const importInfo of imports) {
        // Try to find the target file based on the module name
        const targetFileNode = this.findTargetFileForImport(graph, importInfo);
        
        if (targetFileNode) {
          // Create IMPORTS relationship
          const relationship: GraphRelationship = {
            id: generateId('relationship', `${sourceFileNode.id}-imports-${targetFileNode.id}`),
            type: 'IMPORTS',
            source: sourceFileNode.id,
            target: targetFileNode.id,
            properties: {
              importedName: importInfo.importedName,
              fromModule: importInfo.fromModule,
              importType: importInfo.importType
            }
          };
          
          // Check if relationship already exists
          const existingRel = graph.relationships.find(rel => 
            rel.source === sourceFileNode.id && 
            rel.target === targetFileNode.id && 
            rel.type === 'IMPORTS'
          );
          
          if (!existingRel) {
            graph.relationships.push(relationship);
            importRelationshipsCreated++;
          }
        }
      }
    }
    
    console.log(`CallProcessor: Created ${importRelationshipsCreated} import relationships`);
  }

  private findTargetFileForImport(graph: KnowledgeGraph, importInfo: ImportInfo): GraphNode | null {
    const moduleName = importInfo.fromModule;
    
    // Try different strategies to find the target file
    const fileNodes = graph.nodes.filter(node => node.label === 'File');
    
    // Strategy 1: Direct module name match (e.g., "utils" -> "utils.py")
    let targetFile = fileNodes.find(node => {
      const fileName = node.properties.name as string;
      return fileName === `${moduleName}.py`;
    });
    
    if (targetFile) return targetFile;
    
    // Strategy 2: Last part of module path (e.g., "myproject.utils" -> "utils.py")
    const lastPart = moduleName.split('.').pop();
    if (lastPart) {
      targetFile = fileNodes.find(node => {
        const fileName = node.properties.name as string;
        return fileName === `${lastPart}.py`;
      });
    }
    
    if (targetFile) return targetFile;
    
    // Strategy 3: Check if module path matches file path
    targetFile = fileNodes.find(node => {
      const filePath = node.properties.filePath as string;
      return filePath && filePath.includes(moduleName.replace('.', '/'));
    });
    
    return targetFile || null;
  }

  private buildFunctionNodeLookup(graph: KnowledgeGraph): void {
    for (const node of graph.nodes) {
      if (node.label === 'Function' || node.label === 'Method') {
        const filePath = node.properties.filePath as string;
        const functionName = node.properties.name as string;
        
        // Create different keys for Functions vs Methods to avoid conflicts
        if (node.label === 'Method') {
          const parentClass = node.properties.parentClass as string;
          const methodKey = `${filePath}:method:${parentClass}.${functionName}`;
          this.functionNodes.set(methodKey, node);
          
          // Also add a general method key for resolution when class context is unknown
          const generalMethodKey = `${filePath}:method:${functionName}`;
          if (!this.functionNodes.has(generalMethodKey)) {
            this.functionNodes.set(generalMethodKey, node);
          }
          
          // Track method return type information
          this.buildMethodReturnTypeInfo(node, parentClass, functionName, filePath);
        } else {
          const functionKey = `${filePath}:function:${functionName}`;
          this.functionNodes.set(functionKey, node);
        }
      } else if (node.label === 'Class') {
        // Track class constructors for instantiation inference
        const className = node.properties.name as string;
        const filePath = node.properties.filePath as string;
        const classKey = `${filePath}:${className}`;
        this.classConstructors.set(classKey, node);
      }
    }
  }

  private buildMethodReturnTypeInfo(methodNode: GraphNode, className: string, methodName: string, filePath: string): void {
    const methodId = methodNode.id;
    
    // Infer return type based on method name and class context
    let returnType: string | undefined;
    
    // Constructor methods return the class instance
    if (methodName === '__init__' || methodName === '__new__') {
      returnType = className;
    }
    // Factory methods often return class instances
    else if (methodName.startsWith('create_') || methodName.startsWith('build_') || 
             methodName.startsWith('make_') || methodName.includes('factory')) {
      returnType = this.inferFactoryReturnType(methodName, className);
    }
    // Getter methods often return specific types
    else if (methodName.startsWith('get_')) {
      returnType = this.inferGetterReturnType(methodName, className);
    }
    // Property methods (decorated with @property) return the property type
    else if (methodNode.properties.decorators) {
      const decorators = methodNode.properties.decorators as string[];
      if (decorators.includes('property')) {
        returnType = this.inferPropertyReturnType(methodName, className);
      }
    }
    
    const returnTypeInfo: MethodReturnTypeInfo = {
      methodId,
      methodName,
      className,
      returnType,
      filePath
    };
    
    this.methodReturnTypes.set(methodId, returnTypeInfo);
  }

  private inferFactoryReturnType(methodName: string, className: string): string | undefined {
    // Factory methods like create_user, build_report, make_connection
    if (methodName.startsWith('create_')) {
      const typeName = methodName.substring(7); // Remove 'create_'
      return this.capitalizeFirstLetter(typeName);
    }
    if (methodName.startsWith('build_')) {
      const typeName = methodName.substring(6); // Remove 'build_'
      return this.capitalizeFirstLetter(typeName);
    }
    if (methodName.startsWith('make_')) {
      const typeName = methodName.substring(5); // Remove 'make_'
      return this.capitalizeFirstLetter(typeName);
    }
    
    // If it's a factory class, it might return instances of the main entity
    if (className.endsWith('Factory')) {
      const entityName = className.substring(0, className.length - 7); // Remove 'Factory'
      return entityName;
    }
    
    return undefined;
  }

  private inferGetterReturnType(methodName: string, className: string): string | undefined {
    // Common getter patterns
    if (methodName === 'get_name' || methodName === 'get_title') return 'str';
    if (methodName === 'get_id' || methodName === 'get_count') return 'int';
    if (methodName === 'get_price' || methodName === 'get_amount') return 'float';
    if (methodName === 'get_active' || methodName === 'get_enabled') return 'bool';
    if (methodName.includes('_list') || methodName.includes('_all')) return 'list';
    if (methodName.includes('_dict') || methodName.includes('_data')) return 'dict';
    
    return undefined;
  }

  private inferPropertyReturnType(methodName: string, className: string): string | undefined {
    // Property return type inference based on naming patterns
    if (methodName === 'name' || methodName === 'title' || methodName === 'description') return 'str';
    if (methodName === 'id' || methodName === 'count' || methodName === 'size') return 'int';
    if (methodName === 'price' || methodName === 'amount' || methodName === 'rate') return 'float';
    if (methodName === 'active' || methodName === 'enabled' || methodName === 'valid') return 'bool';
    
    return undefined;
  }

  private capitalizeFirstLetter(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
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
      
      // Track variable assignments for type inference
      if (node.type === 'assignment') {
        this.processVariableAssignment(node, filePath, currentFunction);
      }
      
      // Find function calls
      if (node.type === 'call') {
        const callInfo = this.extractCallInfo(node, filePath, currentFunction, content);
        if (callInfo) {
          // Check if this call is part of an assignment
          const assignmentInfo = this.extractAssignmentInfo(node);
          if (assignmentInfo) {
            callInfo.assignedToVariable = assignmentInfo.variableName;
          }
          
          functionCalls.push(callInfo);
        }
      }
    });
    
    // Resolve calls and create relationships
    for (const call of functionCalls) {
      await this.resolveAndCreateCallRelationship(graph, call);
      
      // Track variable type if this call is assigned to a variable
      if (call.assignedToVariable) {
        this.inferAndTrackVariableType(graph, call);
      }
    }
  }

  private processVariableAssignment(assignmentNode: any, filePath: string, currentFunction: string | null): void {
    const leftNode = assignmentNode.childForFieldName('left');
    const rightNode = assignmentNode.childForFieldName('right');
    
    if (!leftNode || !rightNode) return;
    
    // Extract variable name from left side
    let variableName: string | null = null;
    if (leftNode.type === 'identifier') {
      variableName = leftNode.text;
    }
    
    if (!variableName) return;
    
    // Analyze right side for type inference
    if (rightNode.type === 'call') {
      // This will be handled in the call processing
      return;
    } else if (rightNode.type === 'identifier') {
      // Variable assignment from another variable
      const sourceVariable = rightNode.text;
      this.copyVariableType(filePath, currentFunction || '<module>', sourceVariable, variableName);
    }
  }

  private extractAssignmentInfo(callNode: any): { variableName: string } | null {
    // Walk up the AST to find if this call is part of an assignment
    let parent = callNode.parent;
    
    while (parent) {
      if (parent.type === 'assignment') {
        const leftNode = parent.childForFieldName('left');
        if (leftNode && leftNode.type === 'identifier') {
          return { variableName: leftNode.text };
        }
      }
      parent = parent.parent;
    }
    
    return null;
  }

  private inferAndTrackVariableType(graph: KnowledgeGraph, call: FunctionCall): void {
    if (!call.assignedToVariable) return;
    
    let inferredType: string | undefined;
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let source: VariableTypeInfo['source'] = 'assignment';
    
    // Try to infer type based on the call
    if (call.callType === 'function' || call.callType === 'method') {
      // Check if it's a class constructor call
      const constructorType = this.inferConstructorType(graph, call);
      if (constructorType) {
        inferredType = constructorType;
        confidence = 'high';
        source = 'constructor';
      } else {
        // Check if it's a method call with known return type
        const methodReturnType = this.inferMethodReturnType(graph, call);
        if (methodReturnType) {
          inferredType = methodReturnType.returnType;
          confidence = methodReturnType.confidence;
          source = 'method_return';
        }
      }
    }
    
    if (inferredType) {
      const variableKey = `${call.callerFilePath}:${call.callerFunction}:${call.assignedToVariable}`;
      const typeInfo: VariableTypeInfo = {
        variableName: call.assignedToVariable,
        inferredType,
        filePath: call.callerFilePath,
        functionContext: call.callerFunction,
        line: call.line,
        confidence,
        source
      };
      
      this.variableTypes.set(variableKey, typeInfo);
      this.logTypeInference(call, inferredType, confidence);
    }
  }

  private inferConstructorType(graph: KnowledgeGraph, call: FunctionCall): string | undefined {
    // Check if the called function is a class constructor
    const classKey = `${call.callerFilePath}:${call.calledName}`;
    if (this.classConstructors.has(classKey)) {
      return call.calledName;
    }
    
    // Check for imported class constructors
    const imports = this.importCache.get(call.callerFilePath) || [];
    for (const importInfo of imports) {
      if (importInfo.importedName === call.calledName && importInfo.importType === 'class') {
        return call.calledName;
      }
    }
    
    return undefined;
  }

  private inferMethodReturnType(graph: KnowledgeGraph, call: FunctionCall): { returnType?: string, confidence: 'high' | 'medium' | 'low' } | null {
    // Find the method node that was called
    const targetNode = this.resolveMethodCall(graph, call) || this.resolveLocalFunction(call);
    
    if (targetNode && this.methodReturnTypes.has(targetNode.id)) {
      const returnTypeInfo = this.methodReturnTypes.get(targetNode.id)!;
      return {
        returnType: returnTypeInfo.returnType,
        confidence: returnTypeInfo.returnType ? 'medium' : 'low'
      };
    }
    
    return null;
  }

  private copyVariableType(filePath: string, functionContext: string, sourceVar: string, targetVar: string): void {
    const sourceKey = `${filePath}:${functionContext}:${sourceVar}`;
    const sourceType = this.variableTypes.get(sourceKey);
    
    if (sourceType) {
      const targetKey = `${filePath}:${functionContext}:${targetVar}`;
      const copiedType: VariableTypeInfo = {
        ...sourceType,
        variableName: targetVar
      };
      this.variableTypes.set(targetKey, copiedType);
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
      // Method call: obj.method() or super().method() or chained call
      const objectNode = functionNode.childForFieldName('object');
      const attributeNode = functionNode.childForFieldName('attribute');
      
      if (objectNode && attributeNode) {
        // Check if this is a super() call
        if (objectNode.type === 'call') {
          const superFunctionNode = objectNode.childForFieldName('function');
          if (superFunctionNode && superFunctionNode.type === 'identifier' && superFunctionNode.text === 'super') {
            // This is a super().method() call
            return {
              callerFilePath: filePath,
              callerFunction: currentFunction || '<module>',
              calledName: 'super',
              callType: 'super',
              line,
              column,
              superMethodName: attributeNode.text
            };
          }
        }
        
        // Check if the object is a variable with known type (for chained calls)
        let objectName = objectNode.text;
        let chainedFromVariable: string | undefined;
        
        if (objectNode.type === 'identifier') {
          // This might be a method call on a typed variable
          const variableType = this.getVariableType(filePath, currentFunction || '<module>', objectName);
          if (variableType) {
            chainedFromVariable = objectName;
          }
        }
        
        // Regular method call
        return {
          callerFilePath: filePath,
          callerFunction: currentFunction || '<module>',
          calledName: attributeNode.text,
          callType: 'method',
          line,
          column,
          objectName: objectName,
          chainedFromVariable
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
    
    // Improved resolution order: prioritize imports to avoid self-referential calls
    const targetNode = 
      this.resolveBuiltinFunction(call) ||
      this.resolveImportedFunction(call) ||  // Check imports first
      this.resolveSuperCall(graph, call) ||  // Check super() calls
      this.resolveMethodCall(graph, call) ||
      this.resolveLocalFunction(call) ||     // Check local functions
      this.resolveWithAdvancedFallback(graph, call);  // Advanced fallback for ambiguous calls
    
    if (targetNode) {
      // Prevent self-referential calls unless it's actually recursive
      if (callerNode.id === targetNode.id) {
        // Only allow self-calls if the function name matches exactly (true recursion)
        const callerName = callerNode.properties.name as string;
        if (callerName !== call.calledName) {
          console.warn(`Prevented incorrect self-referential call from ${callerName} to ${call.calledName}`);
          return;
        }
      }
      
      const existingNode = graph.nodes.find(node => node.id === targetNode.id);
      if (!existingNode) {
        graph.nodes.push(targetNode);
      }
      
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
      // Handle direct import match (from module import function)
      if (importInfo.importedName === call.calledName || importInfo.alias === call.calledName) {
        return this.getOrCreateImportedNode(call.calledName, importInfo.fromModule);
      }
      
      // Handle module.function pattern (import module; module.function())
      if (call.callType === 'method' && call.objectName) {
        // Check if objectName matches imported module or alias
        if (importInfo.importedName === call.objectName || importInfo.alias === call.objectName) {
          // This is a call to an imported module's function
          return this.getOrCreateImportedNode(call.calledName, importInfo.fromModule);
        }
      }
      
      // Handle import module as alias patterns
      if (call.callType === 'method' && call.objectName === importInfo.alias && importInfo.importType === 'module') {
        return this.getOrCreateImportedNode(call.calledName, importInfo.fromModule);
      }
    }
    
    return null;
  }

  private resolveWithAdvancedFallback(graph: KnowledgeGraph, call: FunctionCall): GraphNode | null {
    // Find all potential candidates across the entire graph
    const candidates = this.findAllCandidates(graph, call);
    
    if (candidates.length === 0) {
      return null;
    }
    
    if (candidates.length === 1) {
      return candidates[0];
    }
    
    // Multiple candidates found - use heuristics to pick the best one
    const rankedCandidates = this.rankCandidatesByProximity(call.callerFilePath, candidates);
    
    if (rankedCandidates.length > 0) {
      const bestCandidate = rankedCandidates[0];
      
      // Enable detailed logging for debugging (can be controlled via environment variable)
      const enableDetailedLogging = typeof process !== 'undefined' && process.env?.GITNEXUS_DEBUG_FALLBACK === 'true';
      if (enableDetailedLogging) {
        this.logCandidateAnalysis(call, rankedCandidates);
      } else {
        console.log(`Advanced fallback: Selected ${bestCandidate.node.properties.filePath}:${bestCandidate.node.properties.name} for call to ${call.calledName} from ${call.callerFilePath} (score: ${bestCandidate.score.toFixed(2)})`);
      }
      
      return bestCandidate.node;
    }
    
    return null;
  }

  private applySpecialCaseHeuristics(call: FunctionCall, candidates: GraphNode[]): GraphNode[] {
    // Apply special case filtering and prioritization
    const filtered = candidates.filter(candidate => {
      // Skip obvious non-matches
      if (this.isObviousNonMatch(call, candidate)) {
        return false;
      }
      
      return true;
    });
    
    // Apply framework-specific heuristics
    return this.applyFrameworkHeuristics(call, filtered);
  }

  private isObviousNonMatch(call: FunctionCall, candidate: GraphNode): boolean {
    const candidatePath = candidate.properties.filePath as string;
    const candidateName = candidate.properties.name as string;
    const callerPath = call.callerFilePath;
    
    // Skip if candidate is in a completely different domain
    const callerDomain = this.extractDomain(callerPath);
    const candidateDomain = this.extractDomain(candidatePath);
    
    if (callerDomain && candidateDomain && callerDomain !== candidateDomain) {
      const commonDomains = ['utils', 'helpers', 'common', 'shared', 'lib', 'core'];
      if (!commonDomains.includes(candidateDomain.toLowerCase())) {
        return true;
      }
    }
    
    // Skip private/internal functions when caller is not in same module
    if (candidateName.startsWith('_') && !this.areInSameModule(callerPath, candidatePath)) {
      return true;
    }
    
    return false;
  }

  private applyFrameworkHeuristics(call: FunctionCall, candidates: GraphNode[]): GraphNode[] {
    // Django-specific heuristics
    if (this.isDjangoProject(call.callerFilePath)) {
      return this.applyDjangoHeuristics(call, candidates);
    }
    
    // Flask-specific heuristics
    if (this.isFlaskProject(call.callerFilePath)) {
      return this.applyFlaskHeuristics(call, candidates);
    }
    
    // FastAPI-specific heuristics
    if (this.isFastAPIProject(call.callerFilePath)) {
      return this.applyFastAPIHeuristics(call, candidates);
    }
    
    return candidates;
  }

  private extractDomain(filePath: string): string | null {
    const parts = filePath.split('/').filter(p => p.length > 0);
    if (parts.length >= 2) {
      return parts[parts.length - 2]; // Directory containing the file
    }
    return null;
  }

  private areInSameModule(path1: string, path2: string): boolean {
    const parts1 = path1.split('/').slice(0, -1); // Remove filename
    const parts2 = path2.split('/').slice(0, -1); // Remove filename
    
    // Consider same module if they share at least 2 path segments
    let commonSegments = 0;
    const minLength = Math.min(parts1.length, parts2.length);
    
    for (let i = 0; i < minLength; i++) {
      if (parts1[i] === parts2[i]) {
        commonSegments++;
      } else {
        break;
      }
    }
    
    return commonSegments >= 2;
  }

  private isDjangoProject(filePath: string): boolean {
    return filePath.includes('django') || 
           filePath.includes('models.py') || 
           filePath.includes('views.py') ||
           filePath.includes('urls.py');
  }

  private isFlaskProject(filePath: string): boolean {
    return filePath.includes('flask') || 
           filePath.includes('app.py') ||
           filePath.includes('routes.py');
  }

  private isFastAPIProject(filePath: string): boolean {
    return filePath.includes('fastapi') || 
           filePath.includes('main.py') ||
           filePath.includes('routers/');
  }

  private applyDjangoHeuristics(call: FunctionCall, candidates: GraphNode[]): GraphNode[] {
    // Prefer models.py for model-related functions, views.py for view functions, etc.
    return candidates.sort((a, b) => {
      const pathA = a.properties.filePath as string;
      const pathB = b.properties.filePath as string;
      
      if (call.callerFilePath.includes('views.py') && pathA.includes('models.py')) {
        return -1; // Prefer models.py when called from views.py
      }
      
      return 0;
    });
  }

  private applyFlaskHeuristics(call: FunctionCall, candidates: GraphNode[]): GraphNode[] {
    // Flask-specific prioritization logic
    return candidates;
  }

  private applyFastAPIHeuristics(call: FunctionCall, candidates: GraphNode[]): GraphNode[] {
    // FastAPI-specific prioritization logic
    return candidates;
  }

  private findAllCandidates(graph: KnowledgeGraph, call: FunctionCall): GraphNode[] {
    const candidates: GraphNode[] = [];
    
    // Look for functions and methods with matching names across all files
    for (const node of graph.nodes) {
      if ((node.label === 'Function' || node.label === 'Method') && 
          node.properties.name === call.calledName &&
          node.properties.filePath !== call.callerFilePath) {  // Exclude same file (already checked)
        candidates.push(node);
      }
    }
    
    // Apply special case heuristics to filter and prioritize candidates
    return this.applySpecialCaseHeuristics(call, candidates);
  }

  private rankCandidatesByProximity(callerFilePath: string, candidates: GraphNode[]): Array<{node: GraphNode, score: number}> {
    const scored = candidates.map(candidate => ({
      node: candidate,
      score: this.calculateProximityScore(callerFilePath, candidate.properties.filePath as string)
    }));
    
    // Sort by score (higher is better)
    return scored.sort((a, b) => b.score - a.score);
  }

  private calculateProximityScore(callerPath: string, candidatePath: string): number {
    // Normalize paths (convert backslashes to forward slashes)
    const normalizedCaller = this.normalizePath(callerPath);
    const normalizedCandidate = this.normalizePath(candidatePath);
    
    const callerParts = normalizedCaller.split('/').filter(part => part.length > 0);
    const candidateParts = normalizedCandidate.split('/').filter(part => part.length > 0);
    
    let score = 0;
    
    // Base score: prefer shorter paths (closer to root)
    score += Math.max(0, 10 - candidateParts.length);
    
    // Proximity score: count common path segments from the beginning
    let commonPrefixLength = 0;
    const minLength = Math.min(callerParts.length, candidateParts.length);
    
    for (let i = 0; i < minLength - 1; i++) {  // Exclude filename
      if (callerParts[i] === candidateParts[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }
    
    // Higher score for more common path segments
    score += commonPrefixLength * 20;
    
    // Same directory bonus
    if (commonPrefixLength === Math.min(callerParts.length - 1, candidateParts.length - 1)) {
      score += 30;
    }
    
    // Sibling directory bonus (same parent, different immediate directory)
    if (commonPrefixLength === Math.min(callerParts.length - 2, candidateParts.length - 2) && 
        commonPrefixLength > 0) {
      score += 15;
    }
    
    // Naming convention bonuses
    score += this.calculateNamingConventionScore(normalizedCaller, normalizedCandidate);
    
    // Penalize deep nested paths
    const nestingPenalty = Math.max(0, candidateParts.length - 5) * 2;
    score -= nestingPenalty;
    
    return score;
  }

  private calculateNamingConventionScore(callerPath: string, candidatePath: string): number {
    let score = 0;
    
    // Extract directory and file names
    const callerParts = callerPath.split('/');
    const candidateParts = candidatePath.split('/');
    
    const callerDir = callerParts[callerParts.length - 2] || '';
    const candidateDir = candidateParts[candidateParts.length - 2] || '';
    
    const callerFile = callerParts[callerParts.length - 1].replace(/\.[^.]*$/, '');
    const candidateFile = candidateParts[candidateParts.length - 1].replace(/\.[^.]*$/, '');
    
    // Prefer utils, helpers, common files
    if (candidateFile.match(/^(utils?|helpers?|common|shared|lib|core)$/i)) {
      score += 10;
    }
    
    // Prefer files with similar names
    if (this.calculateStringSimilarity(callerFile, candidateFile) > 0.6) {
      score += 8;
    }
    
    // Prefer similar directory names
    if (this.calculateStringSimilarity(callerDir, candidateDir) > 0.7) {
      score += 5;
    }
    
    // Avoid test files unless caller is also a test
    if (candidateFile.match(/test|spec/i) && !callerFile.match(/test|spec/i)) {
      score -= 20;
    }
    
    // Avoid legacy/deprecated paths
    if (candidatePath.match(/(legacy|deprecated|old|archive)/i)) {
      score -= 15;
    }
    
    return score;
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;
    
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.calculateLevenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private calculateLevenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator  // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase();
  }

  private resolveSuperCall(graph: KnowledgeGraph, call: FunctionCall): GraphNode | null {
    if (call.callType !== 'super' || !call.superMethodName) return null;
    
    // Find the current method node to get its class context
    const currentMethodNode = graph.nodes.find(node => 
      node.label === 'Method' && 
      node.properties.filePath === call.callerFilePath &&
      node.properties.name === call.callerFunction
    );
    
    if (!currentMethodNode || !currentMethodNode.properties.parentClass) return null;
    
    const currentClassName = currentMethodNode.properties.parentClass as string;
    
    // Find the current class node to get its base classes
    const currentClassNode = graph.nodes.find(node => 
      node.label === 'Class' && 
      node.properties.filePath === call.callerFilePath &&
      node.properties.name === currentClassName
    );
    
    if (!currentClassNode || !currentClassNode.properties.baseClasses) return null;
    
    const baseClasses = currentClassNode.properties.baseClasses as string[];
    
    // Look for the method in each base class (in order)
    for (const baseClassName of baseClasses) {
      const baseMethodNode = graph.nodes.find(node => 
        node.label === 'Method' && 
        node.properties.name === call.superMethodName &&
        node.properties.parentClass === baseClassName
      );
      
      if (baseMethodNode) {
        return baseMethodNode;
      }
    }
    
    return null;
  }

  private resolveLocalFunction(call: FunctionCall): GraphNode | null {
    // Try function key first
    const functionKey = `${call.callerFilePath}:function:${call.calledName}`;
    const functionNode = this.functionNodes.get(functionKey);
    if (functionNode) {
      return functionNode;
    }
    
    // Try method key if function not found
    const methodKey = `${call.callerFilePath}:method:${call.calledName}`;
    return this.functionNodes.get(methodKey) || null;
  }

  private getVariableType(filePath: string, functionContext: string, variableName: string): VariableTypeInfo | null {
    const variableKey = `${filePath}:${functionContext}:${variableName}`;
    return this.variableTypes.get(variableKey) || null;
  }

  private resolveMethodCall(graph: KnowledgeGraph, call: FunctionCall): GraphNode | null {
    if (call.callType !== 'method') return null;
    
    // If this is a chained method call, use type information to resolve
    if (call.chainedFromVariable) {
      const variableType = this.getVariableType(call.callerFilePath, call.callerFunction, call.chainedFromVariable);
      if (variableType) {
        return this.resolveMethodOnType(graph, call, variableType.inferredType);
      }
    }
    
    // First try to find methods in the same file using the new key format
    const methodKey = `${call.callerFilePath}:method:${call.calledName}`;
    const methodNode = this.functionNodes.get(methodKey);
    if (methodNode) {
      return methodNode;
    }
    
    // Fallback: look for method nodes in the graph (for cases where key lookup fails)
    const methods = graph.nodes.filter(node => 
      node.label === 'Method' && 
      node.properties.filePath === call.callerFilePath &&
      node.properties.name === call.calledName
    );
    
    return methods[0] || null;
  }

  private resolveMethodOnType(graph: KnowledgeGraph, call: FunctionCall, typeName: string): GraphNode | null {
    // Look for methods of the specified type across all files
    const methods = graph.nodes.filter(node => 
      node.label === 'Method' && 
      node.properties.name === call.calledName &&
      node.properties.parentClass === typeName
    );
    
    if (methods.length > 0) {
      // Prefer methods in the same file, then use proximity-based ranking
      const sameFileMethod = methods.find(method => 
        method.properties.filePath === call.callerFilePath
      );
      
      if (sameFileMethod) {
        return sameFileMethod;
      }
      
      // Use advanced fallback ranking for cross-file method resolution
      const rankedMethods = this.rankCandidatesByProximity(call.callerFilePath, methods);
      return rankedMethods.length > 0 ? rankedMethods[0].node : methods[0];
    }
    
    return null;
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

  public getTypeInferenceStats(): {
    totalVariablesTyped: number;
    typesByConfidence: Record<string, number>;
    typesBySource: Record<string, number>;
    mostCommonTypes: Array<{type: string, count: number}>;
  } {
    const stats = {
      totalVariablesTyped: this.variableTypes.size,
      typesByConfidence: { high: 0, medium: 0, low: 0 },
      typesBySource: { constructor: 0, method_return: 0, factory: 0, assignment: 0, parameter: 0 },
      mostCommonTypes: [] as Array<{type: string, count: number}>
    };
    
    const typeCounts = new Map<string, number>();
    
    for (const typeInfo of this.variableTypes.values()) {
      stats.typesByConfidence[typeInfo.confidence]++;
      stats.typesBySource[typeInfo.source]++;
      
      const currentCount = typeCounts.get(typeInfo.inferredType) || 0;
      typeCounts.set(typeInfo.inferredType, currentCount + 1);
    }
    
    // Sort types by frequency
    stats.mostCommonTypes = Array.from(typeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return stats;
  }

  public getVariableTypeInfo(filePath: string, functionContext: string, variableName: string): VariableTypeInfo | null {
    return this.getVariableType(filePath, functionContext, variableName);
  }

  public getAllVariableTypes(): VariableTypeInfo[] {
    return Array.from(this.variableTypes.values());
  }

  private logTypeInference(call: FunctionCall, inferredType: string, confidence: string): void {
    if (typeof process !== 'undefined' && process.env?.GITNEXUS_DEBUG_TYPES === 'true') {
      console.log(`Type inference: ${call.assignedToVariable} = ${call.calledName}() -> ${inferredType} (${confidence} confidence)`);
    }
  }

  public getAdvancedFallbackStats(): {
    totalFallbackResolutions: number; 
    successfulResolutions: number;
    ambiguousCallsResolved: number;
  } {
    // This would be populated during processing in a real implementation
    return {
      totalFallbackResolutions: 0,
      successfulResolutions: 0,
      ambiguousCallsResolved: 0
    };
  }

  private logCandidateAnalysis(call: FunctionCall, candidates: Array<{node: GraphNode, score: number}>): void {
    console.log(`\n=== Advanced Fallback Analysis for ${call.calledName} ===`);
    console.log(`Caller: ${call.callerFilePath}:${call.callerFunction}`);
    console.log(`Found ${candidates.length} candidates:`);
    
    candidates.forEach((candidate, index) => {
      const filePath = candidate.node.properties.filePath as string;
      const name = candidate.node.properties.name as string;
      const label = candidate.node.label;
      
      console.log(`  ${index + 1}. ${filePath}:${name} (${label}) - Score: ${candidate.score.toFixed(2)}`);
      
      if (index === 0) {
        console.log(`     ✅ SELECTED`);
      }
    });
    console.log(`==========================================\n`);
  }

  private async extractImportsRegex(filePath: string, content: string): Promise<void> {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Match: import module
      const importMatch = trimmedLine.match(/^import\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/);
      if (importMatch) {
        const moduleName = importMatch[1];
        imports.push({
          filePath,
          importedName: moduleName,
          fromModule: moduleName,
          importType: 'module'
        });
      }
      
      // Match: from module import item
      const fromImportMatch = trimmedLine.match(/^from\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s+import\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (fromImportMatch) {
        const moduleName = fromImportMatch[1];
        const importedName = fromImportMatch[2];
        imports.push({
          filePath,
          importedName,
          fromModule: moduleName,
          importType: 'function' // Default assumption
        });
      }
    }
    
    if (imports.length > 0) {
      this.importCache.set(filePath, imports);
      console.log(`Regex-extracted ${imports.length} imports from ${filePath}`);
    }
  }
} 


