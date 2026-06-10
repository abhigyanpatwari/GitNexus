import { KnowledgeGraph, GraphNode, GraphRelationship, type NodeLabel } from '../graph/types.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage, isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable } from './symbol-table.js';
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { getDefinitionNodeFromCaptures, findEnclosingClassId, extractMethodSignature, getLabelFromCaptures, CLASS_CONTAINER_TYPES, type SyntaxNode } from './utils/ast-helpers.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { buildTypeEnv } from './type-env.js';
import type { FieldInfo, FieldExtractorContext } from './field-types.js';
import type { LanguageProvider } from './language-provider.js';
import { WorkerPool } from './workers/worker-pool.js';
import type { ParseWorkerResult, ParseWorkerInput, ExtractedImport, ExtractedCall, ExtractedAssignment, ExtractedHeritage, ExtractedRoute, ExtractedFetchCall, ExtractedDecoratorRoute, ExtractedToolDef, FileConstructorBindings, FileTypeEnvBindings, ExtractedORMQuery, ExtractedExpoNav } from './workers/parse-worker.js';
import { extractClassFields, extractMethodParameterAnnotations, extractORMQueries } from './workers/parse-worker.js';
import { extractExpressRoutes } from './route-extractors/express.js';
import { extractFastApiRoutes } from './route-extractors/python.js';
import { extractGinRoutes } from './route-extractors/go.js';
import { extractAngularRoutes, isAngularFile } from './route-extractors/angular.js';
import { extractSpringRoutes, collectFileConstants, buildSpringClassRegistry, extractInheritedSpringRoutes } from './workers/spring-route-extractor.js';
import { extractLaravelRoutes } from './workers/parse-worker.js';
import { extractAngularMetadata } from './extractors/angular-metadata.js';
import { extractAngularCalls } from './extractors/angular-calls.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from './constants.js';
import { isVerboseIngestionEnabled } from './utils/verbose.js';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

export interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  expoNavCalls: ExtractedExpoNav[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  constructorBindings: FileConstructorBindings[];
  typeEnvBindings: FileTypeEnvBindings[];
  angularMetadata: import('./workers/parse-worker.js').ExtractedAngularEdge[];
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

  if (parseableFiles.length === 0) return { imports: [], calls: [], assignments: [], heritage: [], routes: [], fetchCalls: [], expoNavCalls: [], decoratorRoutes: [], toolDefs: [], ormQueries: [], constructorBindings: [], typeEnvBindings: [], angularMetadata: [] };

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
  const allExpoNavCalls: ExtractedExpoNav[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const allConstructorBindings: FileConstructorBindings[] = [];
  const allTypeEnvBindings: FileTypeEnvBindings[] = [];
  const allAngularMetadata: import('./workers/parse-worker.js').ExtractedAngularEdge[] = [];
  let symbolCount = 0;
  let fileCount = 0;
  for (const result of chunkResults) {
    fileCount++;
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
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type as NodeLabel, {
        parameterCount: sym.parameterCount,
        requiredParameterCount: sym.requiredParameterCount,
        parameterTypes: sym.parameterTypes,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        ownerId: sym.ownerId,
      });
      symbolCount++;
    }

    allImports.push(...result.imports);
    allCalls.push(...result.calls);
    if (result.assignments) allAssignments.push(...result.assignments);
    allHeritage.push(...result.heritage);
    allRoutes.push(...result.routes);
    if (result.fetchCalls) allFetchCalls.push(...result.fetchCalls);
    if (result.expoNavCalls) allExpoNavCalls.push(...result.expoNavCalls);
    if (result.decoratorRoutes) allDecoratorRoutes.push(...result.decoratorRoutes);
    if (result.toolDefs) allToolDefs.push(...result.toolDefs);
    if (result.ormQueries) allORMQueries.push(...result.ormQueries);
    allConstructorBindings.push(...result.constructorBindings);
    if (result.typeEnvBindings) allTypeEnvBindings.push(...result.typeEnvBindings);
    if (result.angularMetadata) allAngularMetadata.push(...result.angularMetadata);
  }

  // Count nodes by label
  const nodesByLabel: Record<string, number> = {};
  for (const result of chunkResults) {
    for (const node of result.nodes) {
      nodesByLabel[node.label] = (nodesByLabel[node.label] || 0) + 1;
    }
  }
  
  if (isVerboseIngestionEnabled()) {
    console.debug(`[route-parse] Added ${symbolCount} symbols to symbol table`);
    console.debug(`[route-parse] Extracted ${allRoutes.length} routes from ${fileCount} files`);
    console.debug(`[route-parse] Nodes by label: ${JSON.stringify(nodesByLabel)}`);
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
  return { imports: allImports, calls: allCalls, assignments: allAssignments, heritage: allHeritage, routes: allRoutes, fetchCalls: allFetchCalls, expoNavCalls: allExpoNavCalls, decoratorRoutes: allDecoratorRoutes, toolDefs: allToolDefs, ormQueries: allORMQueries, constructorBindings: allConstructorBindings, typeEnvBindings: allTypeEnvBindings, angularMetadata: allAngularMetadata };
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

// FieldExtractor cache for sequential path — same pattern as parse-worker.ts
const seqFieldInfoCache = new Map<number, Map<string, FieldInfo>>();

function seqFindEnclosingClassNode(node: any): any | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** Minimal no-op SymbolTable stub for FieldExtractorContext (sequential path has a real
 *  SymbolTable, but it's incomplete at this stage — use the stub for safety). */
const NOOP_SYMBOL_TABLE_SEQ: any = {
  lookupExactAll: () => [],
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
};

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
  onFileProgress?: FileProgressCallback
): Promise<WorkerExtractedData> => {
  const parser = await loadParser();
  const total = files.length;
  const skippedLanguages = new Map<string, number>();

  // Collect extracted data for routes (imports/calls/heritage are processed via direct graph writes)
  const allRoutes: ExtractedRoute[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allExpoNavCalls: ExtractedExpoNav[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allAngularMetadata: import('./workers/parse-worker.js').ExtractedAngularEdge[] = [];
  const allAngularCalls: ExtractedCall[] = []; // #31: Angular CALLS for the sequential path

  // ── Pre-pass: collect all Java file constants and trees for cross-file resolution ──
  const javaConstants = new Map<string, string>();
  const javaFileMap = new Map<string, { content: string; tree: Parser.Tree }>();

  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (language !== SupportedLanguages.Java) continue;

    try {
      await loadLanguage(language, file.path);
    } catch {
      continue;
    }

    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    let tree;
    try {
      tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
    } catch {
      continue;
    }

    javaFileMap.set(file.path, { content: file.content, tree });
    const fileConstants = collectFileConstants(tree.rootNode);
    for (const [k, v] of fileConstants) {
      if (!javaConstants.has(k)) javaConstants.set(k, v);
    }
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Reset memoization before each new file (node refs are per-tree)
    classIdCache.clear();
    exportCache.clear();
    seqFieldInfoCache.clear();

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

    // For Java files already parsed in pre-pass, reuse the tree
    const isJavaFile = language === SupportedLanguages.Java && javaFileMap.has(file.path);
    let tree: Parser.Tree;

    // Always ensure parser has correct language loaded (critical for query creation)
    try {
      await loadLanguage(language, file.path);
    } catch {
      continue;  // parser unavailable — safety net
    }

    if (isJavaFile) {
      tree = javaFileMap.get(file.path)!.tree;
      astCache.set(file.path, tree);
    } else {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (parseError) {
        console.warn(`Skipping unparseable file: ${file.path}`);
        continue;
      }

      astCache.set(file.path, tree);
    }

    // Extract Laravel routes from route files
    if (language === SupportedLanguages.PHP && (file.path.includes('/routes/') || file.path.startsWith('routes/')) && file.path.endsWith('.php')) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      allRoutes.push(...extractedRoutes);
    }

    // Extract Spring routes from Java controller files
    if (language === SupportedLanguages.Java && (file.content.includes('@Controller') || file.content.includes('@RestController'))) {
      const springRoutes = extractSpringRoutes(tree, file.path, javaConstants);
      if (isVerboseIngestionEnabled()) {
        console.debug(`[route-seq] Extracted ${springRoutes.length} Spring routes from ${file.path}`);
      }
      allRoutes.push(...springRoutes);
    }

    // Extract Express/Hono routes from JS/TS files
    if (language === SupportedLanguages.JavaScript || language === SupportedLanguages.TypeScript) {
      const expressRoutes = extractExpressRoutes(tree, file.path);
      if (expressRoutes.length > 0) {
        allDecoratorRoutes.push(...expressRoutes);
      }
    }

    // Extract FastAPI (#79, #5) and Gin (#80, #6) routes.
    //
    // These frameworks register routes on a local app/router VARIABLE
    // (`app.get(...)`, `r.GET(...)`) rather than a controller CLASS, so they
    // flow through the decorator-route path (processDecoratorRoutesWithRepoId)
    // which builds Route nodes directly — NOT processRoutesFromExtracted, whose
    // controller-class resolution is Spring-specific and silently drops these.
    // The real handler function name is carried via handlerName.
    //
    // This also gives the active sequential path parity with the (large-repo
    // only) worker pool, where #146 originally wired these extractors.
    if (language === SupportedLanguages.Python) {
      for (const r of extractFastApiRoutes(tree, file.path)) {
        allDecoratorRoutes.push({
          filePath: r.filePath,
          decorator: r.httpMethod,
          path: r.routePath,
          lineNumber: r.lineNumber,
          handlerName: r.methodName ?? undefined,
        });
      }
    }
    if (language === SupportedLanguages.Go) {
      for (const r of extractGinRoutes(tree, file.path)) {
        allDecoratorRoutes.push({
          filePath: r.filePath,
          decorator: r.httpMethod,
          path: r.routePath,
          lineNumber: r.lineNumber,
          handlerName: r.methodName ?? undefined,
        });
      }
    }

    // Extract Angular client-side routes (#7, #43). Angular routes map a path to
    // a component (httpMethod is always GET, there is no server handler method),
    // so like FastAPI/Gin they cannot go through processRoutesFromExtracted
    // (methodName is null → dropped) and instead build Route nodes via the
    // decorator-route path. extractAngularRoutes was previously only wired into
    // the worker pool, so normal Angular repos produced zero Route nodes.
    if (language === SupportedLanguages.TypeScript && isAngularFile(file.path, file.content)) {
      for (const r of extractAngularRoutes(tree, file.path)) {
        allDecoratorRoutes.push({
          filePath: r.filePath,
          decorator: r.httpMethod,
          path: r.routePath,
          lineNumber: r.lineNumber,
          handlerName: r.methodName ?? undefined,
        });
      }
    }

    // Extract Angular @NgModule metadata edges (#32)
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      const angularMetadata = extractAngularMetadata(tree, file.path);
      if (angularMetadata.length > 0) {
        allAngularMetadata.push(...angularMetadata);
      }
    }

    // Extract Angular CALLS edges (#31): DI token -> service, template binding ->
    // component method. extractAngularCalls was previously only wired into the
    // worker-pool path; collect the ExtractedCall records here so they flow to
    // processCallsFromExtracted in the active sequential pipeline path too.
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      for (const ac of extractAngularCalls(tree, file.path)) {
        allAngularCalls.push({
          filePath: ac.filePath,
          calledName: ac.calledName,
          sourceId: ac.sourceId,
          callForm: ac.callForm,
          ...(ac.receiverName !== undefined ? { receiverName: ac.receiverName } : {}),
          ...(ac.receiverTypeName !== undefined ? { receiverTypeName: ac.receiverTypeName } : {}),
        });
      }
    }

    // Extract ORM queries (Prisma and Supabase)
    const extractedORMQueries = extractORMQueries(tree, file.path);
    if (extractedORMQueries.length > 0) {
      allORMQueries.push(...extractedORMQueries);
    }

    const provider = getProvider(language);
    // .tsx files use a different grammar (tree-sitter-tsx) which has JSX
    // node types. Use TSX_QUERIES (which extends TYPESCRIPT_QUERIES) for
    // .tsx files. Issue #107.
    const queryString = (language === SupportedLanguages.TypeScript && file.path.endsWith('.tsx'))
      ? (LANGUAGE_QUERIES[`${language}:tsx`] ?? provider.treeSitterQueries)
      : provider.treeSitterQueries;
    if (!queryString) {
      continue;
    }

    // Extract MCP tool definitions from Python files (@mcp.tool() decorators)
    if (language === SupportedLanguages.Python) {
      try {
        const lang = parser.getLanguage();
        const mcpQuery = new Parser.Query(lang, queryString);
        for (const match of mcpQuery.matches(tree.rootNode)) {
          const captureMap: Record<string, any> = {};
          match.captures.forEach(c => { captureMap[c.name] = c.node; });

          // MCP tool decorators: @mcp.tool()
          if (captureMap['mcp_tool'] && captureMap['mcp_tool.name']) {
            const mcpObj = captureMap['_mcp_obj'];
            const toolMethod = captureMap['_tool_method'];
            if (mcpObj?.text === 'mcp' && toolMethod?.text === 'tool') {
              const funcNameNode = captureMap['mcp_tool.name'];
              const decoratorNode = captureMap['mcp_tool'];
              allToolDefs.push({
                filePath: file.path,
                name: funcNameNode.text,
                lineNumber: decoratorNode.startPosition.row,
              });
            }
          }
        }
      } catch { /* no mcp tools in this file */ }
    }

    // Extract Expo Router navigation calls (router.push, router.replace, router.navigate)
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      try {
        const lang = parser.getLanguage();
        const expoNavQuery = new Parser.Query(lang, queryString);
        for (const match of expoNavQuery.matches(tree.rootNode)) {
          const captureMap: Record<string, any> = {};
          match.captures.forEach(c => { captureMap[c.name] = c.node; });
          if (captureMap['expo_nav'] && captureMap['expo_nav.url']) {
            const url = captureMap['expo_nav.url'].text;
            const navMethod = captureMap['expo_nav.method']?.text;
            allExpoNavCalls.push({
              filePath: file.path,
              url,
              method: navMethod?.toUpperCase() ?? 'PUSH',
              sourceId: generateId('File', file.path),
              lineNumber: captureMap['expo_nav'].startPosition.row,
            });
          }
        }
      } catch { /* no expo nav calls in this file */ }
    }

    // Extract fetch() calls and HTTP client calls for API tracking
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      try {
        const lang = parser.getLanguage();
        const fetchQuery = new Parser.Query(lang, queryString);
        for (const match of fetchQuery.matches(tree.rootNode)) {
          const captureMap: Record<string, any> = {};
          match.captures.forEach(c => { captureMap[c.name] = c.node; });

          // Extract fetch() calls: fetch('/api/grants')
          if (captureMap['route.fetch']) {
            const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
            if (urlNode) {
              allFetchCalls.push({
                filePath: file.path,
                url: urlNode.text,
                method: 'GET',
                sourceId: generateId('File', file.path),
                fetchURL: urlNode.text,
                lineNumber: captureMap['route.fetch'].startPosition.row,
              });
            }
          }

          // Extract HTTP client calls (axios.get, $.post, etc.) — consumer, not route definition
          if (captureMap['http_client'] && captureMap['http_client.url']) {
            const method = captureMap['http_client.method']?.text;
            const url = captureMap['http_client.url'].text;
            const EXPRESS_ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'route']);
            if (method && !EXPRESS_ROUTE_METHODS.has(method) && url.startsWith('/')) {
              allFetchCalls.push({
                filePath: file.path,
                url,
                method: method.toUpperCase(),
                sourceId: generateId('File', file.path),
                fetchURL: url,
                lineNumber: captureMap['http_client'].startPosition.row,
              });
            }
          }
        }
      } catch { /* no fetch calls in this file */ }
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
    const typeEnv = provider.fieldExtractor ? buildTypeEnv(tree, language, { enclosingFunctionFinder: provider.enclosingFunctionFinder }) : null;

    // Track method name occurrences per file to generate unique IDs for overloaded methods.
    // Java/Kotlin/C# support method overloading — multiple methods with the same name but different
    // signatures. Without disambiguation, overloaded methods collide on the same node ID and only
    // the first overload survives in the graph.
    const methodNameCounts = new Map<string, number>();

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

      // Generate unique node ID for Method/Constructor nodes, handling method overloading.
      // For overloaded methods (same name, different parameters), append a 0-based index suffix
      // to distinguish them. Overload 0 keeps the original format for backward compatibility.
      let nodeId: string;
      if (nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const nameKey = `${file.path}:${nodeName}`;
        const overloadIndex = methodNameCounts.get(nameKey) ?? 0;
        methodNameCounts.set(nameKey, overloadIndex + 1);
        nodeId = overloadIndex > 0
          ? `${generateId(nodeLabel, `${file.path}:${nodeName}`)}:${overloadIndex}`
          : generateId(nodeLabel, `${file.path}:${nodeName}`);
      } else {
        nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);
      }

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

      // ── Field extraction for DTO/Entity classes ──
      let fields: string | undefined;
      if (nodeLabel === 'Class' && definitionNode) {
        const classFields = extractClassFields(definitionNode, language);
        if (classFields.length > 0) {
          fields = JSON.stringify(classFields);
        }
      }

      // ── Parameter annotation extraction for Java/Kotlin methods ──
      let parameterAnnotations: string | undefined;
      if ((language === 'java' || language === 'kotlin') &&
          (nodeLabel === 'Method' || nodeLabel === 'Constructor') &&
          definitionNode) {
        const params = extractMethodParameterAnnotations(definitionNode, language);
        if (params.length > 0) {
          parameterAnnotations = JSON.stringify(params);
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
            ...(methodSig.parameterTypes ? { parameterTypes: JSON.stringify(methodSig.parameterTypes) } : {}),
            returnType: methodSig.returnType,
          } : {}),
          ...(fields ? { fields } : {}),
          ...(parameterAnnotations ? { parameterAnnotations } : {}),
        },
      };

      graph.addNode(node);

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? cachedFindEnclosingClassId(nameNode || definitionNodeForRange, file.path) : null;

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
              typeEnv, symbolTable: NOOP_SYMBOL_TABLE_SEQ, filePath: file.path, language,
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
        // All 14 languages register a FieldExtractor — no fallback needed.
      }

      // Apply field metadata to the graph node retroactively
      if (seqVisibility !== undefined) node.properties.visibility = seqVisibility;
      if (seqIsStatic !== undefined) node.properties.isStatic = seqIsStatic;
      if (seqIsReadonly !== undefined) node.properties.isReadonly = seqIsReadonly;
      if (declaredType !== undefined) node.properties.declaredType = declaredType;

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
          source: 'heuristic',
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

  // WI-90: repo-wide cross-file @RequestMapping inheritance. Build a class
  // registry from the already-parsed Java trees and emit routes for handler
  // methods inherited from a base controller declared in another file. Deduped
  // against routes already produced by the per-file pass.
  if (javaFileMap.size > 0) {
    const springRegistry = buildSpringClassRegistry(
      Array.from(javaFileMap.entries()).map(([filePath, { tree }]) => ({ filePath, tree })),
      javaConstants,
    );
    const inheritedRoutes = extractInheritedSpringRoutes(springRegistry);
    if (inheritedRoutes.length > 0) {
      const seenRouteKeys = new Set(allRoutes.map(r => `${r.filePath}:${r.httpMethod}:${r.routePath}`));
      for (const r of inheritedRoutes) {
        const key = `${r.filePath}:${r.httpMethod}:${r.routePath}`;
        if (!seenRouteKeys.has(key)) {
          seenRouteKeys.add(key);
          allRoutes.push(r);
        }
      }
    }
  }

  return {
    imports: [],
    // #31: Angular DI/template CALLS — the only calls the sequential path emits
    // here (general calls are resolved separately via processCalls re-extraction).
    calls: allAngularCalls,
    assignments: [],
    heritage: [],
    routes: allRoutes,
    fetchCalls: allFetchCalls,
    expoNavCalls: allExpoNavCalls,
    decoratorRoutes: allDecoratorRoutes,
    toolDefs: allToolDefs,
    ormQueries: allORMQueries,
    constructorBindings: [],
    typeEnvBindings: [],
    angularMetadata: allAngularMetadata,
  };
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
): Promise<WorkerExtractedData> => {
  if (workerPool) {
    try {
      return await processParsingWithWorkers(graph, files, symbolTable, astCache, workerPool, onFileProgress);
    } catch (err) {
      console.warn('Worker pool parsing failed, falling back to sequential:', err instanceof Error ? err.message : err);
    }
  }

  // Fallback: sequential parsing
  return processParsingSequential(graph, files, symbolTable, astCache, onFileProgress);
};
