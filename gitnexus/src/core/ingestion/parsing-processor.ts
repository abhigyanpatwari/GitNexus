import { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage, isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable } from './symbol-table.js';
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename, yieldToEventLoop, DEFINITION_CAPTURE_KEYS, getDefinitionNodeFromCaptures, findEnclosingClassId, extractMethodSignature } from './utils.js';
import { isNodeExported } from './export-detection.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { typeConfigs } from './type-extractors/index.js';
import { WorkerPool } from './workers/worker-pool.js';
import type { ParseWorkerResult, ParseWorkerInput, ExtractedImport, ExtractedCall, ExtractedHeritage, ExtractedRoute, FileConstructorBindings } from './workers/parse-worker.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from './constants.js';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

export interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  constructorBindings: FileConstructorBindings[];
}

// isNodeExported imported from ./export-detection.js (shared module)
// Re-export for backward compatibility with any external consumers
export { isNodeExported } from './export-detection.js';

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

  if (parseableFiles.length === 0) return { imports: [], calls: [], heritage: [], routes: [], constructorBindings: [] };

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
  const allHeritage: ExtractedHeritage[] = [];
  const allRoutes: ExtractedRoute[] = [];
  const allConstructorBindings: FileConstructorBindings[] = [];
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
        returnType: sym.returnType,
        ownerId: sym.ownerId,
      });
    }

    allImports.push(...result.imports);
    allCalls.push(...result.calls);
    allHeritage.push(...result.heritage);
    allRoutes.push(...result.routes);
    allConstructorBindings.push(...result.constructorBindings);
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
  return { imports: allImports, calls: allCalls, heritage: allHeritage, routes: allRoutes, constructorBindings: allConstructorBindings };
};

// ============================================================================
// Sequential fallback (original implementation)
// ============================================================================

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

    const queryString = LANGUAGE_QUERIES[language];
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

      if (captureMap['import']) {
        return;
      }

      if (captureMap['call']) {
        return;
      }

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && !captureMap['definition.constructor']) return;
      const nodeName = nameNode ? nameNode.text : 'init';

      let nodeLabel = 'CodeElement';

      if (captureMap['definition.function']) nodeLabel = 'Function';
      else if (captureMap['definition.class']) nodeLabel = 'Class';
      else if (captureMap['definition.interface']) nodeLabel = 'Interface';
      else if (captureMap['definition.method']) nodeLabel = 'Method';
      else if (captureMap['definition.struct']) nodeLabel = 'Struct';
      else if (captureMap['definition.enum']) nodeLabel = 'Enum';
      else if (captureMap['definition.namespace']) nodeLabel = 'Namespace';
      else if (captureMap['definition.module']) nodeLabel = 'Module';
      else if (captureMap['definition.trait']) nodeLabel = 'Trait';
      else if (captureMap['definition.impl']) nodeLabel = 'Impl';
      else if (captureMap['definition.type']) nodeLabel = 'TypeAlias';
      else if (captureMap['definition.const']) nodeLabel = 'Const';
      else if (captureMap['definition.static']) nodeLabel = 'Static';
      else if (captureMap['definition.typedef']) nodeLabel = 'Typedef';
      else if (captureMap['definition.macro']) nodeLabel = 'Macro';
      else if (captureMap['definition.union']) nodeLabel = 'Union';
      else if (captureMap['definition.property']) nodeLabel = 'Property';
      else if (captureMap['definition.record']) nodeLabel = 'Record';
      else if (captureMap['definition.delegate']) nodeLabel = 'Delegate';
      else if (captureMap['definition.annotation']) nodeLabel = 'Annotation';
      else if (captureMap['definition.constructor']) nodeLabel = 'Constructor';
      else if (captureMap['definition.template']) nodeLabel = 'Template';

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
        const tc = typeConfigs[language as keyof typeof typeConfigs];
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
          isExported: isNodeExported(nameNode || definitionNodeForRange, nodeName, language),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
          ...(methodSig ? {
            parameterCount: methodSig.parameterCount,
            returnType: methodSig.returnType,
          } : {}),
        },
      };

      graph.addNode(node);

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? findEnclosingClassId(nameNode || definitionNodeForRange, file.path) : null;

      symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
        parameterCount: methodSig?.parameterCount,
        returnType: methodSig?.returnType,
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

      // ── HAS_METHOD: link method/constructor/property to enclosing class ──
      if (enclosingClassId) {
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: 'HAS_METHOD',
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
