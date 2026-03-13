import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition, SymbolTable } from './symbol-table.js';
import { ImportMap, PackageMap, NamedImportMap, isFileInPackageDir } from './import-processor.js';
import { resolveSymbolInternal } from './symbol-resolver.js';
import { walkBindingChain } from './named-binding-extraction.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import {
  getLanguageFromFilename,
  isVerboseIngestionEnabled,
  yieldToEventLoop,
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  isBuiltInOrNoise,
  countCallArguments,
  inferCallForm,
  extractReceiverName,
} from './utils.js';
import { buildTypeEnv, lookupTypeEnv } from './type-env.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedCall, ExtractedHeritage, ExtractedRoute } from './workers/parse-worker.js';
import { routeRubyCall } from './ruby-call-routing.js';

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
const findEnclosingFunction = (
  node: any,
  filePath: string,
  symbolTable: SymbolTable
): string | null => {
  let current = node.parent;

  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);

      if (funcName) {
        const nodeId = symbolTable.lookupExact(filePath, funcName);
        if (nodeId) return nodeId;

        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }

  return null;
};

export const processCalls = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  onProgress?: (current: number, total: number) => void,
  namedImportMap?: NamedImportMap,
): Promise<ExtractedHeritage[]> => {
  const parser = await loadParser();
  const collectedHeritage: ExtractedHeritage[] = [];
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support first
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) {
      if (skippedByLang) {
        skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
      }
      continue;
    }

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);
    let wasReparsed = false;

    if (!tree) {
      // Cache Miss: Re-parse
      // Use larger bufferSize for files > 32KB
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      wasReparsed = true;
      // Cache re-parsed tree so heritage phase gets hits
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    // Build per-file TypeEnv for receiver resolution
    const lang = getLanguageFromFilename(file.path);
    const typeEnv = lang ? buildTypeEnv(tree, lang) : new Map();

    // 3. Process each call match
    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      // Only process @call captures
      if (!captureMap['call']) return;

      const nameNode = captureMap['call.name'];
      if (!nameNode) return;

      const calledName = nameNode.text;

      // Ruby: route special calls to heritage or properties (imports handled by import-processor)
      if (language === SupportedLanguages.Ruby) {
        const callNode = captureMap['call'];
        const routed = routeRubyCall(calledName, callNode);

        switch (routed.kind) {
          case 'skip':
          case 'import': // handled by import-processor
            return;

          case 'heritage':
            for (const item of routed.items) {
              collectedHeritage.push({
                filePath: file.path,
                className: item.enclosingClass,
                parentName: item.mixinName,
                kind: 'trait-impl',
              });
            }
            return;

          case 'properties': {
            const fileId = generateId('File', file.path);
            for (const item of routed.items) {
              const nodeId = generateId('Property', `${file.path}:${item.propName}`);
              graph.addNode({
                id: nodeId,
                label: 'Property' as any, // TODO: add 'Property' to graph node label union
                properties: {
                  name: item.propName, filePath: file.path,
                  startLine: item.startLine, endLine: item.endLine,
                  language: SupportedLanguages.Ruby, isExported: true,
                  description: item.accessorType,
                },
              });
              symbolTable.add(file.path, item.propName, nodeId, 'Property');
              const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
              graph.addRelationship({
                id: relId, sourceId: fileId, targetId: nodeId,
                type: 'DEFINES', confidence: 1.0, reason: '',
              });
            }
            return;
          }

          case 'call':
            break; // fall through to normal call processing below
        }
      }

      // Skip common built-ins and noise
      if (isBuiltInOrNoise(calledName)) return;

      const callNode = captureMap['call'];
      const callForm = inferCallForm(callNode, nameNode);
      const receiverName = callForm === 'member' ? extractReceiverName(nameNode) : undefined;
      const receiverTypeName = receiverName ? lookupTypeEnv(typeEnv, receiverName, callNode) : undefined;

      // 4. Resolve the target using priority strategy (returns confidence)
      const resolved = resolveCallTarget({
        calledName,
        argCount: countCallArguments(callNode),
        callForm,
        receiverTypeName,
      }, file.path, symbolTable, importMap, packageMap, namedImportMap);

      if (!resolved) return;

      // 5. Find the enclosing function (caller)
      const enclosingFuncId = findEnclosingFunction(callNode, file.path, symbolTable);

      // Use enclosing function as source, fallback to file for top-level calls
      const sourceId = enclosingFuncId || generateId('File', file.path);

      const relId = generateId('CALLS', `${sourceId}:${calledName}->${resolved.nodeId}`);

      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in call processing — ${lang} parser not available.`
      );
    }
  }

  return collectedHeritage;
};

/**
 * Resolution result with confidence scoring
 */
interface ResolveResult {
  nodeId: string;
  confidence: number;  // 0-1: how sure are we?
  reason: string;      // 'import-resolved' | 'same-file' | 'unique-global'
}

type ResolutionTier = 'same-file' | 'import-scoped' | 'unique-global';

interface TieredCandidates {
  candidates: SymbolDefinition[];
  tier: ResolutionTier;
}

const CALLABLE_SYMBOL_TYPES = new Set([
  'Function',
  'Method',
  'Constructor',
  'Macro',
  'Delegate',
]);

const collectTieredCandidates = (
  calledName: string,
  currentFile: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
): TieredCandidates | null => {
  const allDefs = symbolTable.lookupFuzzy(calledName);

  // Tier 1: Same-file — highest priority, prevents imports from shadowing local defs
  // (matches resolveSymbolInternal which checks lookupExactFull before named bindings)
  const localDefs = allDefs.filter(def => def.filePath === currentFile);
  if (localDefs.length > 0) {
    return { candidates: localDefs, tier: 'same-file' };
  }

  // Tier 2a-named: Check named bindings with re-export chain following.
  // Aliased imports (import { User as U }) mean lookupFuzzy('U') returns
  // empty but we can resolve via the exported name.
  // Re-exports (export { User } from './base') are followed up to 5 hops.
  if (namedImportMap) {
    const chainResult = resolveNamedBindingChainForCandidates(
      calledName, currentFile, symbolTable, namedImportMap, allDefs,
    );
    if (chainResult) return chainResult;
  }

  if (allDefs.length === 0) return null;

  const importedFiles = importMap.get(currentFile);
  if (importedFiles) {
    const importedDefs = allDefs.filter(def => importedFiles.has(def.filePath));
    if (importedDefs.length > 0) {
      return { candidates: importedDefs, tier: 'import-scoped' };
    }
  }

  const importedPackages = packageMap?.get(currentFile);
  if (importedPackages) {
    const packageDefs = allDefs.filter(def => {
      for (const dirSuffix of importedPackages) {
        if (isFileInPackageDir(def.filePath, dirSuffix)) return true;
      }
      return false;
    });
    if (packageDefs.length > 0) {
      return { candidates: packageDefs, tier: 'import-scoped' };
    }
  }

  // Tier 3: Global — pass all candidates through; filterCallableCandidates
  // will narrow by kind/arity and resolveCallTarget only emits when exactly 1 remains.
  return { candidates: allDefs, tier: 'unique-global' };
};

const CONSTRUCTOR_TARGET_TYPES = new Set(['Constructor', 'Class', 'Struct', 'Record']);

const filterCallableCandidates = (
  candidates: SymbolDefinition[],
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
): SymbolDefinition[] => {
  let kindFiltered: SymbolDefinition[];

  if (callForm === 'constructor') {
    // For constructor calls, prefer Constructor > Class/Struct/Record > callable fallback
    const constructors = candidates.filter(c => c.type === 'Constructor');
    if (constructors.length > 0) {
      kindFiltered = constructors;
    } else {
      const types = candidates.filter(c => CONSTRUCTOR_TARGET_TYPES.has(c.type));
      kindFiltered = types.length > 0 ? types : candidates.filter(c => CALLABLE_SYMBOL_TYPES.has(c.type));
    }
  } else {
    kindFiltered = candidates.filter(c => CALLABLE_SYMBOL_TYPES.has(c.type));
  }

  if (kindFiltered.length === 0) return [];
  if (argCount === undefined) return kindFiltered;

  const hasParameterMetadata = kindFiltered.some(candidate => candidate.parameterCount !== undefined);
  if (!hasParameterMetadata) return kindFiltered;

  return kindFiltered.filter(candidate =>
    candidate.parameterCount === undefined || candidate.parameterCount === argCount
  );
};

const toResolveResult = (
  definition: SymbolDefinition,
  tier: ResolutionTier,
): ResolveResult => {
  if (tier === 'same-file') {
    return { nodeId: definition.nodeId, confidence: 0.95, reason: 'same-file' };
  }
  if (tier === 'import-scoped') {
    return { nodeId: definition.nodeId, confidence: 0.9, reason: 'import-resolved' };
  }
  return { nodeId: definition.nodeId, confidence: 0.5, reason: 'unique-global' };
};

/**
 * Resolve a function call to its target node ID using priority strategy:
 * A. Narrow candidates by scope tier (same-file, import-scoped, unique-global)
 * B. Filter to callable symbol kinds (constructor-aware when callForm is set)
 * C. Apply arity filtering when parameter metadata is available
 * D. Apply receiver-type filtering for member calls with typed receivers
 *
 * If filtering still leaves multiple candidates, refuse to emit a CALLS edge.
 */
const resolveCallTarget = (
  call: Pick<ExtractedCall, 'calledName' | 'argCount' | 'callForm' | 'receiverTypeName'>,
  currentFile: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
): ResolveResult | null => {
  const tiered = collectTieredCandidates(call.calledName, currentFile, symbolTable, importMap, packageMap, namedImportMap);
  if (!tiered) return null;

  const filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, call.callForm);

  // D. Receiver-type filtering: for member calls with a known receiver type,
  // filter candidates by ownerId matching the resolved type's nodeId
  if (call.callForm === 'member' && call.receiverTypeName && filteredCandidates.length > 1) {
    const typeDefs = symbolTable.lookupFuzzy(call.receiverTypeName);
    if (typeDefs.length > 0) {
      const typeNodeIds = new Set(typeDefs.map(d => d.nodeId));
      const ownerFiltered = filteredCandidates.filter(c => c.ownerId && typeNodeIds.has(c.ownerId));
      if (ownerFiltered.length === 1) {
        return toResolveResult(ownerFiltered[0], tiered.tier);
      }
      // If receiver filtering narrows to 0, fall through to name-only resolution
      // If still 2+, refuse (don't guess)
      if (ownerFiltered.length > 1) return null;
    }
  }

  if (filteredCandidates.length !== 1) return null;

  return toResolveResult(filteredCandidates[0], tiered.tier);
};

/**
 * Fast path: resolve pre-extracted call sites from workers.
 * No AST parsing — workers already extracted calledName + sourceId.
 * This function only does symbol table lookups + graph mutations.
 */
export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  onProgress?: (current: number, total: number) => void,
  namedImportMap?: NamedImportMap,
) => {
  // Group by file for progress reporting
  const byFile = new Map<string, ExtractedCall[]>();
  for (const call of extractedCalls) {
    let list = byFile.get(call.filePath);
    if (!list) {
      list = [];
      byFile.set(call.filePath, list);
    }
    list.push(call);
  }

  const totalFiles = byFile.size;
  let filesProcessed = 0;

  for (const [_filePath, calls] of byFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    for (const call of calls) {
      const resolved = resolveCallTarget(
        call,
        call.filePath,
        symbolTable,
        importMap,
        packageMap,
        namedImportMap,
      );
      if (!resolved) continue;

      const relId = generateId('CALLS', `${call.sourceId}:${call.calledName}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: call.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    }
  }

  onProgress?.(totalFiles, totalFiles);
};

/**
 * Resolve pre-extracted Laravel routes to CALLS edges from route files to controller methods.
 */
export const processRoutesFromExtracted = async (
  graph: KnowledgeGraph,
  extractedRoutes: ExtractedRoute[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  onProgress?: (current: number, total: number) => void
) => {
  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    // Resolve controller class using shared resolver (Tier 1: same file,
    // Tier 2: import-scoped, Tier 3: unique global).
    const resolution = resolveSymbolInternal(route.controllerName, route.filePath, symbolTable, importMap, packageMap);
    if (!resolution) continue;

    const controllerDef = resolution.definition;
    // Derive confidence from the resolution tier
    const confidence = resolution.tier === 'same-file' ? 0.95
      : resolution.tier === 'import-scoped' ? 0.9
      : 0.7;

    // Find the method on the controller
    const methodId = symbolTable.lookupExact(controllerDef.filePath, route.methodName);
    const sourceId = generateId('File', route.filePath);

    if (!methodId) {
      // Construct method ID manually
      const guessedId = generateId('Method', `${controllerDef.filePath}:${route.methodName}`);
      const relId = generateId('CALLS', `${sourceId}:route->${guessedId}`);
      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: guessedId,
        type: 'CALLS',
        confidence: confidence * 0.8,
        reason: 'laravel-route',
      });
      continue;
    }

    const relId = generateId('CALLS', `${sourceId}:route->${methodId}`);
    graph.addRelationship({
      id: relId,
      sourceId,
      targetId: methodId,
      type: 'CALLS',
      confidence,
      reason: 'laravel-route',
    });
  }

  onProgress?.(extractedRoutes.length, extractedRoutes.length);
};

/**
 * Follow re-export chains through NamedImportMap for call candidate collection.
 * Delegates chain-walking to the shared walkBindingChain utility, then
 * applies call-processor semantics: any number of matches accepted.
 */
const resolveNamedBindingChainForCandidates = (
  calledName: string,
  currentFile: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): TieredCandidates | null => {
  const defs = walkBindingChain(calledName, currentFile, symbolTable, namedImportMap, allDefs);
  if (defs && defs.length > 0) {
    return { candidates: defs, tier: 'import-scoped' };
  }
  return null;
};
