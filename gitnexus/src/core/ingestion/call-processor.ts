import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition, SymbolTable } from './symbol-table.js';
import Parser from 'tree-sitter';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE, type ResolutionTier } from './resolution-context.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import {
  FUNCTION_NODE_TYPES,
  findEnclosingClassId,
  findEnclosingClassInfo,
  genericFuncName,
  inferFunctionLabel,
} from './utils/ast-helpers.js';
import { typeTagForId, constTagForId, buildCollisionGroups } from './utils/method-props.js';
import type { MethodInfo } from './method-types.js';
import {
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
  extractCallArgTypes,
  type MixedChainStep,
} from './utils/call-analysis.js';
import { buildTypeEnv, isSubclassOf } from './type-env.js';
import type { ConstructorBinding, TypeEnvironment } from './type-env.js';
import type { HeritageMap } from './heritage-map.js';
import { c3Linearize } from './mro-processor.js';
import { getTreeSitterBufferSize } from './constants.js';
import type {
  ExtractedCall,
  ExtractedAssignment,
  ExtractedHeritage,
  ExtractedRoute,
  ExtractedFetchCall,
  FileConstructorBindings,
} from './workers/parse-worker.js';
import { normalizeFetchURL, routeMatches } from './route-extractors/nextjs.js';
import { extractTemplateComponents } from './vue-sfc-extractor.js';
import { extractReturnTypeName, stripNullable } from './type-extractors/shared.js';
import type { LiteralTypeInferrer } from './type-extractors/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import { extractParsedCallSite } from './call-sites/extract-language-call-site.js';

/** Per-file resolved type bindings for exported symbols.
 *  Populated during call processing, consumed by Phase 14 re-resolution pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

/** Types that represent class-like declarations (used for receiver/owner resolution). */
const CLASS_LIKE_TYPES = new Set(['Class', 'Struct', 'Interface', 'Enum', 'Record', 'Impl']);

const MAX_EXPORTS_PER_FILE = 500;
const MAX_TYPE_NAME_LENGTH = 256;

/** Build a map of imported callee names → return types for cross-file call-result binding.
 *  Consulted ONLY when SymbolTable has no unambiguous local match (local-first principle). */
export function buildImportedReturnTypes(
  filePath: string,
  namedImportMap: ReadonlyMap<
    string,
    ReadonlyMap<string, { sourcePath: string; exportedName: string }>
  >,
  symbolTable: {
    lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined;
  },
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const fileImports = namedImportMap.get(filePath);
  if (!fileImports) return result;

  for (const [localName, binding] of fileImports) {
    const def = symbolTable.lookupExactFull(binding.sourcePath, binding.exportedName);
    if (!def?.returnType) continue;
    const simpleReturn = extractReturnTypeName(def.returnType);
    if (simpleReturn) result.set(localName, simpleReturn);
  }
  return result;
}

/** Build cross-file RAW return types for imported callables.
 *  Unlike buildImportedReturnTypes (which stores extractReturnTypeName output),
 *  this stores the raw declared return type string (e.g., 'User[]', 'List<User>').
 *  Used by lookupRawReturnType for for-loop element extraction via extractElementTypeFromString. */
export function buildImportedRawReturnTypes(
  filePath: string,
  namedImportMap: ReadonlyMap<
    string,
    ReadonlyMap<string, { sourcePath: string; exportedName: string }>
  >,
  symbolTable: {
    lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined;
  },
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const fileImports = namedImportMap.get(filePath);
  if (!fileImports) return result;

  for (const [localName, binding] of fileImports) {
    const def = symbolTable.lookupExactFull(binding.sourcePath, binding.exportedName);
    if (!def?.returnType) continue;
    result.set(localName, def.returnType);
  }
  return result;
}

/** Collect resolved type bindings for exported file-scope symbols.
 *  Uses graph node isExported flag — does NOT require isExported on SymbolDefinition. */
function collectExportedBindings(
  typeEnv: { fileScope(): ReadonlyMap<string, string> },
  filePath: string,
  symbolTable: { lookupExact(filePath: string, name: string): string | undefined },
  graph: { getNode(id: string): { properties?: { isExported?: boolean } } | undefined },
): Map<string, string> | null {
  const fileScope = typeEnv.fileScope();
  if (!fileScope || fileScope.size === 0) return null;

  const exported = new Map<string, string>();
  for (const [varName, typeName] of fileScope) {
    if (exported.size >= MAX_EXPORTS_PER_FILE) break;
    if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) continue;
    const nodeId = symbolTable.lookupExact(filePath, varName);
    if (!nodeId) continue;
    const node = graph.getNode(nodeId);
    if (node?.properties?.isExported) {
      exported.set(varName, typeName);
    }
  }
  return exported.size > 0 ? exported : null;
}

/** Build ExportedTypeMap from graph nodes — used for worker path where TypeEnv
 *  is not available in the main thread. Collects returnType/declaredType from
 *  exported symbols that have callables with known return types. */
export function buildExportedTypeMapFromGraph(
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
): ExportedTypeMap {
  const result: ExportedTypeMap = new Map();
  graph.forEachNode((node) => {
    if (!node.properties?.isExported) return;
    if (!node.properties?.filePath || !node.properties?.name) return;
    const filePath = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;
    // For callable symbols, use returnType; for properties/variables, use declaredType.
    // Use lookupExactAll + nodeId match to handle same-name methods in different classes.
    const defs = symbolTable.lookupExactAll(filePath, name);
    const def = defs.find((d) => d.nodeId === node.id) ?? defs[0];
    if (!def) return;
    const typeName = def.returnType ?? def.declaredType;
    if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;
    // Extract simple type name (strip Promise<>, etc.) — reuse shared utility
    const simpleType = extractReturnTypeName(typeName) ?? typeName;
    if (!simpleType) return;
    let fileExports = result.get(filePath);
    if (!fileExports) {
      fileExports = new Map();
      result.set(filePath, fileExports);
    }
    if (fileExports.size < MAX_EXPORTS_PER_FILE) {
      fileExports.set(name, simpleType);
    }
  });
  return result;
}

/** Seed cross-file receiver types into pre-extracted call records.
 *  Fills missing receiverTypeName for single-hop imported variables
 *  using ExportedTypeMap + namedImportMap — zero disk I/O, zero AST re-parsing.
 *  Mutates calls in-place. Runs BEFORE processCallsFromExtracted. */
export function seedCrossFileReceiverTypes(
  calls: ExtractedCall[],
  namedImportMap: ReadonlyMap<
    string,
    ReadonlyMap<string, { sourcePath: string; exportedName: string }>
  >,
  exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
): { enrichedCount: number } {
  if (namedImportMap.size === 0 || exportedTypeMap.size === 0) {
    return { enrichedCount: 0 };
  }
  let enrichedCount = 0;
  for (const call of calls) {
    if (call.receiverTypeName || !call.receiverName) continue;
    if (call.callForm !== 'member') continue;

    const fileImports = namedImportMap.get(call.filePath);
    if (!fileImports) continue;

    const binding = fileImports.get(call.receiverName);
    if (!binding) continue;

    const upstream = exportedTypeMap.get(binding.sourcePath);
    if (!upstream) continue;

    const type = upstream.get(binding.exportedName);
    if (type) {
      call.receiverTypeName = type;
      enrichedCount++;
    }
  }
  return { enrichedCount };
}

// Stdlib methods that preserve the receiver's type identity. When TypeEnv already
// strips nullable wrappers (Option<User> → User), these chain steps are no-ops
// for type resolution — the current type passes through unchanged.
const TYPE_PRESERVING_METHODS = new Set([
  'unwrap',
  'expect',
  'unwrap_or',
  'unwrap_or_default',
  'unwrap_or_else', // Rust Option/Result
  'clone',
  'to_owned',
  'as_ref',
  'as_mut',
  'borrow',
  'borrow_mut', // Rust clone/borrow
  'get', // Kotlin/Java Optional.get()
  'orElseThrow', // Java Optional
]);

/** Cache for method extraction results in findEnclosingFunction fallback path.
 *  Keyed by classNode.id to avoid re-extracting the same class body per call site.
 *  Cleared between files at line ~611 in the processCalls file loop. */
const enclosingFnExtractCache = new Map<
  number,
  import('./method-types.js').ExtractedMethods | null
>();

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
const findEnclosingFunction = (
  node: SyntaxNode,
  filePath: string,
  ctx: ResolutionContext,
  provider: import('./language-provider.js').LanguageProvider,
): string | null => {
  let current = node.parent;

  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
      const funcName = efnResult?.funcName ?? genericFuncName(current);
      const label = efnResult?.label ?? inferFunctionLabel(current.type);

      if (funcName) {
        const resolved = ctx.resolve(funcName, filePath);
        if (resolved?.tier === 'same-file' && resolved.candidates.length > 0) {
          // Disambiguate by enclosing class when multiple candidates
          if (resolved.candidates.length === 1) {
            return resolved.candidates[0].nodeId;
          }
          const classInfo = findEnclosingClassInfo(current, filePath);
          if (classInfo) {
            const classMatches = resolved.candidates.filter((c) => c.ownerId === classInfo.classId);
            // Unique class match — return it (no same-arity ambiguity)
            if (classMatches.length === 1) return classMatches[0].nodeId;
            // Multiple same-class candidates (same-arity overloads) — fall through
            // to the fallback path which computes the exact ID with type-hash.
            if (classMatches.length > 1) {
              /* fall through to manual ID construction below */
            } else {
              // No class match — return first candidate as before
              return resolved.candidates[0].nodeId;
            }
          } else {
            return resolved.candidates[0].nodeId;
          }
        }

        // Fallback: qualify the generated ID to match definition-phase node IDs
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        const classInfo2 = findEnclosingClassInfo(current, filePath);
        const qualifiedName = classInfo2 ? `${classInfo2.className}.${funcName}` : funcName;
        // Include #<arity> and ~typeTag suffix to match definition-phase Method/Constructor IDs.
        const language = getLanguageFromFilename(filePath);
        let arity: number | undefined;
        let encTypeTag = '';
        if (
          (finalLabel === 'Method' || finalLabel === 'Constructor') &&
          provider.methodExtractor &&
          language
        ) {
          // Get class method map (cached per classNode.id) and look up current method
          // by funcName:line. This avoids per-call-site extractFromNode AST walks.
          let classNode = current.parent;
          while (classNode && !provider.methodExtractor.isTypeDeclaration(classNode)) {
            classNode = classNode.parent;
          }
          let info: MethodInfo | undefined;
          if (classNode) {
            let extracted = enclosingFnExtractCache.get(classNode.id);
            if (extracted === undefined) {
              extracted =
                provider.methodExtractor.extract(classNode, { filePath, language }) ?? null;
              enclosingFnExtractCache.set(classNode.id, extracted);
            }
            if (extracted?.methods?.length) {
              const defLine = current.startPosition.row + 1;
              info = extracted.methods.find((m) => m.name === funcName && m.line === defLine);
              if (info) {
                arity = info.parameters.some((p) => p.isVariadic)
                  ? undefined
                  : info.parameters.length;
              }
              if (arity !== undefined && info) {
                const methodMap = new Map<string, MethodInfo>();
                for (const m of extracted.methods) methodMap.set(`${m.name}:${m.line}`, m);
                const groups = buildCollisionGroups(methodMap);
                encTypeTag =
                  typeTagForId(methodMap, funcName, arity, info, language, groups) +
                  constTagForId(methodMap, funcName, arity, info, groups);
              }
            }
          }
          // Fallback: extractFromNode for top-level methods without a class
          if (!info && provider.methodExtractor.extractFromNode) {
            const nodeInfo = provider.methodExtractor.extractFromNode(current, {
              filePath,
              language,
            });
            if (nodeInfo) {
              arity = nodeInfo.parameters.some((p) => p.isVariadic)
                ? undefined
                : nodeInfo.parameters.length;
            }
          }
        }
        const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : '';
        return generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag}`);
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        const resolved = ctx.resolve(customResult.funcName, filePath);
        if (resolved?.tier === 'same-file' && resolved.candidates.length > 0) {
          if (resolved.candidates.length === 1) {
            return resolved.candidates[0].nodeId;
          }
          const classInfo = findEnclosingClassInfo(current.previousSibling ?? current, filePath);
          if (classInfo) {
            const classMatches = resolved.candidates.filter((c) => c.ownerId === classInfo.classId);
            if (classMatches.length === 1) return classMatches[0].nodeId;
            if (classMatches.length > 1) {
              /* fall through to manual ID construction below */
            } else {
              return resolved.candidates[0].nodeId;
            }
          } else {
            return resolved.candidates[0].nodeId;
          }
        }
        let finalLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling!, finalLabel);
          if (override !== null) finalLabel = override;
        }
        const classInfo2 = findEnclosingClassInfo(current.previousSibling ?? current, filePath);
        const qualifiedName = classInfo2
          ? `${classInfo2.className}.${customResult.funcName}`
          : customResult.funcName;
        // Include #<arity> and ~typeTag suffix to match definition-phase Method/Constructor IDs.
        const sigNode = current.previousSibling ?? current;
        const language2 = getLanguageFromFilename(filePath);
        let arity2: number | undefined;
        let encTypeTag2 = '';
        if (
          (finalLabel === 'Method' || finalLabel === 'Constructor') &&
          provider.methodExtractor &&
          language2
        ) {
          let classNode2 = (current.previousSibling ?? current).parent;
          while (classNode2 && !provider.methodExtractor.isTypeDeclaration(classNode2)) {
            classNode2 = classNode2.parent;
          }
          let info2: MethodInfo | undefined;
          if (classNode2) {
            let extracted2 = enclosingFnExtractCache.get(classNode2.id);
            if (extracted2 === undefined) {
              extracted2 =
                provider.methodExtractor.extract(classNode2, { filePath, language: language2 }) ??
                null;
              enclosingFnExtractCache.set(classNode2.id, extracted2);
            }
            if (extracted2?.methods?.length) {
              const defLine2 = sigNode.startPosition.row + 1;
              info2 = extracted2.methods.find(
                (m) => m.name === customResult.funcName && m.line === defLine2,
              );
              if (info2) {
                arity2 = info2.parameters.some((p) => p.isVariadic)
                  ? undefined
                  : info2.parameters.length;
              }
              if (arity2 !== undefined && info2) {
                const methodMap = new Map<string, MethodInfo>();
                for (const m of extracted2.methods) methodMap.set(`${m.name}:${m.line}`, m);
                const groups2 = buildCollisionGroups(methodMap);
                encTypeTag2 =
                  typeTagForId(
                    methodMap,
                    customResult.funcName,
                    arity2,
                    info2,
                    language2,
                    groups2,
                  ) + constTagForId(methodMap, customResult.funcName, arity2, info2, groups2);
              }
            }
          }
          if (!info2 && provider.methodExtractor.extractFromNode) {
            const nodeInfo = provider.methodExtractor.extractFromNode(sigNode, {
              filePath,
              language: language2,
            });
            if (nodeInfo) {
              arity2 = nodeInfo.parameters.some((p) => p.isVariadic)
                ? undefined
                : nodeInfo.parameters.length;
            }
          }
        }
        const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : '';
        return generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag2}`);
      }
    }

    current = current.parent;
  }

  return null;
};

/**
 * Verify constructor bindings against SymbolTable and infer receiver types.
 * Shared between sequential (processCalls) and worker (processCallsFromExtracted) paths.
 */
const verifyConstructorBindings = (
  bindings: readonly ConstructorBinding[],
  filePath: string,
  ctx: ResolutionContext,
  graph?: KnowledgeGraph,
): Map<string, string> => {
  const verified = new Map<string, string>();

  for (const { scope, varName, calleeName, receiverClassName } of bindings) {
    const tiered = ctx.resolve(calleeName, filePath);
    const isClass = tiered?.candidates.some((def) => def.type === 'Class') ?? false;

    if (isClass) {
      verified.set(receiverKey(scope, varName), calleeName);
    } else {
      let callableDefs = tiered?.candidates.filter(
        (d) => d.type === 'Function' || d.type === 'Method',
      );

      // When receiver class is known (e.g. $this->method() in PHP), narrow
      // candidates to methods owned by that class to avoid false disambiguation failures.
      if (callableDefs && callableDefs.length > 1 && receiverClassName) {
        if (graph) {
          // Worker path: use graph.getNode (fast, already in-memory)
          const narrowed = callableDefs.filter((d) => {
            if (!d.ownerId) return false;
            const owner = graph.getNode(d.ownerId);
            return owner?.properties.name === receiverClassName;
          });
          if (narrowed.length > 0) callableDefs = narrowed;
        } else {
          // Sequential path: use ctx.resolve (no graph available)
          const classResolved = ctx.resolve(receiverClassName, filePath);
          if (classResolved && classResolved.candidates.length > 0) {
            const classNodeIds = new Set(classResolved.candidates.map((c) => c.nodeId));
            const narrowed = callableDefs.filter((d) => d.ownerId && classNodeIds.has(d.ownerId));
            if (narrowed.length > 0) callableDefs = narrowed;
          }
        }
      }

      if (callableDefs && callableDefs.length === 1 && callableDefs[0].returnType) {
        const typeName = extractReturnTypeName(callableDefs[0].returnType);
        if (typeName) {
          verified.set(receiverKey(scope, varName), typeName);
        }
      }
    }
  }

  return verified;
};

/**
 * Resolution result with confidence scoring
 */
interface ResolveResult {
  nodeId: string;
  confidence: number;
  reason: string;
  returnType?: string;
}

/**
 * After resolving a call to an interface method, find additional targets
 * in classes implementing that interface. Returns implementation method
 * results with lower confidence ('interface-dispatch').
 */
function findInterfaceDispatchTargets(
  calledName: string,
  receiverTypeName: string,
  currentFile: string,
  ctx: ResolutionContext,
  heritageMap: HeritageMap,
  primaryNodeId: string,
): ResolveResult[] {
  const implFiles = heritageMap.getImplementorFiles(receiverTypeName);
  if (implFiles.size === 0) return [];

  const typeResolved = ctx.resolve(receiverTypeName, currentFile);
  if (!typeResolved) return [];
  if (!typeResolved.candidates.some((c) => c.type === 'Interface')) return [];

  const results: ResolveResult[] = [];
  for (const implFile of implFiles) {
    const methods = ctx.symbols.lookupExactAll(implFile, calledName);
    for (const method of methods) {
      if (method.nodeId !== primaryNodeId) {
        results.push({
          nodeId: method.nodeId,
          confidence: 0.7,
          reason: 'interface-dispatch',
        });
      }
    }
  }
  return results;
}

export const processCalls = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  exportedTypeMap?: ExportedTypeMap,
  /** Phase 14: pre-resolved cross-file bindings to seed into buildTypeEnv. Keyed by filePath → Map<localName, typeName>. */
  importedBindingsMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  /** Phase 14 E3: cross-file return types for imported callables. Keyed by filePath → Map<calleeName, returnType>.
   *  Consulted ONLY when SymbolTable has no unambiguous match (local-first principle). */
  importedReturnTypesMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  /** Phase 14 E3: cross-file RAW return types for for-loop element extraction. Keyed by filePath → Map<calleeName, rawReturnType>. */
  importedRawReturnTypesMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  heritageMap?: HeritageMap,
): Promise<ExtractedHeritage[]> => {
  const parser = await loadParser();
  const collectedHeritage: ExtractedHeritage[] = [];
  const pendingWrites: {
    receiverTypeName: string;
    propertyName: string;
    filePath: string;
    srcId: string;
  }[] = [];
  // Phase P cross-file: accumulate heritage across files for cross-file isSubclassOf.
  // Used as a secondary check when per-file parentMap lacks the relationship — helps
  // when the heritage-declaring file is processed before the call site file.
  // For remaining cases (reverse file order), the SymbolTable class-type fallback applies.
  const globalParentMap = new Map<string, string[]>();
  const globalParentSeen = new Map<string, Set<string>>();
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    enclosingFnExtractCache.clear();
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) {
      if (skippedByLang) {
        skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
      }
      continue;
    }

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
      } catch (parseError) {
        continue;
      }
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

    // Pre-pass: extract heritage from query matches to build parentMap for buildTypeEnv.
    // Heritage-processor runs in PARALLEL, so graph edges don't exist when buildTypeEnv runs.
    const fileParentMap = new Map<string, string[]>();
    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => (captureMap[c.name] = c.node));
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className: string = captureMap['heritage.class'].text;
        const parentName: string = captureMap['heritage.extends'].text;
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name'))
          continue;
        let parents = fileParentMap.get(className);
        if (!parents) {
          parents = [];
          fileParentMap.set(className, parents);
        }
        if (!parents.includes(parentName)) parents.push(parentName);
      }
    }
    const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
    // Merge per-file heritage into globalParentMap for cross-file isSubclassOf lookups.
    // Uses a parallel Set (globalParentSeen) for O(1) deduplication instead of O(n) includes().
    for (const [cls, parents] of fileParentMap) {
      let global = globalParentMap.get(cls);
      let seen = globalParentSeen.get(cls);
      if (!global) {
        global = [];
        globalParentMap.set(cls, global);
      }
      if (!seen) {
        seen = new Set();
        globalParentSeen.set(cls, seen);
      }
      for (const p of parents) {
        if (!seen.has(p)) {
          seen.add(p);
          global.push(p);
        }
      }
    }

    const importedBindings = importedBindingsMap?.get(file.path);
    const importedReturnTypes = importedReturnTypesMap?.get(file.path);
    const importedRawReturnTypes = importedRawReturnTypesMap?.get(file.path);
    const typeEnv = buildTypeEnv(tree, language, {
      symbolTable: ctx.symbols,
      parentMap,
      importedBindings,
      importedReturnTypes,
      importedRawReturnTypes,
      enclosingFunctionFinder: provider?.enclosingFunctionFinder,
      extractFunctionName: provider?.methodExtractor?.extractFunctionName,
    });
    if (typeEnv && exportedTypeMap) {
      const fileExports = collectExportedBindings(typeEnv, file.path, ctx.symbols, graph);
      if (fileExports) exportedTypeMap.set(file.path, fileExports);
    }
    const callRouter = provider.callRouter;

    const verifiedReceivers =
      typeEnv.constructorBindings.length > 0
        ? verifyConstructorBindings(typeEnv.constructorBindings, file.path, ctx)
        : new Map<string, string>();
    const receiverIndex = buildReceiverTypeIndex(verifiedReceivers);

    ctx.enableCache(file.path);
    const widenCache: WidenCache = new Map();

    matches.forEach((match) => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => (captureMap[c.name] = c.node));
      // ── Write access: emit ACCESSES {reason: 'write'} for assignments to member fields ──
      if (
        captureMap['assignment'] &&
        captureMap['assignment.receiver'] &&
        captureMap['assignment.property']
      ) {
        const receiverNode = captureMap['assignment.receiver'];
        const propertyName: string = captureMap['assignment.property'].text;
        // Resolve receiver type: simple identifier → TypeEnv lookup or class resolution
        let receiverTypeName: string | undefined;
        const receiverText = receiverNode.text;
        if (receiverText && typeEnv) {
          receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']);
        }
        // Fall back to verified constructor bindings (mirrors CALLS resolution tier 2)
        if (!receiverTypeName && receiverText && receiverIndex.size > 0) {
          const enclosing = findEnclosingFunction(
            captureMap['assignment'],
            file.path,
            ctx,
            provider,
          );
          const funcName = enclosing ? extractFuncNameFromSourceId(enclosing) : '';
          receiverTypeName = lookupReceiverType(receiverIndex, funcName, receiverText);
        }
        if (!receiverTypeName && receiverText) {
          const resolved = ctx.resolve(receiverText, file.path);
          if (resolved?.candidates.some((d) => CLASS_LIKE_TYPES.has(d.type))) {
            receiverTypeName = receiverText;
          }
        }
        if (receiverTypeName) {
          const enclosing = findEnclosingFunction(
            captureMap['assignment'],
            file.path,
            ctx,
            provider,
          );
          const srcId = enclosing || generateId('File', file.path);
          // Defer resolution: Ruby attr_accessor properties are registered during
          // this same loop, so cross-file lookups fail if the declaring file hasn't
          // been processed yet. Collect now, resolve after all files are done.
          pendingWrites.push({ receiverTypeName, propertyName, filePath: file.path, srcId });
        }
        // Assignment-only capture (no @call sibling): skip the rest of this
        // forEach iteration — this acts as a `continue` in the match loop.
        if (!captureMap['call']) return;
      }

      if (!captureMap['call']) return;

      const callNode = captureMap['call'];
      const languageSeed = extractParsedCallSite(language, callNode);
      if (languageSeed) {
        if (provider.isBuiltInName(languageSeed.calledName)) return;

        const sourceId =
          findEnclosingFunction(callNode, file.path, ctx, provider) ||
          generateId('File', file.path);
        const receiverName =
          languageSeed.callForm === 'member' ? languageSeed.receiverName : undefined;
        let receiverTypeName =
          receiverName && typeEnv ? typeEnv.lookup(receiverName, callNode) : undefined;

        if (
          receiverName !== undefined &&
          receiverTypeName === undefined &&
          languageSeed.callForm === 'member' &&
          (language === 'java' || language === 'csharp' || language === 'kotlin')
        ) {
          const c0 = receiverName.charCodeAt(0);
          if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
        }

        const resolved = resolveCallTarget(
          {
            calledName: languageSeed.calledName,
            callForm: languageSeed.callForm,
            ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
            ...(receiverName !== undefined ? { receiverName } : {}),
          },
          file.path,
          ctx,
          undefined,
          widenCache,
          undefined,
          heritageMap,
        );

        if (!resolved) return;
        graph.addRelationship({
          id: generateId('CALLS', `${sourceId}:${languageSeed.calledName}->${resolved.nodeId}`),
          sourceId,
          targetId: resolved.nodeId,
          type: 'CALLS',
          confidence: resolved.confidence,
          reason: resolved.reason,
        });

        if (heritageMap && languageSeed.callForm === 'member' && receiverTypeName) {
          const implTargets = findInterfaceDispatchTargets(
            languageSeed.calledName,
            receiverTypeName,
            file.path,
            ctx,
            heritageMap,
            resolved.nodeId,
          );
          for (const impl of implTargets) {
            graph.addRelationship({
              id: generateId('CALLS', `${sourceId}:${languageSeed.calledName}->${impl.nodeId}`),
              sourceId,
              targetId: impl.nodeId,
              type: 'CALLS',
              confidence: impl.confidence,
              reason: impl.reason,
            });
          }
        }
        return;
      }

      const nameNode = captureMap['call.name'];
      if (!nameNode) return;

      const calledName = nameNode.text;

      const routed = callRouter?.(calledName, captureMap['call']);
      if (routed) {
        switch (routed.kind) {
          case 'skip':
          case 'import':
            return;

          case 'heritage':
            for (const item of routed.items) {
              collectedHeritage.push({
                filePath: file.path,
                className: item.enclosingClass,
                parentName: item.mixinName,
                kind: item.heritageKind,
              });
            }
            return;

          case 'properties': {
            const fileId = generateId('File', file.path);
            const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
            for (const item of routed.items) {
              const nodeId = generateId('Property', `${file.path}:${item.propName}`);
              graph.addNode({
                id: nodeId,
                label: 'Property',
                properties: {
                  name: item.propName,
                  filePath: file.path,
                  startLine: item.startLine,
                  endLine: item.endLine,
                  language,
                  isExported: true,
                  description: item.accessorType,
                },
              });
              ctx.symbols.add(file.path, item.propName, nodeId, 'Property', {
                ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                ...(item.declaredType ? { declaredType: item.declaredType } : {}),
              });
              const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
              graph.addRelationship({
                id: relId,
                sourceId: fileId,
                targetId: nodeId,
                type: 'DEFINES',
                confidence: 1.0,
                reason: '',
              });
              if (propEnclosingClassId) {
                graph.addRelationship({
                  id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                  sourceId: propEnclosingClassId,
                  targetId: nodeId,
                  type: 'HAS_PROPERTY',
                  confidence: 1.0,
                  reason: '',
                });
              }
            }
            return;
          }

          case 'call':
            break;
        }
      }

      if (provider.isBuiltInName(calledName)) return;

      const callForm = inferCallForm(callNode, nameNode);
      const receiverName = callForm === 'member' ? extractReceiverName(nameNode) : undefined;
      let receiverTypeName =
        receiverName && typeEnv ? typeEnv.lookup(receiverName, callNode) : undefined;
      // Phase P: virtual dispatch override — when the declared type is a base class but
      // the constructor created a known subclass, prefer the more specific type.
      // Checks per-file parentMap first, then falls back to globalParentMap for
      // cross-file heritage (e.g. Dog extends Animal declared in a different file).
      // Reconstructs the exact scope key (funcName@startIndex\0varName) from the
      // enclosing function AST node for a correct, O(1) map lookup.
      if (receiverTypeName && receiverName && typeEnv && typeEnv.constructorTypeMap.size > 0) {
        // Reconstruct scope key to match constructorTypeMap's scope\0varName format
        let scope = '';
        let p = callNode.parent;
        while (p) {
          if (FUNCTION_NODE_TYPES.has(p.type)) {
            const funcName =
              provider.methodExtractor?.extractFunctionName?.(p)?.funcName ?? genericFuncName(p);
            if (funcName) {
              scope = `${funcName}@${p.startIndex}`;
              break;
            }
          }
          p = p.parent;
        }
        const ctorType = typeEnv.constructorTypeMap.get(`${scope}\0${receiverName}`);
        if (ctorType && ctorType !== receiverTypeName) {
          // Verify subclass relationship: per-file parentMap first, then cross-file
          // globalParentMap, then fall back to SymbolTable class verification.
          // The SymbolTable fallback handles cross-file cases where heritage is declared
          // in a file not yet processed (e.g. Dog extends Animal in models/Dog.kt when
          // processing services/App.kt). Since constructorTypeMap only records entries
          // when a type annotation AND constructor are both present (val x: Base = Sub()),
          // confirming both are class-like types is sufficient — the original code would
          // not compile if Sub didn't extend Base.
          if (
            isSubclassOf(ctorType, receiverTypeName, parentMap) ||
            isSubclassOf(ctorType, receiverTypeName, globalParentMap) ||
            (ctx.symbols.lookupClassByName(ctorType).length > 0 &&
              ctx.symbols.lookupClassByName(receiverTypeName).length > 0)
          ) {
            receiverTypeName = ctorType;
          }
        }
      }
      // Fall back to verified constructor bindings for return type inference
      if (!receiverTypeName && receiverName && receiverIndex.size > 0) {
        const enclosingFunc = findEnclosingFunction(callNode, file.path, ctx, provider);
        const funcName = enclosingFunc ? extractFuncNameFromSourceId(enclosingFunc) : '';
        receiverTypeName = lookupReceiverType(receiverIndex, funcName, receiverName);
      }
      // Fall back to class-as-receiver for static method calls (e.g. UserService.find_user()).
      // When the receiver name is not a variable in TypeEnv but resolves to a Class/Struct/Interface
      // through the standard tiered resolution, use it directly as the receiver type.
      if (!receiverTypeName && receiverName && callForm === 'member') {
        const typeResolved = ctx.resolve(receiverName, file.path);
        if (
          typeResolved &&
          typeResolved.candidates.some(
            (d) =>
              d.type === 'Class' ||
              d.type === 'Interface' ||
              d.type === 'Struct' ||
              d.type === 'Enum',
          )
        ) {
          receiverTypeName = receiverName;
        }
      }
      // Hoist sourceId so it's available for ACCESSES edge emission during chain walk.
      const enclosingFuncId = findEnclosingFunction(callNode, file.path, ctx, provider);
      const sourceId = enclosingFuncId || generateId('File', file.path);

      // Fall back to mixed chain resolution when the receiver is a complex expression
      // (field chain, call chain, or interleaved — e.g. user.address.city.save() or
      // svc.getUser().address.save()). Handles all cases with a single unified walk.
      if (callForm === 'member' && !receiverTypeName && !receiverName) {
        const receiverNode = extractReceiverNode(nameNode);
        if (receiverNode) {
          const extracted = extractMixedChain(receiverNode);
          if (extracted && extracted.chain.length > 0) {
            let currentType =
              extracted.baseReceiverName && typeEnv
                ? typeEnv.lookup(extracted.baseReceiverName, callNode)
                : undefined;
            if (!currentType && extracted.baseReceiverName && receiverIndex.size > 0) {
              const funcName = enclosingFuncId ? extractFuncNameFromSourceId(enclosingFuncId) : '';
              currentType = lookupReceiverType(receiverIndex, funcName, extracted.baseReceiverName);
            }
            if (!currentType && extracted.baseReceiverName) {
              const cr = ctx.resolve(extracted.baseReceiverName, file.path);
              if (
                cr?.candidates.some(
                  (d) =>
                    d.type === 'Class' ||
                    d.type === 'Interface' ||
                    d.type === 'Struct' ||
                    d.type === 'Enum',
                )
              ) {
                currentType = extracted.baseReceiverName;
              }
            }
            if (currentType) {
              receiverTypeName = walkMixedChain(
                extracted.chain,
                currentType,
                file.path,
                ctx,
                makeAccessEmitter(graph, sourceId),
                heritageMap,
              );
            }
          }
        }
      }

      // Build overload hints for languages with inferLiteralType (Java/Kotlin/C#/C++).
      // Only used when multiple candidates survive arity filtering — ~1-3% of calls.
      const langConfig = provider.typeConfig;
      const hints: OverloadHints | undefined = langConfig?.inferLiteralType
        ? { callNode, inferLiteralType: langConfig.inferLiteralType, typeEnv }
        : undefined;

      const resolved = resolveCallTarget(
        {
          calledName,
          argCount: countCallArguments(callNode),
          callForm,
          receiverTypeName,
          receiverName,
        },
        file.path,
        ctx,
        hints,
        widenCache,
        undefined,
        heritageMap,
      );

      if (!resolved) return;
      const relId = generateId('CALLS', `${sourceId}:${calledName}->${resolved.nodeId}`);

      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });

      if (heritageMap && callForm === 'member' && receiverTypeName) {
        const implTargets = findInterfaceDispatchTargets(
          calledName,
          receiverTypeName,
          file.path,
          ctx,
          heritageMap,
          resolved.nodeId,
        );
        for (const impl of implTargets) {
          graph.addRelationship({
            id: generateId('CALLS', `${sourceId}:${calledName}->${impl.nodeId}`),
            sourceId,
            targetId: impl.nodeId,
            type: 'CALLS',
            confidence: impl.confidence,
            reason: impl.reason,
          });
        }
      }
    });

    // Vue: emit CALLS edges for PascalCase components used in <template>.
    // Template components are default-imported (not named), so we match the
    // component name against imported .vue file basenames via the import map.
    if (language === SupportedLanguages.Vue) {
      const templateComponents = extractTemplateComponents(file.content);
      if (templateComponents.length > 0) {
        const fileId = generateId('File', file.path);
        const importedFiles = ctx.importMap.get(file.path);
        if (importedFiles) {
          for (const componentName of templateComponents) {
            for (const importedPath of importedFiles) {
              if (!importedPath.endsWith('.vue')) continue;
              const basename = importedPath.slice(
                importedPath.lastIndexOf('/') + 1,
                importedPath.lastIndexOf('.'),
              );
              if (basename !== componentName) continue;
              const targetFileId = generateId('File', importedPath);
              if (graph.getNode(targetFileId)) {
                graph.addRelationship({
                  id: generateId('CALLS', `${fileId}:${componentName}->${targetFileId}`),
                  sourceId: fileId,
                  targetId: targetFileId,
                  type: 'CALLS',
                  confidence: 0.9,
                  reason: 'vue-template-component',
                });
              }
              break;
            }
          }
        }
      }
    }

    ctx.clearCache();
  }

  // ── Resolve deferred write-access edges ──
  // All properties (including Ruby attr_accessor) are now registered.
  for (const pw of pendingWrites) {
    const fieldOwner = resolveFieldOwnership(
      pw.receiverTypeName,
      pw.propertyName,
      pw.filePath,
      ctx,
    );
    if (fieldOwner) {
      graph.addRelationship({
        id: generateId('ACCESSES', `${pw.srcId}:${fieldOwner.nodeId}:write`),
        sourceId: pw.srcId,
        targetId: fieldOwner.nodeId,
        type: 'ACCESSES',
        confidence: 1.0,
        reason: 'write',
      });
    }
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in call processing — ${lang} parser not available.`,
      );
    }
  }

  return collectedHeritage;
};

const CALLABLE_SYMBOL_TYPES = new Set(['Function', 'Method', 'Constructor', 'Macro', 'Delegate']);

const CONSTRUCTOR_TARGET_TYPES = new Set(['Constructor', 'Class', 'Struct', 'Record']);

const filterCallableCandidates = (
  candidates: readonly SymbolDefinition[],
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
): SymbolDefinition[] => {
  let kindFiltered: SymbolDefinition[];

  if (callForm === 'constructor') {
    const constructors = candidates.filter((c) => c.type === 'Constructor');
    if (constructors.length > 0) {
      kindFiltered = constructors;
    } else {
      const types = candidates.filter((c) => CONSTRUCTOR_TARGET_TYPES.has(c.type));
      kindFiltered =
        types.length > 0 ? types : candidates.filter((c) => CALLABLE_SYMBOL_TYPES.has(c.type));
    }
  } else {
    kindFiltered = candidates.filter((c) => CALLABLE_SYMBOL_TYPES.has(c.type));
  }

  if (kindFiltered.length === 0) return [];
  if (argCount === undefined) return kindFiltered;

  const hasParameterMetadata = kindFiltered.some(
    (candidate) => candidate.parameterCount !== undefined,
  );
  if (!hasParameterMetadata) return kindFiltered;

  return kindFiltered.filter(
    (candidate) =>
      candidate.parameterCount === undefined ||
      (argCount >= (candidate.requiredParameterCount ?? candidate.parameterCount) &&
        argCount <= candidate.parameterCount),
  );
};

const toResolveResult = (definition: SymbolDefinition, tier: ResolutionTier): ResolveResult => ({
  nodeId: definition.nodeId,
  confidence: TIER_CONFIDENCE[tier],
  reason:
    tier === 'same-file' ? 'same-file' : tier === 'import-scoped' ? 'import-resolved' : 'global',
  returnType: definition.returnType,
});

/**
 * Optional hints for overload disambiguation via argument literal types.
 * Only available on the sequential path (has AST); worker path passes undefined.
 *
 * @internal Exported so tests can exercise the D0 skip-condition path without
 *           constructing a real SyntaxNode. Do not use outside `call-processor.ts`
 *           and its unit tests.
 */
export interface OverloadHints {
  callNode: SyntaxNode;
  inferLiteralType: LiteralTypeInferrer;
  typeEnv?: TypeEnvironment;
}

/**
 * Kotlin often declares parameters with boxed names (`Int`, `Boolean`, …) while
 * literal inference yields JVM primitives (`int`, `boolean`). This map aligns
 * those for overload matching. Java parameter text is usually already primitive
 * spellings, so lookups here are typically unchanged.
 */
const KOTLIN_BOXED_TO_PRIMITIVE: Readonly<Record<string, string>> = {
  Int: 'int',
  Long: 'long',
  Short: 'short',
  Byte: 'byte',
  Float: 'float',
  Double: 'double',
  Boolean: 'boolean',
  Char: 'char',
};

const normalizeJvmTypeName = (name: string): string => KOTLIN_BOXED_TO_PRIMITIVE[name] ?? name;

const matchCandidatesByArgTypes = (
  candidates: SymbolDefinition[],
  argTypes: (string | undefined)[],
): SymbolDefinition | null => {
  if (!candidates.some((c) => c.parameterTypes)) return null;

  const matched = candidates.filter((c) => {
    // Keep candidates without type info — conservative: partially-annotated codebases
    // (e.g. C++ with some missing declarations) may have mixed typed/untyped overloads.
    // If one typed and one untyped both survive, matched.length > 1 → returns null (no edge).
    if (!c.parameterTypes) return true;
    return c.parameterTypes.every((pType, i) => {
      if (i >= argTypes.length || !argTypes[i]) return true;
      // Normalise Kotlin boxed type names (Int→int, Boolean→boolean, etc.) so
      // that the stored declaration type matches the inferred literal type.
      return normalizeJvmTypeName(pType) === argTypes[i];
    });
  });

  if (matched.length === 1) return matched[0];
  // Multiple survivors may share the same nodeId (e.g. TypeScript overload signatures +
  // implementation body all collide via generateId). Deduplicate by nodeId — if all
  // matched candidates resolve to the same graph node, disambiguation succeeded.
  if (matched.length > 1) {
    const uniqueIds = new Set(matched.map((c) => c.nodeId));
    if (uniqueIds.size === 1) return matched[0];
  }
  return null;
};

/**
 * Try to disambiguate overloaded candidates using argument literal types.
 * Only invoked when filteredCandidates.length > 1 and at least one has parameterTypes.
 * Returns the single matching candidate, or null if ambiguous/inconclusive.
 */
const tryOverloadDisambiguation = (
  candidates: SymbolDefinition[],
  hints: OverloadHints,
): SymbolDefinition | null => {
  const argTypes = extractCallArgTypes(
    hints.callNode,
    hints.inferLiteralType,
    hints.typeEnv ? (varName, cn) => hints.typeEnv!.lookup(varName, cn) : undefined,
  );
  if (!argTypes) return null;
  return matchCandidatesByArgTypes(candidates, argTypes);
};

/**
 * Resolve a function call to its target node ID using priority strategy:
 * A. Narrow candidates by scope tier via ctx.resolve()
 * B. Filter to callable symbol kinds (constructor-aware when callForm is set)
 * C. Apply arity filtering when parameter metadata is available
 * D. Apply receiver-type filtering for member calls with typed receivers
 * E. Apply overload disambiguation via argument literal types (when available)
 *
 * If filtering still leaves multiple candidates, refuse to emit a CALLS edge.
 */
/** Per-file cache for the widen path's lookupFuzzy calls. Cleared between files. */
type WidenCache = Map<string, readonly SymbolDefinition[]>;

/** @internal Exported for unit tests of D0 skip conditions (SM-11). Do not use outside tests. */
export const _resolveCallTargetForTesting = (
  call: Pick<
    ExtractedCall,
    'calledName' | 'argCount' | 'callForm' | 'receiverTypeName' | 'receiverName'
  >,
  currentFile: string,
  ctx: ResolutionContext,
  opts?: {
    overloadHints?: OverloadHints;
    widenCache?: WidenCache;
    preComputedArgTypes?: (string | undefined)[];
    heritageMap?: HeritageMap;
  },
): ResolveResult | null =>
  resolveCallTarget(
    call,
    currentFile,
    ctx,
    opts?.overloadHints,
    opts?.widenCache,
    opts?.preComputedArgTypes,
    opts?.heritageMap,
  );

const resolveCallTarget = (
  call: Pick<
    ExtractedCall,
    'calledName' | 'argCount' | 'callForm' | 'receiverTypeName' | 'receiverName'
  >,
  currentFile: string,
  ctx: ResolutionContext,
  overloadHints?: OverloadHints,
  widenCache?: WidenCache,
  preComputedArgTypes?: (string | undefined)[],
  heritageMap?: HeritageMap,
): ResolveResult | null => {
  const tiered = ctx.resolve(call.calledName, currentFile);
  if (!tiered) return null;

  let filteredCandidates = filterCallableCandidates(
    tiered.candidates,
    call.argCount,
    call.callForm,
  );

  // Swift/Kotlin: constructor calls look like free function calls (no `new` keyword).
  // If free-form filtering found no callable candidates but the symbol resolves to a
  // Class/Struct, retry with constructor form so CONSTRUCTOR_TARGET_TYPES applies.
  if (filteredCandidates.length === 0 && call.callForm === 'free') {
    const hasTypeTarget = tiered.candidates.some(
      (c) => c.type === 'Class' || c.type === 'Struct' || c.type === 'Enum',
    );
    if (hasTypeTarget) {
      filteredCandidates = filterCallableCandidates(
        tiered.candidates,
        call.argCount,
        'constructor',
      );
    }
  }

  // Module-qualified constructor pattern: e.g. Python `import models; models.User()`.
  // The attribute access gives callForm='member', but the callee may be a Class — a valid
  // constructor target. Re-try with constructor-form filtering so that `module.ClassName()`
  // emits a CALLS edge to the class node.
  if (filteredCandidates.length === 0 && call.callForm === 'member') {
    filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, 'constructor');
  }

  // Module-alias disambiguation: Python `import auth; auth.User()` — receiverName='auth'
  // selects auth.py via moduleAliasMap. Runs for ALL member calls with a known module alias,
  // not just ambiguous ones — same-file tier may shadow the correct cross-module target when
  // the caller defines a function with the same name as the callee (Issue #417).
  //
  // Tracks `aliasNarrowed` so the D2 widening step below does NOT undo the alias filtering
  // by calling lookupFuzzy again (which would re-introduce homonym candidates from other files).
  let aliasNarrowed = false;
  if (call.callForm === 'member' && call.receiverName) {
    const aliasMap = ctx.moduleAliasMap?.get(currentFile);
    if (aliasMap) {
      const moduleFile = aliasMap.get(call.receiverName);
      if (moduleFile) {
        const aliasFiltered = filteredCandidates.filter((c) => c.filePath === moduleFile);
        if (aliasFiltered.length > 0) {
          filteredCandidates = aliasFiltered;
          aliasNarrowed = true;
        } else {
          // Same-file tier returned a local match, but the alias points elsewhere.
          // Widen to global candidates and filter to the aliased module's file.
          // Use per-file widenCache to avoid repeated lookupFuzzy for the same
          // calledName+moduleFile from multiple call sites in the same file.
          const cacheKey = `${call.calledName}\0${moduleFile}`;
          let fuzzyDefs = widenCache?.get(cacheKey);
          if (!fuzzyDefs) {
            fuzzyDefs = ctx.symbols.lookupFuzzy(call.calledName);
            widenCache?.set(cacheKey, fuzzyDefs);
          }
          const widened = filterCallableCandidates(fuzzyDefs, call.argCount, call.callForm).filter(
            (c) => c.filePath === moduleFile,
          );
          if (widened.length > 0) {
            filteredCandidates = widened;
            aliasNarrowed = true;
          }
        }
      }
    }
  }

  // D. Receiver-type filtering: for member calls with a known receiver type,
  // resolve the type through the same tiered import infrastructure, then
  // filter method candidates to the type's defining file. Fall back to
  // fuzzy ownerId matching only when file-based narrowing is inconclusive.
  //
  // Applied regardless of candidate count — the sole same-file candidate may
  // belong to the wrong class (e.g. super.save() should hit the parent's save,
  // not the child's own save method in the same file).
  if (call.callForm === 'member' && call.receiverTypeName) {
    // D0. Delegate to resolveMemberCall (SM-11): owner-scoped + MRO lookup
    //     before falling back to the expensive D1-D4 fuzzy widening.
    //     Skip conditions:
    //     (a) overloadHints or preComputedArgTypes present — the MRO lookup may
    //         pick the wrong overload for same-return-type overloads since it
    //         does not consider argument types. D1-D4+E handles those correctly.
    //     (b) A module alias on call.receiverName is active for this file — the
    //         alias block above already narrowed `filteredCandidates` to a
    //         specific file. resolveMemberCall re-resolves `receiverTypeName`
    //         from scratch via `ctx.resolve`, which ignores that narrowing and
    //         could pick a homonymous class from the wrong file. Fall through to
    //         D1-D4 which respects the alias-filtered candidate pool.
    // D0 skip for overload disambiguation: only fires when the name actually
    // has multiple candidates in the tiered pool. The sequential path sets
    // `overloadHints` for every call regardless of whether the method is
    // overloaded — skipping D0 unconditionally would make this fast path
    // dead code for the sequential pipeline. By gating on
    // `filteredCandidates.length > 1`, we preserve the original intent
    // (let D1-D4+E pick the right overload when there are multiple) while
    // allowing D0 to fire for the common single-candidate case.
    const hasOverloadConcern =
      (!!overloadHints || !!preComputedArgTypes) && filteredCandidates.length > 1;
    // D0 skip for active module alias: only fires when the alias block above
    // actually narrowed filteredCandidates. In Python, a local variable can
    // shadow an imported module name (e.g. `from models.c import C; c = C()`
    // creates both a module alias `c → models/c.py` AND a typed local `c`).
    // Checking `aliasNarrowed` rather than `ctx.moduleAliasMap.has(receiverName)`
    // ensures D0 still runs when the method isn't in the aliased module —
    // which means the receiver is a typed local variable, not a module reference.
    if (!hasOverloadConcern && !aliasNarrowed) {
      const memberResult = resolveMemberCall(
        call.receiverTypeName,
        call.calledName,
        currentFile,
        ctx,
        heritageMap,
        call.argCount,
      );
      if (memberResult) return memberResult;
    }

    // D1. Resolve the receiver type
    const typeResolved = ctx.resolve(call.receiverTypeName, currentFile);
    if (typeResolved && typeResolved.candidates.length > 0) {
      const typeNodeIds = new Set(typeResolved.candidates.map((d) => d.nodeId));
      const typeFiles = new Set(typeResolved.candidates.map((d) => d.filePath));

      // D2. Widen candidates: same-file tier may miss the parent's method when
      //     it lives in another file. Query the symbol table directly for all
      //     global methods with this name, then apply arity/kind filtering.
      //
      //     When the candidate set was already narrowed by module-alias
      //     disambiguation, do NOT widen back to the full fuzzy pool — that
      //     would undo the alias narrowing and reintroduce homonym candidates
      //     from other files.
      const methodPool =
        filteredCandidates.length <= 1 && !aliasNarrowed
          ? filterCallableCandidates(
              ctx.symbols.lookupFuzzy(call.calledName),
              call.argCount,
              call.callForm,
            )
          : filteredCandidates;

      // D3. File-based: prefer candidates whose filePath matches the resolved type's file
      const fileFiltered = methodPool.filter((c) => typeFiles.has(c.filePath));
      if (fileFiltered.length === 1) {
        return toResolveResult(fileFiltered[0], tiered.tier);
      }

      // D4. ownerId fallback: narrow by ownerId matching the type's nodeId
      const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
      const ownerFiltered = pool.filter((c) => c.ownerId && typeNodeIds.has(c.ownerId));
      if (ownerFiltered.length === 1) {
        return toResolveResult(ownerFiltered[0], tiered.tier);
      }
      // E. Try overload disambiguation on the narrowed pool
      if (fileFiltered.length > 1 || ownerFiltered.length > 1) {
        const overloadPool = ownerFiltered.length > 1 ? ownerFiltered : fileFiltered;
        const disambiguated = overloadHints
          ? tryOverloadDisambiguation(overloadPool, overloadHints)
          : preComputedArgTypes
            ? matchCandidatesByArgTypes(overloadPool, preComputedArgTypes)
            : null;
        if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
        return null;
      }

      // Zero-match null-route: we committed to receiver narrowing (D1 succeeded)
      // but both file-based (D3) and owner-based (D4) filters produced zero
      // matches. The lone candidate in `filteredCandidates` does not belong to
      // this receiver type — refuse to emit a CALLS edge rather than fall
      // through to the permissive single-candidate tail return.
      //
      // Addresses Codex review finding R3 (PR #744): member calls where
      // fuzzy fallback picked a globally-matching symbol that has no
      // relationship to the receiver's class hierarchy were silently
      // producing false-positive edges. Example: Rust `c.trait_only()` where
      // `trait_only` is captured as a Function node with no ownerId — it
      // matches the name but fails both file and owner narrowing, so the
      // old tail return would pick it incorrectly.
      if (fileFiltered.length === 0 && ownerFiltered.length === 0) {
        return null;
      }
    }
  }

  // E. Overload disambiguation: when multiple candidates survive arity + receiver filtering,
  // try matching argument types against parameter types (Phase P).
  // Sequential path uses AST-based hints; worker path uses pre-computed argTypes.
  if (filteredCandidates.length > 1) {
    const disambiguated = overloadHints
      ? tryOverloadDisambiguation(filteredCandidates, overloadHints)
      : preComputedArgTypes
        ? matchCandidatesByArgTypes(filteredCandidates, preComputedArgTypes)
        : null;
    if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
  }

  if (filteredCandidates.length !== 1) {
    // Deduplicate: Swift extensions create multiple Class nodes with the same name.
    // When all candidates share the same type and differ only by file (extension vs
    // primary definition), they represent the same symbol. Prefer the primary
    // definition (shortest file path: Product.swift over ProductExtension.swift).
    if (filteredCandidates.length > 1) {
      const allSameType = filteredCandidates.every((c) => c.type === filteredCandidates[0].type);
      if (
        allSameType &&
        (filteredCandidates[0].type === 'Class' || filteredCandidates[0].type === 'Struct')
      ) {
        const sorted = [...filteredCandidates].sort(
          (a, b) => a.filePath.length - b.filePath.length,
        );
        return toResolveResult(sorted[0], tiered.tier);
      }
    }
    return null;
  }

  return toResolveResult(filteredCandidates[0], tiered.tier);
};

// ── Scope key helpers ────────────────────────────────────────────────────
// Scope keys use the format "funcName@startIndex" (produced by type-env.ts).
// Source IDs use "Label:filepath:funcName" (produced by parse-worker.ts).
// NUL (\0) is used as a composite-key separator because it cannot appear
// in source-code identifiers, preventing ambiguous concatenation.
//
// receiverKey stores the FULL scope (funcName@startIndex) to prevent
// collisions between overloaded methods with the same name in different
// classes (e.g. User.save@100 and Repo.save@200 are distinct keys).
// Lookup uses a secondary funcName-only index built in lookupReceiverType.

/** Extract the function name from a scope key ("funcName@startIndex" → "funcName"). */
const extractFuncNameFromScope = (scope: string): string => scope.slice(0, scope.indexOf('@'));

/** Extract the bare function name from a sourceId.
 *  Handles both unqualified ("Function:filepath:funcName" → "funcName")
 *  and qualified ("Function:filepath:ClassName.funcName" → "funcName").
 *  Strips any trailing #<arity> suffix from Method/Constructor IDs. */
const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  const segment = lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
  const dotIdx = segment.lastIndexOf('.');
  const raw = dotIdx >= 0 ? segment.slice(dotIdx + 1) : segment;
  // Strip #<arity> suffix (e.g. "save#2" → "save")
  const hashIdx = raw.indexOf('#');
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
};

/**
 * Build a composite key for receiver type storage.
 * Uses the full scope string (e.g. "save@100") to distinguish overloaded
 * methods with the same name in different classes.
 */
const receiverKey = (scope: string, varName: string): string => `${scope}\0${varName}`;

/**
 * Pre-built secondary index for O(1) receiver type lookups.
 * Built once per file from the verified receiver map, keyed by funcName → varName.
 */
type ReceiverTypeEntry =
  | { readonly kind: 'resolved'; readonly value: string }
  | { readonly kind: 'ambiguous' };
type ReceiverTypeIndex = Map<string, Map<string, ReceiverTypeEntry>>;

/**
 * Build a two-level secondary index from the verified receiver map.
 * The verified map is keyed by `scope\0varName` where scope is either
 * "funcName@startIndex" (inside a function) or "" (file level).
 * Index structure: Map<funcName, Map<varName, ReceiverTypeEntry>>
 *
 * Known limitation: the index collapses scope keys to bare funcName,
 * so two same-arity overloads with the same local variable name but
 * different types will mark that variable as ambiguous. A future
 * enhancement should key by full scope (funcName@startIndex) and carry
 * scope keys through findEnclosingFunction's return type.
 */
const buildReceiverTypeIndex = (map: Map<string, string>): ReceiverTypeIndex => {
  const index: ReceiverTypeIndex = new Map();
  for (const [key, typeName] of map) {
    const nul = key.indexOf('\0');
    if (nul < 0) continue;
    const scope = key.slice(0, nul);
    const varName = key.slice(nul + 1);
    if (!varName) continue;
    if (scope !== '' && !scope.includes('@')) continue;
    const funcName = scope === '' ? '' : scope.slice(0, scope.indexOf('@'));

    let varMap = index.get(funcName);
    if (!varMap) {
      varMap = new Map();
      index.set(funcName, varMap);
    }

    const existing = varMap.get(varName);
    if (existing === undefined) {
      varMap.set(varName, { kind: 'resolved', value: typeName });
    } else if (existing.kind === 'resolved' && existing.value !== typeName) {
      varMap.set(varName, { kind: 'ambiguous' });
    }
  }
  return index;
};

/**
 * O(1) receiver type lookup using the pre-built secondary index.
 * Returns the unique type name if unambiguous. Falls back to file-level scope.
 */
const lookupReceiverType = (
  index: ReceiverTypeIndex,
  funcName: string,
  varName: string,
): string | undefined => {
  const funcBucket = index.get(funcName);
  if (funcBucket) {
    const entry = funcBucket.get(varName);
    if (entry?.kind === 'resolved') return entry.value;
    if (entry?.kind === 'ambiguous') {
      // Ambiguous in this function scope — try file-level fallback
      const fileEntry = index.get('')?.get(varName);
      return fileEntry?.kind === 'resolved' ? fileEntry.value : undefined;
    }
  }
  // Fallback: file-level scope (funcName "")
  if (funcName !== '') {
    const fileEntry = index.get('')?.get(varName);
    if (fileEntry?.kind === 'resolved') return fileEntry.value;
  }
  return undefined;
};

interface FieldResolution {
  typeName: string; // resolved declared type (continues chain threading)
  fieldNodeId: string; // nodeId of the Property symbol (for ACCESSES edge target)
}

/**
 * Resolve the type that results from accessing `receiverName.fieldName`.
 * Requires declaredType on the Property node (needed for chain walking continuation).
 */
const resolveFieldAccessType = (
  receiverName: string,
  fieldName: string,
  filePath: string,
  ctx: ResolutionContext,
): FieldResolution | undefined => {
  const fieldDef = resolveFieldOwnership(receiverName, fieldName, filePath, ctx);
  if (!fieldDef?.declaredType) return undefined;

  // Use stripNullable (not extractReturnTypeName) — field types like List<User>
  // should be preserved as-is, not unwrapped to User. Only strip nullable wrappers.
  return {
    typeName: stripNullable(fieldDef.declaredType),
    fieldNodeId: fieldDef.nodeId,
  };
};

/**
 * Resolve a field's Property node given a receiver type name and field name.
 * Does NOT require declaredType — used by write-access tracking where only the
 * fieldNodeId is needed (no chain continuation).
 */
const resolveFieldOwnership = (
  receiverName: string,
  fieldName: string,
  filePath: string,
  ctx: ResolutionContext,
): { nodeId: string; declaredType?: string } | undefined => {
  const typeResolved = ctx.resolve(receiverName, filePath);
  if (!typeResolved) return undefined;
  const classDef = typeResolved.candidates.find((d) => CLASS_LIKE_TYPES.has(d.type));
  if (!classDef) return undefined;

  return ctx.symbols.lookupFieldByOwner(classDef.nodeId, fieldName) ?? undefined;
};

/**
 * Resolve a method by owner type name using the eagerly-populated methodByOwner index.
 * Returns `{ def, tier }` when an unambiguous method is found, `undefined` otherwise.
 *
 * **Multi-candidate iteration (homonym disambiguation):** when `ctx.resolve(ownerType)`
 * returns multiple class-like candidates (e.g. two classes named `User` in different
 * files reachable from the call site), each is probed with `lookupMethodByOwnerWithMRO`.
 * Results are deduplicated by `nodeId` so that:
 *
 *   - homonym classes that both walk up to the SAME ancestor's method collapse to 1 hit
 *   - aliased re-exports that produce two candidates pointing at the same def collapse too
 *
 * After deduplication:
 *
 *   - 0 unique matches → `undefined` (owner-scoped path has no answer; D1-D4 fuzzy
 *     fallback in `resolveCallTarget` may still find something via lookupFuzzy)
 *   - 1 unique match   → return it
 *   - ≥2 unique matches → `undefined` (genuine homonym ambiguity; don't silently pick one)
 *
 * This absorbs what was previously D4's job inside `resolveCallTarget` — "filter fuzzy
 * candidates to those whose ownerId is in the receiver type's nodeId set" — into the
 * owner-scoped path, aligning with the plan's target:
 *
 *     `resolveCallTarget` D2 widening → `model.lookupMethodWithMRO(ownerNodeId, name)`
 *
 * The returned `tier` reflects how the owner TYPE was resolved (not the method name).
 * Threaded out here so callers don't need a second `ctx.resolve(ownerType, ...)` call —
 * this decouples callers from `ctx.resolve`'s per-file caching contract, which SM-16
 * will restructure when it replaces the `lookupFuzzy` data source.
 */
const resolveMethodByOwner = (
  receiverTypeName: string,
  methodName: string,
  filePath: string,
  ctx: ResolutionContext,
  heritageMap?: HeritageMap,
  argCount?: number,
): { def: SymbolDefinition; tier: ResolutionTier } | undefined => {
  const typeResolved = ctx.resolve(receiverTypeName, filePath);
  if (!typeResolved) return undefined;

  // MRO walking needs a language hint; compute once and reuse for every candidate.
  // Unknown extension → fall back to plain direct lookup (D1-D4 still runs on miss).
  const language = heritageMap ? getLanguageFromFilename(filePath) : null;
  const canWalkMRO = heritageMap != null && language != null;

  // Iterate all class-like candidates tracking the first unambiguous hit.
  // Zero-allocation fast path: the common case is exactly one class candidate,
  // so we avoid building a Map. A second hit with a different `nodeId` flips
  // `ambiguous` and short-circuits the loop. Diamond MRO convergence on the
  // same inherited method collapses to one hit because `nodeId` matches.
  //
  //   firstDef === undefined → owner-scoped resolution found nothing
  //   firstDef && !ambiguous → unambiguous answer
  //   ambiguous              → genuine homonym ambiguity — refuse to pick
  //
  // argCount is threaded through so arity-differing overloads
  // (e.g. C++ `greet()` vs `greet(string)`) are disambiguated inside the
  // owner-scoped lookup rather than collapsing to an arbitrary first pick.
  let firstDef: SymbolDefinition | undefined;
  let ambiguous = false;
  for (const candidate of typeResolved.candidates) {
    if (!CLASS_LIKE_TYPES.has(candidate.type)) continue;
    const def = canWalkMRO
      ? lookupMethodByOwnerWithMRO(
          candidate.nodeId,
          methodName,
          heritageMap,
          ctx.symbols,
          language,
          argCount,
        )
      : ctx.symbols.lookupMethodByOwner(candidate.nodeId, methodName, argCount);
    if (!def) continue;
    if (!firstDef) {
      firstDef = def;
    } else if (def.nodeId !== firstDef.nodeId) {
      ambiguous = true;
      break;
    }
  }

  if (!firstDef || ambiguous) return undefined;
  return { def: firstDef, tier: typeResolved.tier };
};

// ---------------------------------------------------------------------------
// SM-11: Owner-scoped + MRO member-call resolution (no fuzzy lookup)
// ---------------------------------------------------------------------------

/**
 * Resolve a member call using owner-scoped + MRO resolution only (no fuzzy lookup).
 * Used for `obj.method()` calls where the receiver type is known.
 *
 * Delegates to {@link resolveMethodByOwner} which performs an O(1) owner-scoped
 * method lookup and, when a {@link HeritageMap} is provided, walks the MRO chain
 * via {@link lookupMethodByOwnerWithMRO}.
 *
 * {@link resolveCallTarget} delegates here for member calls before falling back
 * to the more expensive fuzzy-widening path (D1-D4).
 *
 * **SEMANTIC CHANGE (2026-04-09):** The confidence tier now reflects how the
 * owner TYPE was resolved, not how the method NAME was resolved globally. The
 * previous D0 fast path in `resolveCallTarget` used `tiered.tier` from
 * `ctx.resolve(calledName, ...)` — a name-based tier that matched what D1-D4
 * fuzzy widening would produce. The new tier is owner-type-based, which is
 * more accurate for owner-scoped resolution (the discriminant IS the class,
 * not the method name). Downstream consumers that filter CALLS edges by
 * confidence threshold may see shifted values on otherwise-unchanged code.
 * See the "returns result with correct confidence tier" tests below for the
 * locked-in behavior.
 *
 * **Performance:** Callers that only need the return type (e.g. `walkMixedChain`)
 * should call {@link resolveMethodByOwner} directly and use the `.def.returnType`
 * field instead, to avoid building a throwaway `ResolveResult`.
 *
 * @param ownerType   - The receiver's type name (e.g. 'User')
 * @param methodName  - The method being called (e.g. 'save')
 * @param currentFile - File path of the call site
 * @param ctx         - Resolution context
 * @param heritageMap - Optional heritage map for MRO-aware ancestor walking
 */
export const resolveMemberCall = (
  ownerType: string,
  methodName: string,
  currentFile: string,
  ctx: ResolutionContext,
  heritageMap?: HeritageMap,
  argCount?: number,
): ResolveResult | null => {
  const resolved = resolveMethodByOwner(
    ownerType,
    methodName,
    currentFile,
    ctx,
    heritageMap,
    argCount,
  );
  if (!resolved) return null;
  return toResolveResult(resolved.def, resolved.tier);
};

// ---------------------------------------------------------------------------
// MRO-aware method resolution via HeritageMap (SM-9)
// ---------------------------------------------------------------------------

/**
 * Per-HeritageMap cache of C3 linearization results keyed by owner nodeId.
 *
 * HeritageMap instances are immutable after construction, so C3 output is
 * stable for the lifetime of a HeritageMap. WeakMap lets the cache auto-drain
 * when the HeritageMap is garbage collected (end of ingestion run), so we
 * never need to manually invalidate it.
 *
 * `null` is a sentinel for "C3 failed for this owner" (cyclic or inconsistent
 * hierarchy) so we don't re-run the expensive linearization repeatedly.
 */
const c3LinearizationCache = new WeakMap<HeritageMap, Map<string, readonly string[] | null>>();

const getCachedC3Linearization = (
  ownerNodeId: string,
  heritageMap: HeritageMap,
): readonly string[] | null => {
  let perHmCache = c3LinearizationCache.get(heritageMap);
  if (!perHmCache) {
    perHmCache = new Map();
    c3LinearizationCache.set(heritageMap, perHmCache);
  }
  const cached = perHmCache.get(ownerNodeId);
  if (cached !== undefined) return cached;
  const parentMap = buildParentMapFromHeritage(ownerNodeId, heritageMap);
  const result = c3Linearize(ownerNodeId, parentMap, new Map()) ?? null;
  perHmCache.set(ownerNodeId, result);
  return result;
};

/**
 * Build a parentMap from HeritageMap for use with c3Linearize.
 * Traverses the parent chain starting from startNodeId, collecting all
 * parent→children relationships into a Map<string, string[]>.
 */
const buildParentMapFromHeritage = (
  startNodeId: string,
  heritageMap: HeritageMap,
): Map<string, string[]> => {
  const parentMap = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue = [startNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const parents = heritageMap.getParents(nodeId);
    if (parents.length > 0) {
      parentMap.set(nodeId, parents);
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  }

  return parentMap;
};

/**
 * Look up a method on an owner class, walking the parent chain via HeritageMap
 * when the method isn't found on the direct owner.
 *
 * Respects the 5 per-language MRO strategies:
 * - `first-wins`:       BFS ancestor walk, first match wins (default)
 * - `leftmost-base`:    BFS ancestor walk, leftmost base in declaration order wins (C++);
 *                        HeritageMap preserves insertion order matching source declaration,
 *                        so BFS order is equivalent to leftmost-base semantics
 * - `c3`:               C3-linearized ancestor order, first match wins (Python)
 * - `implements-split`: BFS ancestor walk, first match wins (Java/C#) —
 *                        full ambiguity detection for multiple interface defaults
 *                        is handled by computeMRO at graph level
 * - `qualified-syntax`: No auto-resolution (Rust) — returns undefined
 *
 * Delegates to mro-processor.ts c3Linearize for C3 strategy.
 *
 * @internal Exported only to enable unit testing in isolation. The proper
 * entry point for callers outside this module is {@link resolveMethodByOwner},
 * which handles receiver-type resolution before delegating here.
 */
export const lookupMethodByOwnerWithMRO = (
  ownerNodeId: string,
  methodName: string,
  heritageMap: HeritageMap,
  symbols: SymbolTable,
  language: SupportedLanguages,
  argCount?: number,
): SymbolDefinition | undefined => {
  // Direct lookup first (child override — no walk needed).
  // argCount is threaded through so arity-differing overloads on the direct
  // owner can be disambiguated before the MRO walk starts.
  const direct = symbols.lookupMethodByOwner(ownerNodeId, methodName, argCount);
  if (direct) return direct;

  const strategy = getProvider(language).mroStrategy;

  // Rust: requires qualified syntax (<Type as Trait>::method), no auto-resolution
  if (strategy === 'qualified-syntax') return undefined;

  // Determine ancestor walk order based on MRO strategy.
  // readonly to accept the cached (frozen) c3 linearization without copying.
  let ancestors: readonly string[];
  if (strategy === 'c3') {
    // Delegate to mro-processor.ts C3 linearization (memoized per HeritageMap
    // so repeated calls for the same owner within an ingestion run reuse the
    // linearization instead of rebuilding the parent map and re-running C3).
    // c3Linearize returns ancestors only (excludes the owner itself),
    // matching heritageMap.getAncestors() semantics.
    const c3Result = getCachedC3Linearization(ownerNodeId, heritageMap);
    // Fall back to BFS order if C3 fails (cyclic or inconsistent hierarchy).
    // Note: BFS order may not preserve Python MRO semantics in these edge
    // cases, but cyclic/inconsistent hierarchies are invalid in Python anyway.
    ancestors = c3Result ?? heritageMap.getAncestors(ownerNodeId);
  } else {
    // first-wins, leftmost-base, implements-split: BFS order via HeritageMap
    ancestors = heritageMap.getAncestors(ownerNodeId);
  }

  // Walk ancestors in MRO order — first match wins.
  // argCount narrows overloaded ancestors the same way as the direct lookup.
  for (const ancestorId of ancestors) {
    const method = symbols.lookupMethodByOwner(ancestorId, methodName, argCount);
    if (method) return method;
  }

  return undefined;
};

/**
 * Create a deduplicated ACCESSES edge emitter for a single source node.
 * Each (sourceId, fieldNodeId) pair is emitted at most once per source.
 */
const makeAccessEmitter = (graph: KnowledgeGraph, sourceId: string): OnFieldResolved => {
  const emitted = new Set<string>();
  return (fieldNodeId: string): void => {
    const key = `${sourceId}\0${fieldNodeId}`;
    if (emitted.has(key)) return;
    emitted.add(key);

    graph.addRelationship({
      id: generateId('ACCESSES', `${sourceId}:${fieldNodeId}:read`),
      sourceId,
      targetId: fieldNodeId,
      type: 'ACCESSES',
      confidence: 1.0,
      reason: 'read',
    });
  };
};

/**
 * Walk a pre-built mixed chain of field/call steps, threading the current type
 * through each step and returning the final resolved type.
 *
 * Returns `undefined` if any step cannot be resolved (chain is broken).
 * The caller is responsible for seeding `startType` from its own context
 * (TypeEnv, constructor bindings, or static-class fallback).
 */
type OnFieldResolved = (fieldNodeId: string) => void;

const walkMixedChain = (
  chain: MixedChainStep[],
  startType: string,
  filePath: string,
  ctx: ResolutionContext,
  onFieldResolved?: OnFieldResolved,
  heritageMap?: HeritageMap,
): string | undefined => {
  let currentType: string | undefined = startType;
  for (const step of chain) {
    if (!currentType) break;
    if (step.kind === 'field') {
      const resolved = resolveFieldAccessType(currentType, step.name, filePath, ctx);
      if (!resolved) {
        currentType = undefined;
        break;
      }
      onFieldResolved?.(resolved.fieldNodeId);
      currentType = resolved.typeName;
    } else {
      // Ruby/Python: property access is syntactically identical to method calls.
      // Try field resolution first — if the name is a known property with declaredType,
      // use that type directly. Otherwise fall back to method call resolution.
      const fieldResolved = resolveFieldAccessType(currentType, step.name, filePath, ctx);
      if (fieldResolved) {
        onFieldResolved?.(fieldResolved.fieldNodeId);
        currentType = fieldResolved.typeName;
        continue;
      }
      // Fast path: O(1) owner-scoped method lookup via methodByOwner index.
      // Note: CALLS edges for intermediate chain steps are NOT emitted here — walkMixedChain
      // only threads types. CALLS edges come from the outer per-call-expression loop in processCalls.
      //
      // We call `resolveMethodByOwner` directly (NOT `resolveMemberCall`) because this is
      // a hot path — called per chain step per call expression — and we only need the
      // return type string. Going through `resolveMemberCall` would allocate a throwaway
      // `ResolveResult` with confidence/reason that we immediately discard.
      const owned = resolveMethodByOwner(currentType, step.name, filePath, ctx, heritageMap);
      if (owned?.def.returnType) {
        const fastRetType = extractReturnTypeName(owned.def.returnType);
        if (fastRetType) {
          currentType = fastRetType;
          continue;
        }
      }
      // Fallback: fuzzy resolution via resolveCallTarget (cross-file, inherited, etc.)
      const resolved = resolveCallTarget(
        { calledName: step.name, callForm: 'member', receiverTypeName: currentType },
        filePath,
        ctx,
        undefined,
        undefined,
        undefined,
        heritageMap,
      );
      if (!resolved) {
        // Stdlib passthrough: unwrap(), clone(), etc. preserve the receiver type
        if (TYPE_PRESERVING_METHODS.has(step.name)) continue;
        currentType = undefined;
        break;
      }
      if (!resolved.returnType) {
        currentType = undefined;
        break;
      }
      const retType = extractReturnTypeName(resolved.returnType);
      if (!retType) {
        currentType = undefined;
        break;
      }
      currentType = retType;
    }
  }
  return currentType;
};

/**
 * Fast path: resolve pre-extracted call sites from workers.
 * No AST parsing — workers already extracted calledName + sourceId.
 */
export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  constructorBindings?: FileConstructorBindings[],
  heritageMap?: HeritageMap,
) => {
  // Scope-aware receiver types: keyed by filePath → "funcName\0varName" → typeName.
  // The scope dimension prevents collisions when two functions in the same file
  // have same-named locals pointing to different constructor types.
  const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
  if (constructorBindings) {
    for (const { filePath, bindings } of constructorBindings) {
      const verified = verifyConstructorBindings(bindings, filePath, ctx, graph);
      if (verified.size > 0) {
        fileReceiverTypes.set(filePath, buildReceiverTypeIndex(verified));
      }
    }
  }

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

  for (const [filePath, calls] of byFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    ctx.enableCache(filePath);
    const widenCache: WidenCache = new Map();
    const receiverMap = fileReceiverTypes.get(filePath);

    for (const call of calls) {
      let effectiveCall = call;

      // Step 1: resolve receiver type from constructor bindings
      if (!call.receiverTypeName && call.receiverName && receiverMap) {
        const callFuncName = extractFuncNameFromSourceId(call.sourceId);
        const resolvedType = lookupReceiverType(receiverMap, callFuncName, call.receiverName);
        if (resolvedType) {
          effectiveCall = { ...call, receiverTypeName: resolvedType };
        }
      }

      // Step 1b: class-as-receiver for static method calls (e.g. UserService.find_user())
      if (
        !effectiveCall.receiverTypeName &&
        effectiveCall.receiverName &&
        effectiveCall.callForm === 'member'
      ) {
        const typeResolved = ctx.resolve(effectiveCall.receiverName, effectiveCall.filePath);
        if (
          typeResolved &&
          typeResolved.candidates.some(
            (d) =>
              d.type === 'Class' ||
              d.type === 'Interface' ||
              d.type === 'Struct' ||
              d.type === 'Enum',
          )
        ) {
          effectiveCall = { ...effectiveCall, receiverTypeName: effectiveCall.receiverName };
        }
      }

      // Step 1c: mixed chain resolution (field, call, or interleaved — e.g. svc.getUser().address.save()).
      // Runs whenever receiverMixedChain is present. Steps 1/1b may have resolved the base receiver
      // type already; that type is used as the chain's starting point.
      if (effectiveCall.receiverMixedChain?.length) {
        // Use the already-resolved base type (from Steps 1/1b) or look it up now.
        let currentType: string | undefined = effectiveCall.receiverTypeName;
        if (!currentType && effectiveCall.receiverName && receiverMap) {
          const callFuncName = extractFuncNameFromSourceId(effectiveCall.sourceId);
          currentType = lookupReceiverType(receiverMap, callFuncName, effectiveCall.receiverName);
        }
        if (!currentType && effectiveCall.receiverName) {
          const typeResolved = ctx.resolve(effectiveCall.receiverName, effectiveCall.filePath);
          if (
            typeResolved?.candidates.some(
              (d) =>
                d.type === 'Class' ||
                d.type === 'Interface' ||
                d.type === 'Struct' ||
                d.type === 'Enum',
            )
          ) {
            currentType = effectiveCall.receiverName;
          }
        }
        if (currentType) {
          const walkedType = walkMixedChain(
            effectiveCall.receiverMixedChain,
            currentType,
            effectiveCall.filePath,
            ctx,
            makeAccessEmitter(graph, effectiveCall.sourceId),
            heritageMap,
          );
          if (walkedType) {
            effectiveCall = { ...effectiveCall, receiverTypeName: walkedType };
          }
        }
      }

      const resolved = resolveCallTarget(
        effectiveCall,
        effectiveCall.filePath,
        ctx,
        undefined,
        widenCache,
        effectiveCall.argTypes,
        heritageMap,
      );
      if (!resolved) {
        // Vue template component fallback: match calledName against imported .vue basenames
        if (effectiveCall.filePath.endsWith('.vue') && effectiveCall.sourceId.startsWith('File:')) {
          const importedFiles = ctx.importMap.get(effectiveCall.filePath);
          if (importedFiles) {
            for (const importedPath of importedFiles) {
              if (!importedPath.endsWith('.vue')) continue;
              const basename = importedPath.slice(
                importedPath.lastIndexOf('/') + 1,
                importedPath.lastIndexOf('.'),
              );
              if (basename !== effectiveCall.calledName) continue;
              const targetFileId = generateId('File', importedPath);
              if (graph.getNode(targetFileId)) {
                graph.addRelationship({
                  id: generateId(
                    'CALLS',
                    `${effectiveCall.sourceId}:${effectiveCall.calledName}->${targetFileId}`,
                  ),
                  sourceId: effectiveCall.sourceId,
                  targetId: targetFileId,
                  type: 'CALLS',
                  confidence: 0.9,
                  reason: 'vue-template-component',
                });
              }
              break;
            }
          }
        }
        continue;
      }

      const relId = generateId(
        'CALLS',
        `${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}`,
      );
      graph.addRelationship({
        id: relId,
        sourceId: effectiveCall.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });

      if (heritageMap && effectiveCall.callForm === 'member' && effectiveCall.receiverTypeName) {
        const implTargets = findInterfaceDispatchTargets(
          effectiveCall.calledName,
          effectiveCall.receiverTypeName,
          effectiveCall.filePath,
          ctx,
          heritageMap,
          resolved.nodeId,
        );
        for (const impl of implTargets) {
          graph.addRelationship({
            id: generateId(
              'CALLS',
              `${effectiveCall.sourceId}:${effectiveCall.calledName}->${impl.nodeId}`,
            ),
            sourceId: effectiveCall.sourceId,
            targetId: impl.nodeId,
            type: 'CALLS',
            confidence: impl.confidence,
            reason: impl.reason,
          });
        }
      }
    }

    ctx.clearCache();
  }

  onProgress?.(totalFiles, totalFiles);
};

/**
 * Resolve pre-extracted field write assignments to ACCESSES {reason: 'write'} edges.
 * Accepts optional constructorBindings for return-type-aware receiver inference,
 * mirroring processCallsFromExtracted's verified binding lookup.
 */
export const processAssignmentsFromExtracted = (
  graph: KnowledgeGraph,
  assignments: ExtractedAssignment[],
  ctx: ResolutionContext,
  constructorBindings?: FileConstructorBindings[],
): void => {
  // Build per-file receiver type indexes from verified constructor bindings
  const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
  if (constructorBindings) {
    for (const { filePath, bindings } of constructorBindings) {
      const verified = verifyConstructorBindings(bindings, filePath, ctx, graph);
      if (verified.size > 0) {
        fileReceiverTypes.set(filePath, buildReceiverTypeIndex(verified));
      }
    }
  }

  for (const asn of assignments) {
    // Resolve the receiver type
    let receiverTypeName = asn.receiverTypeName;
    // Tier 2: verified constructor bindings (return-type inference)
    if (!receiverTypeName && fileReceiverTypes.size > 0) {
      const receiverMap = fileReceiverTypes.get(asn.filePath);
      if (receiverMap) {
        const funcName = extractFuncNameFromSourceId(asn.sourceId);
        receiverTypeName = lookupReceiverType(receiverMap, funcName, asn.receiverText);
      }
    }
    // Tier 3: static class-as-receiver fallback
    if (!receiverTypeName) {
      const resolved = ctx.resolve(asn.receiverText, asn.filePath);
      if (resolved?.candidates.some((d) => CLASS_LIKE_TYPES.has(d.type))) {
        receiverTypeName = asn.receiverText;
      }
    }
    if (!receiverTypeName) continue;
    const fieldOwner = resolveFieldOwnership(receiverTypeName, asn.propertyName, asn.filePath, ctx);
    if (!fieldOwner) continue;
    graph.addRelationship({
      id: generateId('ACCESSES', `${asn.sourceId}:${fieldOwner.nodeId}:write`),
      sourceId: asn.sourceId,
      targetId: fieldOwner.nodeId,
      type: 'ACCESSES',
      confidence: 1.0,
      reason: 'write',
    });
  }
};

/**
 * Resolve pre-extracted Laravel routes to CALLS edges from route files to controller methods.
 */
export const processRoutesFromExtracted = async (
  graph: KnowledgeGraph,
  extractedRoutes: ExtractedRoute[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
) => {
  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
    if (!controllerResolved || controllerResolved.candidates.length === 0) continue;
    if (controllerResolved.tier === 'global' && controllerResolved.candidates.length > 1) continue;

    const controllerDef = controllerResolved.candidates[0];
    const confidence = TIER_CONFIDENCE[controllerResolved.tier];

    const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
    const methodId =
      methodResolved?.tier === 'same-file' ? methodResolved.candidates[0]?.nodeId : undefined;
    const sourceId = generateId('File', route.filePath);

    if (!methodId) {
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
 * Extract property access keys from a consumer file's source code near fetch calls.
 *
 * Looks for three patterns after a fetch/response variable assignment:
 * 1. Destructuring: `const { data, pagination } = await res.json()`
 * 2. Property access: `response.data`, `result.items`
 * 3. Optional chaining: `data?.key1?.key2`
 *
 * Returns deduplicated top-level property names accessed on the response.
 *
 * NOTE: This scans the entire file content, not just code near a specific fetch call.
 * If a file has multiple fetch calls to different routes, all accessed keys are
 * attributed to each fetch. This is an acceptable tradeoff for regex-based extraction.
 */

/** Common method names on response/data objects that are NOT property accesses */
// Properties/methods to ignore when extracting consumer accessed keys from `data.X` patterns.
// Avoids false positives from Fetch API, Array, Object, Promise, and DOM access on variables
// that happen to share names with response variables (data, result, response, etc.).
const RESPONSE_ACCESS_BLOCKLIST = new Set([
  // Fetch/Response API
  'json',
  'text',
  'blob',
  'arrayBuffer',
  'formData',
  'ok',
  'status',
  'headers',
  'clone',
  // Promise
  'then',
  'catch',
  'finally',
  // Array
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'sort',
  'reverse',
  'includes',
  'indexOf',
  // Object
  'length',
  'toString',
  'valueOf',
  'keys',
  'values',
  'entries',
  // DOM methods — file-download patterns often reuse `data`/`response` variable names
  'appendChild',
  'removeChild',
  'insertBefore',
  'replaceChild',
  'replaceChildren',
  'createElement',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'setAttribute',
  'getAttribute',
  'removeAttribute',
  'hasAttribute',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'classList',
  'className',
  'parentNode',
  'parentElement',
  'childNodes',
  'children',
  'nextSibling',
  'previousSibling',
  'firstChild',
  'lastChild',
  'click',
  'focus',
  'blur',
  'submit',
  'reset',
  'innerHTML',
  'outerHTML',
  'textContent',
  'innerText',
]);

export const extractConsumerAccessedKeys = (content: string): string[] => {
  const keys = new Set<string>();

  // Pattern 1: Destructuring from .json() — const { key1, key2 } = await res.json()
  // Also matches: const { key1, key2 } = await (await fetch(...)).json()
  const destructurePattern =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:await\s+)?(?:\w+\.json\s*\(\)|(?:await\s+)?(?:fetch|axios|got)\s*\([^)]*\)(?:\.then\s*\([^)]*\))?(?:\.json\s*\(\))?)/g;
  let match;
  while ((match = destructurePattern.exec(content)) !== null) {
    const destructuredBody = match[1];
    // Extract identifiers from destructuring, handling renamed bindings (key: alias)
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  // Pattern 2: Destructuring from a data/result/response/json variable
  // e.g., const { items, total } = data; or const { error } = result;
  const dataVarDestructure =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:data|result|response|json|body|res)\b/g;
  while ((match = dataVarDestructure.exec(content)) !== null) {
    const destructuredBody = match[1];
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  // Pattern 3: Property access on common response variable names
  // Matches: data.key, response.key, result.key, json.key, body.key
  // Also matches optional chaining: data?.key
  const propAccessPattern = /\b(?:data|response|result|json|body|res)\s*(?:\?\.|\.)(\w+)/g;
  while ((match = propAccessPattern.exec(content)) !== null) {
    const key = match[1];
    // Skip common method calls that aren't property accesses
    if (!RESPONSE_ACCESS_BLOCKLIST.has(key)) {
      keys.add(key);
    }
  }

  return [...keys];
};

/**
 * Create FETCHES edges from extracted fetch() calls to matching Route nodes.
 * When consumerContents is provided, extracts property access patterns from
 * consumer files and encodes them in the edge reason field.
 */
export const processNextjsFetchRoutes = (
  graph: KnowledgeGraph,
  fetchCalls: ExtractedFetchCall[],
  routeRegistry: Map<string, string>, // routeURL → handlerFilePath
  consumerContents?: Map<string, string>, // filePath → file content
) => {
  // Pre-count how many routes each consumer file matches (for confidence attribution)
  const routeCountByFile = new Map<string, number>();
  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;
    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        routeCountByFile.set(call.filePath, (routeCountByFile.get(call.filePath) ?? 0) + 1);
        break;
      }
    }
  }

  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;

    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        const sourceId = generateId('File', call.filePath);
        const routeNodeId = generateId('Route', routeURL);

        // Extract consumer accessed keys if file content is available
        let reason = 'fetch-url-match';
        if (consumerContents) {
          const content = consumerContents.get(call.filePath);
          if (content) {
            const accessedKeys = extractConsumerAccessedKeys(content);
            if (accessedKeys.length > 0) {
              reason = `fetch-url-match|keys:${accessedKeys.join(',')}`;
            }
          }
        }

        // Encode multi-fetch count so downstream can set confidence
        const fetchCount = routeCountByFile.get(call.filePath) ?? 1;
        if (fetchCount > 1) {
          reason = `${reason}|fetches:${fetchCount}`;
        }

        graph.addRelationship({
          id: generateId('FETCHES', `${sourceId}->${routeNodeId}`),
          sourceId,
          targetId: routeNodeId,
          type: 'FETCHES',
          confidence: 0.9,
          reason,
        });
        break;
      }
    }
  }
};

/**
 * Extract fetch() calls from source files (sequential path).
 * Workers handle this via tree-sitter captures in parse-worker; this function
 * provides the same extraction for the sequential fallback path.
 */
export const extractFetchCallsFromFiles = async (
  files: { path: string; content: string }[],
  astCache: ASTCache,
): Promise<ExtractedFetchCall[]> => {
  const parser = await loadParser();
  const result: ExtractedFetchCall[] = [];

  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) continue;

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
      } catch {
        continue;
      }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => (captureMap[c.name] = c.node));

      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row,
          });
        }
      } else if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        const HTTP_CLIENT_ONLY = new Set(['head', 'options', 'request', 'ajax']);
        if (method && HTTP_CLIENT_ONLY.has(method) && url.startsWith('/')) {
          result.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
      }
    }
  }

  return result;
};
