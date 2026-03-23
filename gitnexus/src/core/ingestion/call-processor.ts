import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition, SymbolTable } from './symbol-table.js';
import Parser from 'tree-sitter';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE, type ResolutionTier } from './resolution-context.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
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
  extractReceiverNode,
  findEnclosingClassId,
  CALL_EXPRESSION_TYPES,
  extractMixedChain,
  type MixedChainStep,
} from './utils.js';
import { buildTypeEnv, isSubclassOf } from './type-env.js';
import type { ConstructorBinding } from './type-env.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedCall, ExtractedAssignment, ExtractedHeritage, ExtractedRoute, FileConstructorBindings } from './workers/parse-worker.js';
import { callRouters } from './call-routing.js';
import { extractReturnTypeName, stripNullable } from './type-extractors/shared.js';
import { typeConfigs } from './type-extractors/index.js';
import type { LiteralTypeInferrer } from './type-extractors/types.js';
import type { SyntaxNode } from './utils.js';

/** Per-file resolved type bindings for exported symbols.
 *  Populated during call processing, consumed by Phase 14 re-resolution pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

const MAX_EXPORTS_PER_FILE = 500;
const MAX_TYPE_NAME_LENGTH = 256;

/** Build a map of imported callee names → return types for cross-file call-result binding.
 *  Consulted ONLY when SymbolTable has no unambiguous local match (local-first principle). */
export function buildImportedReturnTypes(
  filePath: string,
  namedImportMap: ReadonlyMap<string, ReadonlyMap<string, { sourcePath: string; exportedName: string }>>,
  symbolTable: { lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined },
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
  namedImportMap: ReadonlyMap<string, ReadonlyMap<string, { sourcePath: string; exportedName: string }>>,
  symbolTable: { lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined },
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
  typeEnv: { readonly env: ReadonlyMap<string, ReadonlyMap<string, string>> },
  filePath: string,
  symbolTable: { lookupExact(filePath: string, name: string): string | undefined },
  graph: { getNode(id: string): { properties?: { isExported?: boolean } } | undefined },
): Map<string, string> | null {
  const fileScope = typeEnv.env.get('');
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
  graph.forEachNode(node => {
    if (!node.properties?.isExported) return;
    if (!node.properties?.filePath || !node.properties?.name) return;
    const filePath = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;
    // For callable symbols, use returnType; for properties/variables, use declaredType
    const def = symbolTable.lookupExactFull(filePath, name);
    if (!def) return;
    const typeName = def.returnType ?? def.declaredType;
    if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;
    // Extract simple type name (strip Promise<>, etc.) — reuse shared utility
    const simpleType = extractReturnTypeName(typeName) ?? typeName;
    if (!simpleType) return;
    let fileExports = result.get(filePath);
    if (!fileExports) { fileExports = new Map(); result.set(filePath, fileExports); }
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
  namedImportMap: ReadonlyMap<string, ReadonlyMap<string, { sourcePath: string; exportedName: string }>>,
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
  'unwrap', 'expect', 'unwrap_or', 'unwrap_or_default', 'unwrap_or_else',  // Rust Option/Result
  'clone', 'to_owned', 'as_ref', 'as_mut', 'borrow', 'borrow_mut',        // Rust clone/borrow
  'get',                                                                     // Kotlin/Java Optional.get()
  'orElseThrow',                                                             // Java Optional
]);

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
const findEnclosingFunction = (
  node: SyntaxNode,
  filePath: string,
  ctx: ResolutionContext
): string | null => {
  let current = node.parent;

  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);

      if (funcName) {
        const resolved = ctx.resolve(funcName, filePath);
        if (resolved?.tier === 'same-file' && resolved.candidates.length > 0) {
          return resolved.candidates[0].nodeId;
        }

        return generateId(label, `${filePath}:${funcName}`);
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
    const isClass = tiered?.candidates.some(def => def.type === 'Class') ?? false;

    if (isClass) {
      verified.set(receiverKey(scope, varName), calleeName);
    } else {
      let callableDefs = tiered?.candidates.filter(d =>
        d.type === 'Function' || d.type === 'Method'
      );

      // When receiver class is known (e.g. $this->method() in PHP), narrow
      // candidates to methods owned by that class to avoid false disambiguation failures.
      if (callableDefs && callableDefs.length > 1 && receiverClassName) {
        if (graph) {
          // Worker path: use graph.getNode (fast, already in-memory)
          const narrowed = callableDefs.filter(d => {
            if (!d.ownerId) return false;
            const owner = graph.getNode(d.ownerId);
            return owner?.properties.name === receiverClassName;
          });
          if (narrowed.length > 0) callableDefs = narrowed;
        } else {
          // Sequential path: use ctx.resolve (no graph available)
          const classResolved = ctx.resolve(receiverClassName, filePath);
          if (classResolved && classResolved.candidates.length > 0) {
            const classNodeIds = new Set(classResolved.candidates.map(c => c.nodeId));
            const narrowed = callableDefs.filter(d =>
              d.ownerId && classNodeIds.has(d.ownerId)
            );
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
): Promise<ExtractedHeritage[]> => {
  const parser = await loadParser();
  const collectedHeritage: ExtractedHeritage[] = [];
  const pendingWrites: { receiverTypeName: string; propertyName: string; filePath: string; srcId: string }[] = [];
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

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
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

    const lang = getLanguageFromFilename(file.path);

    // Pre-pass: extract heritage from query matches to build parentMap for buildTypeEnv.
    // Heritage-processor runs in PARALLEL, so graph edges don't exist when buildTypeEnv runs.
    const fileParentMap = new Map<string, string[]>();
    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className: string = captureMap['heritage.class'].text;
        const parentName: string = captureMap['heritage.extends'].text;
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name')) continue;
        let parents = fileParentMap.get(className);
        if (!parents) { parents = []; fileParentMap.set(className, parents); }
        if (!parents.includes(parentName)) parents.push(parentName);
      }
    }
    const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
    // Merge per-file heritage into globalParentMap for cross-file isSubclassOf lookups.
    // Uses a parallel Set (globalParentSeen) for O(1) deduplication instead of O(n) includes().
    for (const [cls, parents] of fileParentMap) {
      let global = globalParentMap.get(cls);
      let seen = globalParentSeen.get(cls);
      if (!global) { global = []; globalParentMap.set(cls, global); }
      if (!seen) { seen = new Set(); globalParentSeen.set(cls, seen); }
      for (const p of parents) {
        if (!seen.has(p)) { seen.add(p); global.push(p); }
      }
    }

    const importedBindings = importedBindingsMap?.get(file.path);
    const importedReturnTypes = importedReturnTypesMap?.get(file.path);
    const importedRawReturnTypes = importedRawReturnTypesMap?.get(file.path);
    const typeEnv = lang ? buildTypeEnv(tree, lang, { symbolTable: ctx.symbols, parentMap, importedBindings, importedReturnTypes, importedRawReturnTypes }) : null;
    if (typeEnv && exportedTypeMap) {
      const fileExports = collectExportedBindings(typeEnv, file.path, ctx.symbols, graph);
      if (fileExports) exportedTypeMap.set(file.path, fileExports);
    }
    const callRouter = callRouters[language];

    const verifiedReceivers = typeEnv && typeEnv.constructorBindings.length > 0
      ? verifyConstructorBindings(typeEnv.constructorBindings, file.path, ctx)
      : new Map<string, string>();
    const receiverIndex = buildReceiverTypeIndex(verifiedReceivers);

    ctx.enableCache(file.path);

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);
      // ── Write access: emit ACCESSES {reason: 'write'} for assignments to member fields ──
      if (captureMap['assignment'] && captureMap['assignment.receiver'] && captureMap['assignment.property']) {
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
          const enclosing = findEnclosingFunction(captureMap['assignment'], file.path, ctx);
          const funcName = enclosing ? extractFuncNameFromSourceId(enclosing) : '';
          receiverTypeName = lookupReceiverType(receiverIndex, funcName, receiverText);
        }
        if (!receiverTypeName && receiverText) {
          const resolved = ctx.resolve(receiverText, file.path);
          if (resolved?.candidates.some(d =>
            d.type === 'Class' || d.type === 'Struct' || d.type === 'Interface'
              || d.type === 'Enum' || d.type === 'Record' || d.type === 'Impl',
          )) {
            receiverTypeName = receiverText;
          }
        }
        if (receiverTypeName) {
          const enclosing = findEnclosingFunction(captureMap['assignment'], file.path, ctx);
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

      const nameNode = captureMap['call.name'];
      if (!nameNode) return;

      const calledName = nameNode.text;

      const routed = callRouter(calledName, captureMap['call']);
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
                  name: item.propName, filePath: file.path,
                  startLine: item.startLine, endLine: item.endLine,
                  language, isExported: true,
                  description: item.accessorType,
                },
              });
              ctx.symbols.add(file.path, item.propName, nodeId, 'Property', {
                ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                ...(item.declaredType ? { declaredType: item.declaredType } : {}),
              });
              const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
              graph.addRelationship({
                id: relId, sourceId: fileId, targetId: nodeId,
                type: 'DEFINES', confidence: 1.0, reason: '',
              });
              if (propEnclosingClassId) {
                graph.addRelationship({
                  id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                  sourceId: propEnclosingClassId, targetId: nodeId,
                  type: 'HAS_PROPERTY', confidence: 1.0, reason: '',
                });
              }
            }
            return;
          }

          case 'call':
            break;
        }
      }

      if (isBuiltInOrNoise(calledName)) return;

      const callNode = captureMap['call'];
      const callForm = inferCallForm(callNode, nameNode);
      const receiverName = callForm === 'member' ? extractReceiverName(nameNode) : undefined;
      let receiverTypeName = receiverName && typeEnv ? typeEnv.lookup(receiverName, callNode) : undefined;
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
            const { funcName } = extractFunctionName(p);
            if (funcName) { scope = `${funcName}@${p.startIndex}`; break; }
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
          if (isSubclassOf(ctorType, receiverTypeName, parentMap)
            || isSubclassOf(ctorType, receiverTypeName, globalParentMap)
            || (ctx.symbols.lookupFuzzy(ctorType).some(d => d.type === 'Class' || d.type === 'Struct')
              && ctx.symbols.lookupFuzzy(receiverTypeName).some(d => d.type === 'Class' || d.type === 'Struct' || d.type === 'Interface'))) {
            receiverTypeName = ctorType;
          }
        }
      }
      // Fall back to verified constructor bindings for return type inference
      if (!receiverTypeName && receiverName && receiverIndex.size > 0) {
        const enclosingFunc = findEnclosingFunction(callNode, file.path, ctx);
        const funcName = enclosingFunc ? extractFuncNameFromSourceId(enclosingFunc) : '';
        receiverTypeName = lookupReceiverType(receiverIndex, funcName, receiverName);
      }
      // Fall back to class-as-receiver for static method calls (e.g. UserService.find_user()).
      // When the receiver name is not a variable in TypeEnv but resolves to a Class/Struct/Interface
      // through the standard tiered resolution, use it directly as the receiver type.
      if (!receiverTypeName && receiverName && callForm === 'member') {
        const typeResolved = ctx.resolve(receiverName, file.path);
        if (typeResolved && typeResolved.candidates.some(
          d => d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
        )) {
          receiverTypeName = receiverName;
        }
      }
      // Hoist sourceId so it's available for ACCESSES edge emission during chain walk.
      const enclosingFuncId = findEnclosingFunction(callNode, file.path, ctx);
      const sourceId = enclosingFuncId || generateId('File', file.path);

      // Fall back to mixed chain resolution when the receiver is a complex expression
      // (field chain, call chain, or interleaved — e.g. user.address.city.save() or
      // svc.getUser().address.save()). Handles all cases with a single unified walk.
      if (callForm === 'member' && !receiverTypeName && !receiverName) {
        const receiverNode = extractReceiverNode(nameNode);
        if (receiverNode) {
          const extracted = extractMixedChain(receiverNode);
          if (extracted && extracted.chain.length > 0) {
            let currentType = extracted.baseReceiverName && typeEnv
              ? typeEnv.lookup(extracted.baseReceiverName, callNode)
              : undefined;
            if (!currentType && extracted.baseReceiverName && receiverIndex.size > 0) {
              const funcName = enclosingFuncId ? extractFuncNameFromSourceId(enclosingFuncId) : '';
              currentType = lookupReceiverType(receiverIndex, funcName, extracted.baseReceiverName);
            }
            if (!currentType && extracted.baseReceiverName) {
              const cr = ctx.resolve(extracted.baseReceiverName, file.path);
              if (cr?.candidates.some(d =>
                d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
              )) {
                currentType = extracted.baseReceiverName;
              }
            }
            if (currentType) {
              receiverTypeName = walkMixedChain(
                extracted.chain, currentType, file.path, ctx,
                makeAccessEmitter(graph, sourceId),
              );
            }
          }
        }
      }

      // Build overload hints for languages with inferLiteralType (Java/Kotlin/C#/C++).
      // Only used when multiple candidates survive arity filtering — ~1-3% of calls.
      const langConfig = lang ? typeConfigs[lang as keyof typeof typeConfigs] : undefined;
      const hints: OverloadHints | undefined = langConfig?.inferLiteralType
        ? { callNode, inferLiteralType: langConfig.inferLiteralType }
        : undefined;

      const resolved = resolveCallTarget({
        calledName,
        argCount: countCallArguments(callNode),
        callForm,
        receiverTypeName,
      }, file.path, ctx, hints);

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
    });

    ctx.clearCache();
  }

  // ── Resolve deferred write-access edges ──
  // All properties (including Ruby attr_accessor) are now registered.
  for (const pw of pendingWrites) {
    const fieldOwner = resolveFieldOwnership(pw.receiverTypeName, pw.propertyName, pw.filePath, ctx);
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
  confidence: number;
  reason: string;
  returnType?: string;
}

const CALLABLE_SYMBOL_TYPES = new Set([
  'Function',
  'Method',
  'Constructor',
  'Macro',
  'Delegate',
]);

const CONSTRUCTOR_TARGET_TYPES = new Set(['Constructor', 'Class', 'Struct', 'Record']);

const filterCallableCandidates = (
  candidates: readonly SymbolDefinition[],
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
): SymbolDefinition[] => {
  let kindFiltered: SymbolDefinition[];

  if (callForm === 'constructor') {
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
    candidate.parameterCount === undefined
    || (argCount >= (candidate.requiredParameterCount ?? candidate.parameterCount)
      && argCount <= candidate.parameterCount)
  );
};

const toResolveResult = (
  definition: SymbolDefinition,
  tier: ResolutionTier,
): ResolveResult => ({
  nodeId: definition.nodeId,
  confidence: TIER_CONFIDENCE[tier],
  reason: tier === 'same-file' ? 'same-file' : tier === 'import-scoped' ? 'import-resolved' : 'global',
  returnType: definition.returnType,
});


/** Optional hints for overload disambiguation via argument literal types.
 *  Only available on the sequential path (has AST); worker path passes undefined. */
interface OverloadHints {
  callNode: SyntaxNode;
  inferLiteralType: LiteralTypeInferrer;
}

/**
 * Kotlin (and JVM in general) uses boxed type names in parameter declarations
 * (e.g. `Int`, `Long`, `Boolean`) while inferJvmLiteralType returns unboxed
 * primitives (`int`, `long`, `boolean`). Normalise both sides to lowercase so
 * that the comparison `'Int' === 'int'` does not fail.
 *
 * Only applied to single-word identifiers that look like a JVM primitive alias;
 * multi-word or qualified names are left untouched.
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

const normalizeJvmTypeName = (name: string): string =>
  KOTLIN_BOXED_TO_PRIMITIVE[name] ?? name;

/**
 * Try to disambiguate overloaded candidates using argument literal types.
 * Only invoked when filteredCandidates.length > 1 and at least one has parameterTypes.
 * Returns the single matching candidate, or null if ambiguous/inconclusive.
 */
const tryOverloadDisambiguation = (
  candidates: SymbolDefinition[],
  hints: OverloadHints,
): SymbolDefinition | null => {
  if (!candidates.some(c => c.parameterTypes)) return null;

  // Find the argument list node in the call expression.
  // Kotlin wraps value_arguments inside a call_suffix child, so we must also
  // search one level deeper when a direct match is not found.
  let argList: any = hints.callNode.childForFieldName?.('arguments')
    ?? hints.callNode.children.find((c: any) =>
      c.type === 'arguments' || c.type === 'argument_list' || c.type === 'value_arguments'
    );
  if (!argList) {
    // Kotlin: call_expression → call_suffix → value_arguments
    const callSuffix = hints.callNode.children.find((c: any) => c.type === 'call_suffix');
    if (callSuffix) {
      argList = callSuffix.children.find((c: any) => c.type === 'value_arguments');
    }
  }
  if (!argList) return null;

  const argTypes: (string | undefined)[] = [];
  for (const arg of argList.namedChildren) {
    if (arg.type === 'comment') continue;
    // Unwrap argument wrapper nodes before passing to inferLiteralType:
    //   - Kotlin value_argument: has 'value' field containing the literal
    //   - C# argument: has 'expression' field (handles named args like `name: "alice"`
    //     where firstNamedChild would return name_colon instead of the value)
    //   - Java/others: arg IS the literal directly (no unwrapping needed)
    const valueNode = arg.childForFieldName?.('value')
      ?? arg.childForFieldName?.('expression')
      ?? (arg.type === 'argument' || arg.type === 'value_argument'
        ? arg.firstNamedChild ?? arg
        : arg);
    argTypes.push(hints.inferLiteralType(valueNode));
  }

  // If no literal types could be inferred, can't disambiguate
  if (argTypes.every(t => t === undefined)) return null;

  const matched = candidates.filter(c => {
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
    const uniqueIds = new Set(matched.map(c => c.nodeId));
    if (uniqueIds.size === 1) return matched[0];
  }
  return null;
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
const resolveCallTarget = (
  call: Pick<ExtractedCall, 'calledName' | 'argCount' | 'callForm' | 'receiverTypeName'>,
  currentFile: string,
  ctx: ResolutionContext,
  overloadHints?: OverloadHints,
): ResolveResult | null => {
  const tiered = ctx.resolve(call.calledName, currentFile);
  if (!tiered) return null;

  const filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, call.callForm);

  // D. Receiver-type filtering: for member calls with a known receiver type,
  // resolve the type through the same tiered import infrastructure, then
  // filter method candidates to the type's defining file. Fall back to
  // fuzzy ownerId matching only when file-based narrowing is inconclusive.
  //
  // Applied regardless of candidate count — the sole same-file candidate may
  // belong to the wrong class (e.g. super.save() should hit the parent's save,
  // not the child's own save method in the same file).
  if (call.callForm === 'member' && call.receiverTypeName) {
    // D1. Resolve the receiver type
    const typeResolved = ctx.resolve(call.receiverTypeName, currentFile);
    if (typeResolved && typeResolved.candidates.length > 0) {
      const typeNodeIds = new Set(typeResolved.candidates.map(d => d.nodeId));
      const typeFiles = new Set(typeResolved.candidates.map(d => d.filePath));

      // D2. Widen candidates: same-file tier may miss the parent's method when
      //     it lives in another file. Query the symbol table directly for all
      //     global methods with this name, then apply arity/kind filtering.
      const methodPool = filteredCandidates.length <= 1
        ? filterCallableCandidates(ctx.symbols.lookupFuzzy(call.calledName), call.argCount, call.callForm)
        : filteredCandidates;

      // D3. File-based: prefer candidates whose filePath matches the resolved type's file
      const fileFiltered = methodPool.filter(c => typeFiles.has(c.filePath));
      if (fileFiltered.length === 1) {
        return toResolveResult(fileFiltered[0], tiered.tier);
      }

      // D4. ownerId fallback: narrow by ownerId matching the type's nodeId
      const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
      const ownerFiltered = pool.filter(c => c.ownerId && typeNodeIds.has(c.ownerId));
      if (ownerFiltered.length === 1) {
        return toResolveResult(ownerFiltered[0], tiered.tier);
      }
      // E. Try overload disambiguation on the narrowed pool
      if ((fileFiltered.length > 1 || ownerFiltered.length > 1) && overloadHints) {
        const overloadPool = ownerFiltered.length > 1 ? ownerFiltered : fileFiltered;
        const disambiguated = tryOverloadDisambiguation(overloadPool, overloadHints);
        if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
      }
      if (fileFiltered.length > 1 || ownerFiltered.length > 1) return null;
    }
  }

  // E. Overload disambiguation: when multiple candidates survive arity + receiver filtering,
  // try matching argument literal types against parameter types (Phase P).
  // Only available on sequential path (has AST); worker path falls through gracefully.
  if (filteredCandidates.length > 1 && overloadHints) {
    const disambiguated = tryOverloadDisambiguation(filteredCandidates, overloadHints);
    if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
  }

  if (filteredCandidates.length !== 1) return null;

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
const extractFuncNameFromScope = (scope: string): string =>
  scope.slice(0, scope.indexOf('@'));

/** Extract the trailing function name from a sourceId ("Function:filepath:funcName" → "funcName"). */
const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  return lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
};

/**
 * Build a composite key for receiver type storage.
 * Uses the full scope string (e.g. "save@100") to distinguish overloaded
 * methods with the same name in different classes.
 */
const receiverKey = (scope: string, varName: string): string =>
  `${scope}\0${varName}`;

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
    if (!varMap) { varMap = new Map(); index.set(funcName, varMap); }

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
  typeName: string;      // resolved declared type (continues chain threading)
  fieldNodeId: string;   // nodeId of the Property symbol (for ACCESSES edge target)
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
  const classDef = typeResolved.candidates.find(
    d => d.type === 'Class' || d.type === 'Struct' || d.type === 'Interface'
      || d.type === 'Enum' || d.type === 'Record' || d.type === 'Impl',
  );
  if (!classDef) return undefined;

  return ctx.symbols.lookupFieldByOwner(classDef.nodeId, fieldName) ?? undefined;
};

/**
 * Create a deduplicated ACCESSES edge emitter for a single source node.
 * Each (sourceId, fieldNodeId) pair is emitted at most once per source.
 */
const makeAccessEmitter = (
  graph: KnowledgeGraph,
  sourceId: string,
): OnFieldResolved => {
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
): string | undefined => {
  let currentType: string | undefined = startType;
  for (const step of chain) {
    if (!currentType) break;
    if (step.kind === 'field') {
      const resolved = resolveFieldAccessType(currentType, step.name, filePath, ctx);
      if (!resolved) { currentType = undefined; break; }
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
      const resolved = resolveCallTarget(
        { calledName: step.name, callForm: 'member', receiverTypeName: currentType },
        filePath,
        ctx,
      );
      if (!resolved) {
        // Stdlib passthrough: unwrap(), clone(), etc. preserve the receiver type
        if (TYPE_PRESERVING_METHODS.has(step.name)) continue;
        currentType = undefined; break;
      }
      if (!resolved.returnType) { currentType = undefined; break; }
      const retType = extractReturnTypeName(resolved.returnType);
      if (!retType) { currentType = undefined; break; }
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
    if (!list) { list = []; byFile.set(call.filePath, list); }
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
      if (!effectiveCall.receiverTypeName && effectiveCall.receiverName && effectiveCall.callForm === 'member') {
        const typeResolved = ctx.resolve(effectiveCall.receiverName, effectiveCall.filePath);
        if (typeResolved && typeResolved.candidates.some(
          d => d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
        )) {
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
          if (typeResolved?.candidates.some(d =>
            d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
          )) {
            currentType = effectiveCall.receiverName;
          }
        }
        if (currentType) {
          const walkedType = walkMixedChain(
            effectiveCall.receiverMixedChain, currentType, effectiveCall.filePath, ctx,
            makeAccessEmitter(graph, effectiveCall.sourceId),
          );
          if (walkedType) {
            effectiveCall = { ...effectiveCall, receiverTypeName: walkedType };
          }
        }
      }

      const resolved = resolveCallTarget(effectiveCall, effectiveCall.filePath, ctx);
      if (!resolved) continue;

      const relId = generateId('CALLS', `${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: effectiveCall.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
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
      if (resolved?.candidates.some(d =>
        d.type === 'Class' || d.type === 'Struct' || d.type === 'Interface'
          || d.type === 'Enum' || d.type === 'Record' || d.type === 'Impl',
      )) {
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
    const methodId = methodResolved?.tier === 'same-file' ? methodResolved.candidates[0]?.nodeId : undefined;
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
