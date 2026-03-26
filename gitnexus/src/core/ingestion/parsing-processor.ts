import { KnowledgeGraph, GraphNode, GraphRelationship, type NodeLabel } from '../graph/types.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage, isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable } from './symbol-table.js';
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { getDefinitionNodeFromCaptures, findEnclosingClassId, extractMethodSignature, getLabelFromCaptures } from './utils/ast-helpers.js';
import { extractPropertyDeclaredType } from './type-extractors/shared.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { WorkerPool } from './workers/worker-pool.js';
import type { ParseWorkerResult, ParseWorkerInput, ExtractedImport, ExtractedCall, ExtractedAssignment, ExtractedHeritage, ExtractedRoute, ExtractedFetchCall, ExtractedDecoratorRoute, ExtractedToolDef, FileConstructorBindings, FileTypeEnvBindings } from './workers/parse-worker.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from './constants.js';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

export interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  constructorBindings: FileConstructorBindings[];
  typeEnvBindings: FileTypeEnvBindings[];
}

// ============================================================================
// Worker-based parallel parsing
// ============================================================================

const processParsingWithWorkers = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
): Promise<WorkerExtractedData> => {
  // Filter to parseable files only
  const parseableFiles: ParseWorkerInput[] = [];
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (lang) parseableFiles.push({ path: file.path, content: file.content });
  }

  if (parseableFiles.length === 0) return { imports: [], calls: [], assignments: [], heritage: [], routes: [], fetchCalls: [], decoratorRoutes: [], toolDefs: [], constructorBindings: [], typeEnvBindings: [] };

  const total = files.length;

  // Dispatch to worker pool — pool handles splitting into chunks and sub-batching
  const chunkResults = await workerPool.dispatch<ParseWorkerInput, ParseWorkerResult>(
    parseableFiles,
    (filesProcessed) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, 'Parsing...');
    },
  );

  // Merge results from all workers into graph and symbol table
  const allImports: ExtractedImport[] = [];
  const allCalls: ExtractedCall[] = [];
  const allAssignments: ExtractedAssignment[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allRoutes: ExtractedRoute[] = [];
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allConstructorBindings: FileConstructorBindings[] = [];
  const allTypeEnvBindings: FileTypeEnvBindings[] = [];
  for (const result of chunkResults) {
    for (const node of result.nodes) {
      graph.addNode({
        id: node.id,
        label: node.label as any,
        properties: node.properties,
      });
    }

    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }

    for (const sym of result.symbols) {
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
        parameterCount: sym.parameterCount,
        requiredParameterCount: sym.requiredParameterCount,
        parameterTypes: sym.parameterTypes,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        ownerId: sym.ownerId,
      });
    }

    allImports.push(...result.imports);
    allCalls.push(...result.calls);
    allAssignments.push(...result.assignments);
    allHeritage.push(...result.heritage);
    allRoutes.push(...result.routes);
    allFetchCalls.push(...result.fetchCalls);
    allDecoratorRoutes.push(...result.decoratorRoutes);
    allToolDefs.push(...result.toolDefs);
    allConstructorBindings.push(...result.constructorBindings);
    allTypeEnvBindings.push(...result.typeEnvBindings);
  }

  // Merge and log skipped languages from workers
  const skippedLanguages = new Map<string, number>();
  for (const result of chunkResults) {
    for (const [lang, count] of Object.entries(result.skippedLanguages)) {
      skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
    }
  }
  if (skippedLanguages.size > 0) {
    const summary = Array.from(skippedLanguages.entries())
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    console.warn(`  Skipped unsupported languages: ${summary}`);
  }

  // Final progress
  onFileProgress?.(total, total, 'done');
  return { imports: allImports, calls: allCalls, assignments: allAssignments, heritage: allHeritage, routes: allRoutes, fetchCalls: allFetchCalls, decoratorRoutes: allDecoratorRoutes, toolDefs: allToolDefs, constructorBindings: allConstructorBindings, typeEnvBindings: allTypeEnvBindings };
};

// ============================================================================
// Sequential fallback (original implementation)
// ============================================================================

// Inline caches to avoid repeated parent-walks per node (same pattern as parse-worker.ts).
// Keyed by tree-sitter node reference — cleared at the start of each file.
const classIdCache = new Map<any, string | null>();
const exportCache = new Map<any, boolean>();

const cachedFindEnclosingClassId = (node: any, filePath: string): string | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;
  const result = findEnclosingClassId(node, filePath);
  classIdCache.set(node, result);
  return result;
};

const cachedExportCheck = (checker: (node: any, name: string) => boolean, node: any, name: string): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;
  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

const processParsingSequential = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback
) => {
  const parser = await loadParser();
  const total = files.length;
  const skippedLanguages = new Map<string, number>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Reset memoization before each new file (node refs are per-tree)
    classIdCache.clear();
    exportCache.clear();

    onFileProgress?.(i + 1, total, file.path);

    if (i % 20 === 0) await yieldToEventLoop();

    const language = getLanguageFromFilename(file.path);

    if (!language) continue;

    // Skip unsupported languages (e.g. Swift when tree-sitter-swift not installed)
    if (!isLanguageAvailable(language)) {
      skippedLanguages.set(language, (skippedLanguages.get(language) || 0) + 1);
      continue;
    }

    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    try {
      await loadLanguage(language, file.path);
    } catch {
      continue;  // parser unavailable — safety net
    }

    let tree;
    try {
      tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
    } catch (parseError) {
      console.warn(`Skipping unparseable file: ${file.path}`);
      continue;
    }

    astCache.set(file.path, tree);

    const provider = getProvider(language);
    const queryString = provider.treeSitterQueries;
    if (!queryString) {
      continue;
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryString);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};

      match.captures.forEach(c => {
        captureMap[c.name] = c.node;
      });

      const nodeLabel = getLabelFromCaptures(captureMap, provider);
      if (!nodeLabel) return;

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') return;
      const nodeName = nameNode ? nameNode.text : 'init';

      const definitionNodeForRange = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNodeForRange ? definitionNodeForRange.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      // Extract method signature for Method/Constructor nodes
      const methodSig = (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor')
        ? extractMethodSignature(definitionNode)
        : undefined;

      // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
      // Also upgrades uninformative AST types like PHP `array` with PHPDoc `@return User[]`
      if (methodSig && (!methodSig.returnType || methodSig.returnType === 'array' || methodSig.returnType === 'iterable') && definitionNode) {
        const tc = provider.typeConfig;
        if (tc?.extractReturnType) {
          const docReturn = tc.extractReturnType(definitionNode);
          if (docReturn) methodSig.returnType = docReturn;
        }
      }

      const node: GraphNode = {
        id: nodeId,
        label: nodeLabel as any,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNodeForRange ? definitionNodeForRange.startPosition.row : startLine,
          endLine: definitionNodeForRange ? definitionNodeForRange.endPosition.row : startLine,
          language: language,
          isExported: cachedExportCheck(provider.exportChecker, nameNode || definitionNodeForRange, nodeName),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
          ...(methodSig ? {
            parameterCount: methodSig.parameterCount,
            ...(methodSig.requiredParameterCount !== undefined ? { requiredParameterCount: methodSig.requiredParameterCount } : {}),
            ...(methodSig.parameterTypes ? { parameterTypes: methodSig.parameterTypes } : {}),
            returnType: methodSig.returnType,
          } : {}),
        },
      };

      graph.addNode(node);

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? cachedFindEnclosingClassId(nameNode || definitionNodeForRange, file.path) : null;

      // Extract declared type for Property nodes (field/property type annotations)
      const declaredType = (nodeLabel === 'Property' && definitionNode)
        ? extractPropertyDeclaredType(definitionNode)
        : undefined;

      symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
        parameterCount: methodSig?.parameterCount,
        requiredParameterCount: methodSig?.requiredParameterCount,
        parameterTypes: methodSig?.parameterTypes,
        returnType: methodSig?.returnType,
        declaredType,
        ownerId: enclosingClassId ?? undefined,
      });

      const fileId = generateId('File', file.path);

      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);

      const relationship: GraphRelationship = {
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      };

      graph.addRelationship(relationship);

      // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
      if (enclosingClassId) {
        const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
        graph.addRelationship({
          id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: memberEdgeType,
          confidence: 1.0,
          reason: '',
        });
      }
    });
  }

  if (skippedLanguages.size > 0) {
    const summary = Array.from(skippedLanguages.entries())
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    console.warn(`  Skipped unsupported languages: ${summary}`);
  }
};

// ============================================================================
// Public API
// ============================================================================

export const processParsing = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback,
  workerPool?: WorkerPool,
): Promise<WorkerExtractedData | null> => {
  if (workerPool) {
    try {
      return await processParsingWithWorkers(graph, files, symbolTable, astCache, workerPool, onFileProgress);
    } catch (err) {
      console.warn('Worker pool parsing failed, falling back to sequential:', err instanceof Error ? err.message : err);
    }
  }

  // Fallback: sequential parsing (no pre-extracted data)
  await processParsingSequential(graph, files, symbolTable, astCache, onFileProgress);
  return null;
};
