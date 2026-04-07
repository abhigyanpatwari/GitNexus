import type { GraphNode, GraphRelationship, NodeLabel } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage, isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable } from './symbol-table.js';
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { extractVueScript, isVueSetupTopLevel } from './vue-sfc-extractor.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import {
  getDefinitionNodeFromCaptures,
  findEnclosingClassInfo,
  getLabelFromCaptures,
  CLASS_CONTAINER_TYPES,
  type SyntaxNode,
  type EnclosingClassInfo,
} from './utils/ast-helpers.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { buildTypeEnv } from './type-env.js';
import type { FieldInfo, FieldExtractorContext } from './field-types.js';
import type { MethodInfo } from './method-types.js';
import {
  buildMethodProps,
  arityForIdFromInfo,
  typeTagForId,
  constTagForId,
  buildCollisionGroups,
} from './utils/method-props.js';
import type { LanguageProvider } from './language-provider.js';
import { WorkerPool } from './workers/worker-pool.js';
import type {
  ParseWorkerResult,
  ParseWorkerInput,
  ExtractedImport,
  ExtractedCall,
  ExtractedAssignment,
  ExtractedHeritage,
  ExtractedRoute,
  ExtractedFetchCall,
  ExtractedDecoratorRoute,
  ExtractedToolDef,
  FileConstructorBindings,
  FileTypeEnvBindings,
  ExtractedORMQuery,
} from './workers/parse-worker.js';
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
  ormQueries: ExtractedORMQuery[];
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

  if (parseableFiles.length === 0)
    return {
      imports: [],
      calls: [],
      assignments: [],
      heritage: [],
      routes: [],
      fetchCalls: [],
      decoratorRoutes: [],
      toolDefs: [],
      ormQueries: [],
      constructorBindings: [],
      typeEnvBindings: [],
    };

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
  const allORMQueries: ExtractedORMQuery[] = [];
  const allConstructorBindings: FileConstructorBindings[] = [];
  const allTypeEnvBindings: FileTypeEnvBindings[] = [];
  for (const result of chunkResults) {
    for (const node of result.nodes) {
      graph.addNode({
        id: node.id,
        label: node.label as NodeLabel,
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

    for (const _item of result.imports) allImports.push(_item);
    for (const _item of result.calls) allCalls.push(_item);
    for (const _item of result.assignments) allAssignments.push(_item);
    for (const _item of result.heritage) allHeritage.push(_item);
    for (const _item of result.routes) allRoutes.push(_item);
    for (const _item of result.fetchCalls) allFetchCalls.push(_item);
    for (const _item of result.decoratorRoutes) allDecoratorRoutes.push(_item);
    for (const _item of result.toolDefs) allToolDefs.push(_item);
    if (result.ormQueries) for (const _item of result.ormQueries) allORMQueries.push(_item);
    for (const _item of result.constructorBindings) allConstructorBindings.push(_item);
    for (const _item of result.typeEnvBindings) allTypeEnvBindings.push(_item);
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
  return {
    imports: allImports,
    calls: allCalls,
    assignments: allAssignments,
    heritage: allHeritage,
    routes: allRoutes,
    fetchCalls: allFetchCalls,
    decoratorRoutes: allDecoratorRoutes,
    toolDefs: allToolDefs,
    ormQueries: allORMQueries,
    constructorBindings: allConstructorBindings,
    typeEnvBindings: allTypeEnvBindings,
  };
};

// ============================================================================
// Sequential fallback (original implementation)
// ============================================================================

// Inline caches to avoid repeated parent-walks per node (same pattern as parse-worker.ts).
// Keyed by tree-sitter node reference — cleared at the start of each file.
const classInfoCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const exportCache = new Map<SyntaxNode, boolean>();

const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
): EnclosingClassInfo | null => {
  const cached = classInfoCache.get(node);
  if (cached !== undefined) return cached;
  const result = findEnclosingClassInfo(node, filePath);
  classInfoCache.set(node, result);
  return result;
};

const cachedExportCheck = (
  checker: (node: SyntaxNode, name: string) => boolean,
  node: SyntaxNode,
  name: string,
): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;
  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

// FieldExtractor cache for sequential path — same pattern as parse-worker.ts
const seqFieldInfoCache = new Map<number, Map<string, FieldInfo>>();

// MethodExtractor cache for sequential path — avoids re-traversing the same class
// body once per method. Keyed on classNode.id (tree-sitter node identity number).
const seqMethodExtractCache = new Map<
  number,
  { ownerName: string | undefined; methods: MethodInfo[] } | null
>();
// Derived method map + collision groups cache — avoids rebuilding per method.
const seqMethodMapCache = new Map<
  number,
  { map: Map<string, MethodInfo>; groups: Map<string, MethodInfo[]> }
>();

function seqFindEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** Minimal no-op SymbolTable stub for FieldExtractorContext (sequential path has a real
 *  SymbolTable, but it's incomplete at this stage — use the stub for safety). */
const NOOP_SYMBOL_TABLE_SEQ = {
  lookupExactAll: () => [],
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
} as unknown as SymbolTable;

function seqGetFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;
  const cacheKey = classNode.startIndex;
  let cached = seqFieldInfoCache.get(cacheKey);
  if (cached) return cached;
  const extracted = provider.fieldExtractor.extract(classNode, context);
  if (!extracted?.fields?.length) return undefined;
  cached = new Map<string, FieldInfo>();
  for (const field of extracted.fields) cached.set(field.name, field);
  seqFieldInfoCache.set(cacheKey, cached);
  return cached;
}

const processParsingSequential = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback,
) => {
  const parser = await loadParser();
  const total = files.length;
  const skippedLanguages = new Map<string, number>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Reset memoization before each new file (node refs are per-tree)
    classInfoCache.clear();
    exportCache.clear();
    seqFieldInfoCache.clear();
    seqMethodExtractCache.clear();
    seqMethodMapCache.clear();

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

    // Vue SFC preprocessing: extract <script> block content
    let parseContent = file.content;
    let lineOffset = 0;
    let isVueSetup = false;
    if (language === SupportedLanguages.Vue) {
      const extracted = extractVueScript(file.content);
      if (!extracted) continue; // skip .vue files with no script block
      parseContent = extracted.scriptContent;
      lineOffset = extracted.lineOffset;
      isVueSetup = extracted.isSetup;
    }

    try {
      await loadLanguage(language, file.path);
    } catch {
      continue; // parser unavailable — safety net
    }

    let tree;
    try {
      tree = parser.parse(parseContent, undefined, {
        bufferSize: getTreeSitterBufferSize(parseContent.length),
      });
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

    // Build per-file type environment for FieldExtractor context (lightweight — skipped if no fieldExtractor)
    const typeEnv = provider.fieldExtractor
      ? buildTypeEnv(tree, language, {
          enclosingFunctionFinder: provider.enclosingFunctionFinder,
          extractFunctionName: provider.methodExtractor?.extractFunctionName,
        })
      : null;

    matches.forEach((match) => {
      const captureMap: Record<string, SyntaxNode> = {};

      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      const nodeLabel = getLabelFromCaptures(captureMap, provider);
      if (!nodeLabel) return;

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') return;
      const nodeName = nameNode ? nameNode.text : 'init';

      const definitionNodeForRange = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNodeForRange
        ? definitionNodeForRange.startPosition.row + lineOffset
        : nameNode
          ? nameNode.startPosition.row + lineOffset
          : lineOffset;
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);

      // Compute enclosing class BEFORE node ID — needed to qualify method IDs
      const needsOwner =
        nodeLabel === 'Method' ||
        nodeLabel === 'Constructor' ||
        nodeLabel === 'Property' ||
        nodeLabel === 'Function';
      const enclosingClassInfo = needsOwner
        ? cachedFindEnclosingClassInfo(nameNode || definitionNodeForRange, file.path)
        : null;
      const enclosingClassId = enclosingClassInfo?.classId ?? null;

      // Qualify method/property IDs with enclosing class name to avoid collisions
      // e.g. "Method:animal.dart:Animal.speak" vs "Method:animal.dart:Dog.speak"
      const qualifiedName = enclosingClassInfo
        ? `${enclosingClassInfo.className}.${nodeName}`
        : nodeName;

      // Extract method metadata for Function/Method/Constructor nodes BEFORE generating
      // the node ID — parameterCount is needed to disambiguate overloaded methods.
      // Use the per-language MethodExtractor for method metadata (isAbstract, isStatic,
      // visibility, annotations, parameterCount, parameterTypes, returnType, etc.).
      const isMethodLike =
        nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor';
      let methodProps: Record<string, unknown> = {};
      let arityForId: number | undefined; // raw param count for ID, even for variadic
      let seqDefMethodInfo: MethodInfo | undefined;
      let seqDefMethods: MethodInfo[] | undefined;
      let seqClassNodeId: number | undefined;
      if (isMethodLike && definitionNode) {
        let enriched = false;

        if (provider.methodExtractor) {
          // Try class-based extraction (method inside a class/struct/trait body)
          const classNode = seqFindEnclosingClassNode(definitionNode);
          if (classNode) {
            // Cache extract() results per class node to avoid re-traversing the
            // same class body for every method it contains (O(N) -> O(1) per hit).
            let result:
              | { ownerName: string | undefined; methods: MethodInfo[] }
              | null
              | undefined = seqMethodExtractCache.get(classNode.id);
            if (result === undefined) {
              result =
                provider.methodExtractor.extract(classNode, {
                  filePath: file.path,
                  language,
                }) ?? null;
              seqMethodExtractCache.set(classNode.id, result);
            }
            if (result?.methods?.length) {
              const defLine = definitionNode.startPosition.row + 1;
              const info = result.methods.find((m) => m.name === nodeName && m.line === defLine);
              if (info) {
                enriched = true;
                arityForId = arityForIdFromInfo(info);
                methodProps = buildMethodProps(info);
                seqDefMethodInfo = info;
                seqDefMethods = result.methods;
                seqClassNodeId = classNode.id;
              }
            }
          }

          // For top-level methods (e.g. Go method_declaration), try extractFromNode
          if (!enriched && provider.methodExtractor.extractFromNode) {
            const info = provider.methodExtractor.extractFromNode(definitionNode, {
              filePath: file.path,
              language,
            });
            if (info) {
              enriched = true;
              arityForId = arityForIdFromInfo(info);
              methodProps = buildMethodProps(info);
            }
          }
        }
      }

      // Append #<paramCount> to Method/Constructor IDs to disambiguate overloads.
      // Functions are not suffixed — they don't overload by name in the same scope.
      // When same-arity collisions exist, append ~type1,type2 for further disambiguation.
      const needsAritySuffix = nodeLabel === 'Method' || nodeLabel === 'Constructor';
      let arityTag = needsAritySuffix && arityForId !== undefined ? `#${arityForId}` : '';
      if (arityTag && seqDefMethods && seqDefMethodInfo && seqClassNodeId !== undefined) {
        // Use cached method map + collision groups (built once per class, not per method)
        let cached = seqMethodMapCache.get(seqClassNodeId);
        if (!cached) {
          const tempMap = new Map<string, MethodInfo>();
          for (const m of seqDefMethods) tempMap.set(`${m.name}:${m.line}`, m);
          cached = { map: tempMap, groups: buildCollisionGroups(tempMap) };
          seqMethodMapCache.set(seqClassNodeId, cached);
        }
        arityTag += typeTagForId(
          cached.map,
          nodeName,
          arityForId,
          seqDefMethodInfo,
          language,
          cached.groups,
        );
        arityTag += constTagForId(
          cached.map,
          nodeName,
          arityForId,
          seqDefMethodInfo,
          cached.groups,
        );
      }
      const nodeId = generateId(nodeLabel, `${file.path}:${qualifiedName}${arityTag}`);
      const frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      const node: GraphNode = {
        id: nodeId,
        label: nodeLabel as NodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNodeForRange
            ? definitionNodeForRange.startPosition.row + lineOffset
            : startLine,
          endLine: definitionNodeForRange
            ? definitionNodeForRange.endPosition.row + lineOffset
            : startLine,
          language: language,
          isExported:
            language === SupportedLanguages.Vue && isVueSetup
              ? isVueSetupTopLevel(nameNode || definitionNodeForRange)
              : cachedExportCheck(
                  provider.exportChecker,
                  nameNode || definitionNodeForRange,
                  nodeName,
                ),
          ...(frameworkHint
            ? {
                astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
                astFrameworkReason: frameworkHint.reason,
              }
            : {}),
          ...methodProps,
        },
      };

      graph.addNode(node);

      // enclosingClassId already computed above (before nodeId generation)

      // Extract declared type and field metadata for Property nodes
      let declaredType: string | undefined;
      let seqVisibility: string | undefined;
      let seqIsStatic: boolean | undefined;
      let seqIsReadonly: boolean | undefined;
      if (nodeLabel === 'Property' && definitionNode) {
        // FieldExtractor is the single source of truth when available
        if (provider.fieldExtractor && typeEnv) {
          const classNode = seqFindEnclosingClassNode(definitionNode);
          if (classNode) {
            const fieldMap = seqGetFieldInfo(classNode, provider, {
              typeEnv,
              symbolTable: NOOP_SYMBOL_TABLE_SEQ,
              filePath: file.path,
              language,
            });
            const info = fieldMap?.get(nodeName);
            if (info) {
              declaredType = info.type ?? undefined;
              seqVisibility = info.visibility;
              seqIsStatic = info.isStatic;
              seqIsReadonly = info.isReadonly;
            }
          }
        }
        // All 15 tree-sitter languages register a FieldExtractor — no fallback needed.
      }

      // Apply field metadata to the graph node retroactively
      if (seqVisibility !== undefined) node.properties.visibility = seqVisibility;
      if (seqIsStatic !== undefined) node.properties.isStatic = seqIsStatic;
      if (seqIsReadonly !== undefined) node.properties.isReadonly = seqIsReadonly;
      if (declaredType !== undefined) node.properties.declaredType = declaredType;

      symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
        parameterCount: methodProps.parameterCount as number | undefined,
        requiredParameterCount: methodProps.requiredParameterCount as number | undefined,
        parameterTypes: methodProps.parameterTypes as string[] | undefined,
        returnType: methodProps.returnType as string | undefined,
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
      return await processParsingWithWorkers(
        graph,
        files,
        symbolTable,
        astCache,
        workerPool,
        onFileProgress,
      );
    } catch (err) {
      console.warn(
        'Worker pool parsing failed, falling back to sequential:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Fallback: sequential parsing (no pre-extracted data)
  await processParsingSequential(graph, files, symbolTable, astCache, onFileProgress);
  return null;
};
