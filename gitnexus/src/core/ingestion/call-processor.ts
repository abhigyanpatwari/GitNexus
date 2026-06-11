import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition, SymbolTable } from './symbol-table.js';
import Parser from 'tree-sitter';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE, type ResolutionTier } from './resolution-context.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, findEnclosingClassId } from './utils/ast-helpers.js';
import {
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
  type MixedChainStep,
} from './utils/call-analysis.js';
import { buildTypeEnv, isSubclassOf } from './type-env.js';
import type { ConstructorBinding } from './type-env.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedCall, ExtractedAssignment, ExtractedHeritage, ExtractedRoute, ExtractedFetchCall, ExtractedExpoNav, FileConstructorBindings, FileTypeEnvBindings, ExtractedORMQuery, ExtractedDecoratorRoute, ExtractedToolDef } from './workers/parse-worker.js';
import { extractPHPResponseShapes, extractResponseShapes } from './route-extractors/response-shapes.js';
import { normalizeFetchURL, routeMatches, nextjsFileToRouteURL } from './route-extractors/nextjs.js';
import { extractMiddlewareChain, extractNextjsMiddlewareConfig, compileMatcher, compiledMatcherMatchesRoute } from './route-extractors/middleware.js';
import { expoFileToRouteURL } from './route-extractors/expo.js';
import { phpFileToRouteURL } from './route-extractors/php.js';
import { extractReturnTypeName, stripNullable } from './type-extractors/shared.js';
import type { LiteralTypeInferrer } from './type-extractors/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

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
  ctx: ResolutionContext,
  provider: import('./language-provider.js').LanguageProvider,
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

        // Apply labelOverride so label matches the definition phase (single source of truth).
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        return generateId(finalLabel, `${filePath}:${funcName}`);
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        // Try SymbolTable first (same pattern as the FUNCTION_NODE_TYPES branch above).
        const resolved = ctx.resolve(customResult.funcName, filePath);
        if (resolved?.tier === 'same-file' && resolved.candidates.length > 0) {
          return resolved.candidates[0].nodeId;
        }
        let finalLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling!, finalLabel);
          if (override !== null) finalLabel = override;
        }
        return generateId(finalLabel, `${filePath}:${customResult.funcName}`);
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
  /**
   * WI-1 (#166 P3 Mode A) — optional LSP candidate feeds.
   *
   * Mirrors `processCallsFromExtracted`'s 7th positional arg byte-for-byte.
   * When `opts.lsp` is true, the active sequential emit site (`:623-652`)
   * pushes a `CorrectionFeedItem` on each `global`-0.50 winner and a
   * `RecallFeedItem` on every unresolved site, recording the callee
   * identifier position (`nameNode.startPosition.{row,column}`).
   *
   * Default `analyze` (no `--lsp`) leaves `opts` undefined; every push
   * is gated by `opts?.lsp`, so the hot path stays byte-identical.
   */
  opts?: ProcessCallsOpts,
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

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
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
    const typeEnv = buildTypeEnv(tree, language, { symbolTable: ctx.symbols, parentMap, importedBindings, importedReturnTypes, importedRawReturnTypes, enclosingFunctionFinder: provider?.enclosingFunctionFinder });
    if (typeEnv && exportedTypeMap) {
      const fileExports = collectExportedBindings(typeEnv, file.path, ctx.symbols, graph);
      if (fileExports) exportedTypeMap.set(file.path, fileExports);
    }
    const callRouter = provider.callRouter;

    const verifiedReceivers = typeEnv.constructorBindings.length > 0
      ? verifyConstructorBindings(typeEnv.constructorBindings, file.path, ctx)
      : new Map<string, string>();
    const receiverIndex = buildReceiverTypeIndex(verifiedReceivers);

    ctx.enableCache(file.path);
    const widenCache: WidenCache = new Map();

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
          const enclosing = findEnclosingFunction(captureMap['assignment'], file.path, ctx, provider);
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
          const enclosing = findEnclosingFunction(captureMap['assignment'], file.path, ctx, provider);
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
                source: 'heuristic',
              });
              if (propEnclosingClassId) {
                graph.addRelationship({
                  id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                  sourceId: propEnclosingClassId, targetId: nodeId,
                  type: 'HAS_PROPERTY', confidence: 1.0, reason: '',
                  source: 'heuristic',
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
        const enclosingFunc = findEnclosingFunction(callNode, file.path, ctx, provider);
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
      const langConfig = provider.typeConfig;
      const hints: OverloadHints | undefined = langConfig?.inferLiteralType
        ? { callNode, inferLiteralType: langConfig.inferLiteralType }
        : undefined;

      const resolved = resolveCallTarget({
        calledName,
        argCount: countCallArguments(callNode),
        callForm,
        receiverTypeName,
        receiverName,
      }, file.path, ctx, hints, widenCache);

      if (!resolved) {
        // WI-1 (#166 P3 Mode A) — push genuinely-unresolved site to recall
        // feed. Mirrors processCallsFromExtracted (:1447-1457) byte-for-byte
        // except we use `nameNode.startPosition.{row,column}` (always
        // present here — the `!nameNode` guard above at :460 already
        // returned) and `file.path`. The four earlier forEach early-returns
        // (router skip/import :469, heritage :480, properties :514,
        // isBuiltInName :522) correctly pre-filter non-call-targets, so
        // this site is a real call target with no heuristic winner.
        // Gated by opts?.lsp so default analyze stays byte-identical.
        if (opts?.lsp && opts.recallFeed) {
          opts.recallFeed.push({
            sourceId,
            calledName,
            file: file.path,
            line: nameNode.startPosition.row,
            character: nameNode.startPosition.column,
          });
        }
        return;
      }
      // WI-1 (#159) — line-aware CALLS id. The per-site
      // id embeds `nameNode.startPosition.row` so two same-name
      // calls in the same function (`a(); b(); a();`) mint TWO
      // distinct edges (previously one — silently rejected by
      // `graph.ts:14` id dedup). The `:L${row}` suffix mirrors
      // the COBOL convention (`cobol-processor.ts`).
      const callRow = nameNode.startPosition.row;
      const relId = generateId(
        'CALLS',
        `${sourceId}:${calledName}->${resolved.nodeId}:L${callRow}`,
      );

      // WI-1 (#166 P3 Mode A) — push `global`-0.50 winner to correction
      // feed. Mirrors processCallsFromExtracted (:1471-1480) byte-for-byte
      // (addRelationship still runs in the default path; the push is
      // additive and gated by opts?.lsp). The reconciler re-resolves it
      // via LSP and either confirms (same target), corrects (different
      // target), or refuses (non-callable / no node). The exact
      // heuristic id is carried as `oldRelId` so the engine can target
      // the right row when multiple per-site edges share the same
      // (sourceId, targetId) pair.
      if (opts?.lsp && opts.correctionFeed && resolved.reason === 'global') {
        opts.correctionFeed.push({
          sourceId,
          calledName,
          oldTargetId: resolved.nodeId,
          oldRelId: relId,
          file: file.path,
          line: callRow,
          character: nameNode.startPosition.column,
        });
      }

      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
        source: 'heuristic',
        line: callRow,
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
        source: 'heuristic',
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

/**
 * The set of symbol types that may be the target of a CALLS
 * edge. Exported for the Mode A reconciler (WI-4b, KD-3):
 * a mapped Location whose label is not in this set must NOT
 * mint a CALLS relationship (the callee-label precondition,
 * AC-4 / I-3).
 */
export { CALLABLE_SYMBOL_TYPES };

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
/** Per-file cache for the widen path's lookupFuzzy calls. Cleared between files. */
type WidenCache = Map<string, readonly SymbolDefinition[]>;

const resolveCallTarget = (
  call: Pick<ExtractedCall, 'calledName' | 'argCount' | 'callForm' | 'receiverTypeName' | 'receiverName'>,
  currentFile: string,
  ctx: ResolutionContext,
  overloadHints?: OverloadHints,
  widenCache?: WidenCache,
): ResolveResult | null => {
  const tiered = ctx.resolve(call.calledName, currentFile);
  if (!tiered) return null;

  let filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, call.callForm);

  // Swift/Kotlin: constructor calls look like free function calls (no `new` keyword).
  // If free-form filtering found no callable candidates but the symbol resolves to a
  // Class/Struct, retry with constructor form so CONSTRUCTOR_TARGET_TYPES applies.
  if (filteredCandidates.length === 0 && call.callForm === 'free') {
    const hasTypeTarget = tiered.candidates.some(c =>
      c.type === 'Class' || c.type === 'Struct' || c.type === 'Enum',
    );
    if (hasTypeTarget) {
      filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, 'constructor');
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
  if (call.callForm === 'member' && call.receiverName) {
    const aliasMap = ctx.moduleAliasMap?.get(currentFile);
    if (aliasMap) {
      const moduleFile = aliasMap.get(call.receiverName);
      if (moduleFile) {
        const aliasFiltered = filteredCandidates.filter(c => c.filePath === moduleFile);
        if (aliasFiltered.length > 0) {
          filteredCandidates = aliasFiltered;
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
          const widened = filterCallableCandidates(fuzzyDefs, call.argCount, call.callForm)
            .filter(c => c.filePath === moduleFile);
          if (widened.length > 0) filteredCandidates = widened;
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
      // D5. Interface implementation lookup: when D4 fails and the receiver type is an
      // interface, find concrete classes that implement it and filter candidates to those.
      const primaryCandidate = typeResolved.candidates[0];
      if (primaryCandidate.type === 'Interface' && ctx.findImplementations) {
        const implementerIds = ctx.findImplementations(typeNodeIds);
        if (implementerIds.size > 0) {
          const interfaceFiltered = pool.filter(c =>
            c.ownerId && implementerIds.has(c.ownerId),
          );
          if (interfaceFiltered.length === 1) {
            return toResolveResult(interfaceFiltered[0], tiered.tier);
          }
          // Multiple implementers - try overload disambiguation
          if (interfaceFiltered.length > 1 && overloadHints) {
            const disambiguated = tryOverloadDisambiguation(interfaceFiltered, overloadHints);
            if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
          }
        }
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

  if (filteredCandidates.length !== 1) {
    // Deduplicate: Swift extensions create multiple Class nodes with the same name.
    // When all candidates share the same type and differ only by file (extension vs
    // primary definition), they represent the same symbol. Prefer the primary
    // definition (shortest file path: Product.swift over ProductExtension.swift).
    if (filteredCandidates.length > 1) {
      const allSameType = filteredCandidates.every(c => c.type === filteredCandidates[0].type);
      if (allSameType && (filteredCandidates[0].type === 'Class' || filteredCandidates[0].type === 'Struct')) {
        const sorted = [...filteredCandidates].sort((a, b) => a.filePath.length - b.filePath.length);
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
      source: 'heuristic',
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
 * WI-2 — Mode A candidate feed (correction).
 *
 * A `global`-0.50 edge is the weakest heuristic resolution. Each entry captures
 * the call site (source node + called name + callee-identifier position) and the
 * old target id, so the reconciler can `textDocument/definition` at `line`/`character`
 * and either confirm, correct, or refuse.
 */
export interface CorrectionFeedItem {
  sourceId: string;
  calledName: string;
  /** Heuristic target id (the `global`-0.50 winner). Absent for ambiguous sites. */
  oldTargetId?: string;
  /**
   * Heuristic CALLS edge id for this exact call site
   * (`CALLS:${sourceId}:${calledName}->${resolved.nodeId}:L${row}`).
   * Carried into the candidate (`mode-a-reconciler.ts:Candidate.oldRelId`)
   * so the engine's `correct`/`confirm` actions can target the exact
   * row even when multiple per-site edges share the same
   * (sourceId, targetId) pair (WI-1 / #159).
   */
  oldRelId: string;
  file: string;
  /** 0-based line of the callee identifier (callNameNode.startPosition.row). */
  line: number;
  /** 0-based column of the callee identifier. */
  character: number;
}

/**
 * WI-2 — Mode A candidate feed (recall).
 *
 * Sites the heuristic dropped (ambiguous, no candidates, or filtered to non-callable)
 * are recorded so the reconciler can re-resolve them via LSP and mint `lsp-recall` edges.
 */
export interface RecallFeedItem {
  sourceId: string;
  calledName: string;
  file: string;
  line: number;
  character: number;
}

/**
 * Optional behaviors gated behind `opts.lsp` so the default `analyze` (no flag)
 * stays byte-identical. Feeds are only pushed to when `lsp:true` is passed.
 */
export interface ProcessCallsOpts {
  /** When true, push candidate-feed entries (correction + recall). */
  lsp?: boolean;
  /** Sink for `global`-0.50 correction candidates. Required when `lsp:true` for that feed. */
  correctionFeed?: CorrectionFeedItem[];
  /** Sink for unresolved/ambiguous recall candidates. */
  recallFeed?: RecallFeedItem[];
}

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
  typeEnvBindings?: FileTypeEnvBindings[],
  opts?: ProcessCallsOpts,
) => {
  const logVerbose = isVerboseIngestionEnabled();
  let totalCalls = 0;
  let resolvedCalls = 0;
  let failedCalls = 0;
  const failedByReason = new Map<string, number>();

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

  // FILE_SCOPE type bindings: keyed by filePath → varName → typeName.
  // Contains field declarations (e.g., `private CashService cashService;`) and
  // file-level constants. Used to resolve receiver types for calls like
  // `cashService.unholdMoney()` where `cashService` is a field.
  const fileTypeEnv = new Map<string, Map<string, string>>();
  if (typeEnvBindings) {
    if (logVerbose) {
      console.debug(`[call-resolution] Processing ${typeEnvBindings.length} typeEnvBindings files`);
    }
    for (const { filePath, bindings } of typeEnvBindings) {
      fileTypeEnv.set(filePath, bindings);
      // DEBUG: Log typeEnvBindings for controller files
      if (logVerbose && filePath.includes('Controller')) {
        console.debug(`[call-resolution] typeEnvBindings for ${filePath}: ${bindings.size} bindings`);
        for (const [name, type] of bindings) {
          console.debug(`[call-resolution]   - ${name} : ${type}`);
        }
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
    const widenCache: WidenCache = new Map();
    const receiverMap = fileReceiverTypes.get(filePath);
    const typeEnvMap = fileTypeEnv.get(filePath);

    // DEBUG: Log when typeEnvMap is available for files with calls
    if (logVerbose && typeEnvMap && typeEnvMap.size > 0 && filePath.includes('Controller')) {
      console.debug(`[call-resolution] File ${filePath}: ${calls.length} calls, typeEnvMap has ${typeEnvMap.size} entries`);
    }

    for (const call of calls) {
      let effectiveCall = call;

      // Step 0: resolve receiver type from FILE_SCOPE bindings (field declarations)
      // This handles Spring DI pattern: @Autowired private CashService cashService;
      // Fields are captured in FILE_SCOPE and should resolve before constructor bindings.
      if (!call.receiverTypeName && call.receiverName && typeEnvMap) {
        const resolvedType = typeEnvMap.get(call.receiverName);
        if (resolvedType) {
          if (logVerbose && filePath.includes('Controller')) {
            console.debug(`[call-resolution] Step 0: resolved receiver '${call.receiverName}' to type '${resolvedType}' from FILE_SCOPE`);
          }
          effectiveCall = { ...call, receiverTypeName: resolvedType };
        } else if (logVerbose && filePath.includes('Controller') && call.receiverName) {
          // DEBUG: Log when receiver is not found in FILE_SCOPE
          console.debug(`[call-resolution] Step 0: receiver '${call.receiverName}' NOT FOUND in FILE_SCOPE for ${filePath}`);
        }
      }

      // Step 1: resolve receiver type from constructor bindings (var x = new Type())
      if (!effectiveCall.receiverTypeName && call.receiverName && receiverMap) {
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

      const resolved = resolveCallTarget(effectiveCall, effectiveCall.filePath, ctx, undefined, widenCache);
      totalCalls++;
      if (!resolved) {
        failedCalls++;
        // Log resolution failure reason
        if (logVerbose) {
          const tiered = ctx.resolve(effectiveCall.calledName, effectiveCall.filePath);
          const reason = !tiered ? 'no-tiered-result'
            : tiered.candidates.length === 0 ? 'no-candidates'
            : tiered.candidates.length > 1 ? 'ambiguous-candidates'
            : 'filtered-out';
          const count = failedByReason.get(reason) ?? 0;
          failedByReason.set(reason, count + 1);
          if (failedCalls <= 10) { // Log first 10 failures
            console.debug(`[call-resolution] FAILED: calledName="${effectiveCall.calledName}" filePath="${effectiveCall.filePath}" receiverTypeName="${effectiveCall.receiverTypeName ?? 'none'}" reason="${reason}" candidates="${tiered?.candidates.length ?? 0}"`);
          }
        }
        // WI-2 — Mode A: push unresolved site to recall feed (gated by opts.lsp;
        // feeds are only touched when the flag is on, so the default path stays
        // byte-identical).
        if (opts?.lsp && opts.recallFeed) {
          opts.recallFeed.push({
            sourceId: effectiveCall.sourceId,
            calledName: effectiveCall.calledName,
            file: effectiveCall.filePath,
            // callee-identifier position; fall back to 0/0 when the worker did
            // not capture a call.name node (older emitters, synthetic calls).
            line: effectiveCall.line ?? 0,
            character: effectiveCall.character ?? 0,
          });
        }
        continue;
      }

      // DEBUG: Log successful resolution for controller calls
      if (logVerbose && effectiveCall.filePath.includes('Controller') && effectiveCall.receiverTypeName) {
        console.debug(`[call-resolution] RESOLVED: ${effectiveCall.receiverName}.${effectiveCall.calledName} -> ${resolved.nodeId} (via ${resolved.reason})`);
      }

      resolvedCalls++;

      // WI-1 (#159) — line-aware CALLS id. Mirrors the AST
      // path (:668): embed `effectiveCall.line` (or 0 for
      // position-less emitters — documented collapse at L0).
      // `relId` MUST be computed BEFORE the feed push so
      // `oldRelId` can be carried (reordered in WI-1 from
      // the post-push position to here).
      const callRow = effectiveCall.line ?? 0;
      const relId = generateId(
        'CALLS',
        `${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}:L${callRow}`,
      );

      // WI-2 — Mode A: push `global`-0.50 winner to correction feed. The reconciler
      // re-resolves it via LSP and either confirms (same target), corrects
      // (different target), or refuses (non-callable / no node). The exact
      // heuristic id rides through as `oldRelId` so the engine can target
      // the right row when multiple per-site edges share the same
      // (sourceId, targetId) pair.
      if (opts?.lsp && opts.correctionFeed && resolved.reason === 'global') {
        opts.correctionFeed.push({
          sourceId: effectiveCall.sourceId,
          calledName: effectiveCall.calledName,
          oldTargetId: resolved.nodeId,
          oldRelId: relId,
          file: effectiveCall.filePath,
          line: callRow,
          character: effectiveCall.character ?? 0,
        });
      }

      graph.addRelationship({
        id: relId,
        sourceId: effectiveCall.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
        source: 'heuristic',
        line: callRow,
      });
    }

    ctx.clearCache();
  }

  onProgress?.(totalFiles, totalFiles);

  if (logVerbose) {
    console.debug(`[call-resolution] Processed ${totalCalls} calls: ${resolvedCalls} resolved, ${failedCalls} failed`);
    for (const [reason, count] of failedByReason) {
      console.debug(`[call-resolution]   ${reason}: ${count}`);
    }
  }
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
      source: 'heuristic',
    });
  }
};

/**
 * Derive a best-effort controller-class name from a route's file path.
 *
 * For non-Spring routes the schema contract requires `controllerClass` to be a
 * string (never undefined). We can't always map a file path to a class
 * (Express/Hono handlers are often inline arrow functions, Next.js App Router
 * files export named handlers, etc.), so we use the file's basename minus
 * extension as a coarse surrogate. This is intentionally lossy — the field is
 * set to `''` for paths we can't parse.
 *
 * Exposed for M2: ensures the 8 non-Spring Route constructors can populate
 * the field without duplicating path-parse logic at each call site.
 */
export const deriveControllerClassFromFile = (filePath: string | undefined): string => {
  if (!filePath) return '';
  // Strip directory prefix and query/hash fragments if any.
  const base = filePath.split(/[?#]/)[0] ?? '';
  const lastSegment = base.split('/').pop() ?? '';
  if (!lastSegment) return '';
  // Strip known multi-dot extensions: .route.ts, .test.tsx, etc.
  const dotIdx = lastSegment.lastIndexOf('.');
  return dotIdx > 0 ? lastSegment.slice(0, dotIdx) : lastSegment;
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
  const logVerbose = isVerboseIngestionEnabled();
  if (logVerbose) {
    console.debug(`[route-processing] Processing ${extractedRoutes.length} routes`);
  }

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
    // Debug logging for resolution failures
    if (!controllerResolved || controllerResolved.candidates.length === 0) {
      if (logVerbose) {
        console.debug(`[route-resolution] FAILED: controller="${route.controllerName}" from="${route.filePath}" tier="${controllerResolved?.tier ?? 'null'}" candidates="${controllerResolved?.candidates.length ?? 0}"`);
      }
      skipped++;
      continue;
    }
    if (controllerResolved.tier === 'global' && controllerResolved.candidates.length > 1) {
      // Log ambiguous global resolution with candidate file paths
      if (logVerbose) {
        const candidatePaths = controllerResolved.candidates.map(c => c.filePath).join(', ');
        console.debug(`[route-resolution] AMBIGUOUS: controller="${route.controllerName}" from="${route.filePath}" candidates=[${candidatePaths}]`);
      }
      continue;
    }

    const controllerDef = controllerResolved.candidates[0];
    const confidence = TIER_CONFIDENCE[controllerResolved.tier];

    const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
    // Accept method resolution from same-file or via imports (for inherited methods)
    // When multiple overloads exist, prefer the one with @RequestBody (for Spring routes
    // that accept JSON bodies) or with @PathVariable coverage (for routes with path variables).
    let methodId = methodResolved?.candidates[0]?.nodeId;
    if (methodResolved?.candidates?.length > 1) {
      // First, try to find a candidate with @RequestBody
      const bodyCandidate = methodResolved.candidates.find(c => {
        const node = graph.getNode(c.nodeId);
        const paramAnns = (node?.properties as Record<string, unknown>)?.parameterAnnotations;
        if (typeof paramAnns === 'string') {
          try {
            const parsed = JSON.parse(paramAnns);
            return parsed.some((p: any) => p.annotations?.includes('@RequestBody'));
          } catch { return false; }
        }
        return false;
      });
      if (bodyCandidate) {
        methodId = bodyCandidate.nodeId;
      } else {
        // No @RequestBody candidate - check for @PathVariable coverage
        // Extract path variables from the route path
        const pathVarMatch = route.routePath?.match(/\{([^}]+)\}/g);
        const pathVars = pathVarMatch ? pathVarMatch.map((m: string) => m.slice(1, -1)) : [];

        if (pathVars.length > 0) {
          // Find candidate with @PathVariable coverage for all path variables
          const pathVarCandidate = methodResolved.candidates.find(c => {
            const node = graph.getNode(c.nodeId);
            const paramAnns = (node?.properties as Record<string, unknown>)?.parameterAnnotations;
            if (typeof paramAnns === 'string') {
              try {
                const parsed = JSON.parse(paramAnns);
                // Extract @PathVariable names from parameterAnnotations
                const coveredVars = new Set<string>();
                for (const p of parsed) {
                  const annotations = p.annotations || [];
                  for (const ann of annotations) {
                    if (ann.startsWith('@PathVariable')) {
                      // Extract argument: @PathVariable("tcbsId")
                      const argMatch = ann.match(/@PathVariable\s*\(\s*"([^"]+)"\s*\)/);
                      if (argMatch) {
                        coveredVars.add(argMatch[1]);
                      } else if (p.name) {
                        coveredVars.add(p.name);
                      }
                    }
                  }
                }
                // Check if all path variables are covered
                return pathVars.every((v: string) => coveredVars.has(v));
              } catch { return false; }
            }
            return false;
          });
          if (pathVarCandidate) {
            methodId = pathVarCandidate.nodeId;
          }
        }
      }
    }

    // Spring routes (isControllerClass: true) create Route nodes
    if (route.isControllerClass) {
      // Skip if method not resolved - can't create valid Route without handler
      if (!methodId) continue;

      // Create Route node
      // #67: expose the full ExtractedRoute field set as node properties so agents
      // can query them via Cypher. The `controllerName`/`methodName` aliases are
      // kept for backwards compatibility with the existing public surface.
      const routeId = generateId('Route', `${route.filePath}:${route.httpMethod}:${route.routePath}`);
      graph.addNode({
        id: routeId,
        label: 'Route',
        properties: {
          name: `${route.httpMethod} ${route.routePath}`,
          httpMethod: route.httpMethod,
          routePath: route.routePath,
          // Primary property names used by agents (#67) and the issue spec.
          controllerClass: route.controllerName,
          handlerMethod: route.methodName,
          // Legacy aliases — kept for backwards compatibility with
          // existing queries (e.g. route-node-e2e.test.ts).
          controllerName: route.controllerName,
          methodName: route.methodName,
          filePath: route.filePath,
          startLine: route.lineNumber,
          lineNumber: route.lineNumber,
          isInherited: route.isInherited ?? false,
          isControllerClass: route.isControllerClass,
          prefix: route.prefix ?? null,
          repoId: ctx.repoId,
        },
      });
      created++;

      // Create DEFINES edge (File → Route)
      const fileId = generateId('File', route.filePath);
      graph.addRelationship({
        id: generateId('DEFINES', `${fileId}:${routeId}`),
        sourceId: fileId,
        targetId: routeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: 'spring-route',
        source: 'heuristic',
      });

      // Create CALLS edge (Route → Method)
      graph.addRelationship({
        id: generateId('CALLS', `${routeId}:${methodId}`),
        sourceId: routeId,
        targetId: methodId,
        type: 'CALLS',
        confidence: confidence,
        reason: 'spring-route',
        source: 'heuristic',
      });
    } else {
      // Laravel routes: create CALLS edge from File to Method (no Route node)
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
          source: 'heuristic',
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
        source: 'heuristic',
      });
    }
  }

  if (logVerbose) {
    console.debug(`[route-processing] Created ${created} Route nodes, skipped ${skipped}`);
  }

  onProgress?.(extractedRoutes.length, extractedRoutes.length);
};


// WI-12: repoId parameter variant — used by pipeline.ts post-processing
export const processExpoRoutesWithRepoId = (
  graph: KnowledgeGraph,
  filePaths: string[],
  repoId: string,
): Map<string, string> => {
  const routeRegistry = new Map<string, string>();
  const nextjsRoutePattern = /(?:^|\/)app\/api\/.*\/route\.(ts|js|tsx|jsx)$/;

  for (const filePath of filePaths) {
    if (nextjsRoutePattern.test(filePath)) continue;
    const routeURL = expoFileToRouteURL(filePath);
    if (!routeURL) continue;

    const routeId = generateId('Route', routeURL);
    const fileId = generateId('File', filePath);

    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        filePath,
        routeType: 'expo-router',
        // Spec-named Route fields (M2). Non-Spring routes: not a Spring controller,
        // no prefix, no handler method resolvable from the URL alone.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
        repoId,
      },
    });

    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}->${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'expo-router-file',
      source: 'heuristic',
    });

    routeRegistry.set(routeURL, filePath);
  }

  return routeRegistry;
};

export const processNextjsRoutesWithRepoId = (
  graph: KnowledgeGraph,
  filePaths: string[],
  fileContents: Map<string, string>,
  repoId: string,
): Map<string, string> => {
  const routeRegistry = new Map<string, string>();
  let created = 0;

  for (const filePath of filePaths) {
    const routeURL = nextjsFileToRouteURL(filePath);
    if (!routeURL) continue;
    const content = fileContents.get(filePath);
    if (!content) continue;

    const { responseKeys, errorKeys } = extractResponseShapes(content);
    const mwResult = extractMiddlewareChain(content);
    const middleware = mwResult?.chain ?? [];

    const routeId = generateId('Route', routeURL);
    const fileId = generateId('File', filePath);

    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        routePath: routeURL,
        filePath,
        routeType: 'nextjs-app-router',
        repoId,
        // Spec-named Route fields (M2). Non-Spring routes: not a Spring controller,
        // no prefix, no handler method resolvable from the URL alone.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
        ...(responseKeys && responseKeys.length > 0 && { responseKeys }),
        ...(errorKeys && errorKeys.length > 0 && { errorKeys }),
        ...(middleware.length > 0 && { middleware }),
      },
    });

    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}->${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'nextjs-app-router',
      source: 'heuristic',
    });

    routeRegistry.set(routeURL, filePath);
    created++;
  }

  return routeRegistry;
};

export const processDecoratorRoutesWithRepoId = (
  graph: KnowledgeGraph,
  decoratorRoutes: ExtractedDecoratorRoute[],
  repoId: string,
): void => {
  const logVerbose = isVerboseIngestionEnabled();
  let created = 0;

  for (const route of decoratorRoutes) {
    const routePath = route.path;
    if (!routePath) continue;
    const httpMethod = (route.decorator || 'get').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'ALL', 'ROUTE'].includes(httpMethod)) continue;

    const routeId = generateId('Route', `${route.filePath}:${route.decorator}:${routePath}`);
    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routePath,
        httpMethod,
        routePath,
        filePath: route.filePath,
        startLine: route.lineNumber,
        lineNumber: route.lineNumber,
        repoId,
        // Spec-named Route fields (M2). controllerClass falls back to the file
        // name minus extension; handlerMethod prefers the real handler function
        // name (FastAPI/Gin set route.handlerName) and falls back to the HTTP
        // verb for plain Express/Hono routes that have no named handler.
        controllerClass: deriveControllerClassFromFile(route.filePath),
        handlerMethod: route.handlerName ?? httpMethod,
        isControllerClass: false,
        prefix: '',
      },
    });
    created++;

    const fileId = generateId('File', route.filePath);

    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: 'express-route',
      source: 'heuristic',
    });

    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'express-route',
      source: 'heuristic',
    });
  }
};

export const processPHPRoutesWithRepoId = (
  graph: KnowledgeGraph,
  phpFilePaths: string[],
  phpFileContents: Map<string, string>,
  repoId: string,
): void => {
  const logVerbose = isVerboseIngestionEnabled();
  let created = 0;

  for (const filePath of phpFilePaths) {
    const routeURL = phpFileToRouteURL(filePath);
    if (!routeURL) continue;
    const content = phpFileContents.get(filePath);
    if (!content) continue;

    const { responseKeys, errorKeys } = extractPHPResponseShapes(content);

    const routeId = generateId('Route', `${filePath}:${routeURL}`);
    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        routePath: routeURL,
        filePath,
        httpMethod: 'GET',
        repoId,
        // Spec-named Route fields (M2). Non-Spring: no controller, no prefix.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
        ...(responseKeys !== undefined && { responseKeys }),
        ...(errorKeys !== undefined && { errorKeys }),
      },
    });
    created++;

    const fileId = generateId('File', filePath);

    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: 'php-file-route',
      source: 'heuristic',
    });

    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'php-file-route',
      source: 'heuristic',
    });
  }
};

/**
 * Process Express/Hono decorator routes (app.get(), router.post(), etc.)
 * extracted from JavaScript/TypeScript files during parsing.
 *
 * - Creates Route nodes for each route registration
 * - Creates HANDLES_ROUTE edges (File -> Route)
 */
export const processDecoratorRoutes = (
  graph: KnowledgeGraph,
  decoratorRoutes: ExtractedDecoratorRoute[],
): void => {
  const logVerbose = isVerboseIngestionEnabled();
  let created = 0;

  for (const route of decoratorRoutes) {
    const routePath = route.path;
    if (!routePath) continue;

    // Normalize the HTTP method
    const httpMethod = (route.decorator || 'get').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL', 'ROUTE'].includes(httpMethod)) continue;

    // Create Route node
    const routeId = generateId('Route', `${route.filePath}:${route.decorator}:${routePath}`);
    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routePath,
        httpMethod,
        routePath,
        filePath: route.filePath,
        startLine: route.lineNumber,
        lineNumber: route.lineNumber,
        // Spec-named Route fields (M2). See processDecoratorRoutesWithRepoId above.
        controllerClass: deriveControllerClassFromFile(route.filePath),
        handlerMethod: httpMethod,
        isControllerClass: false,
        prefix: '',
      },
    });
    created++;

    // Create File node if it doesn't exist
    const fileId = generateId('File', route.filePath);

    // Create DEFINES edge (File -> Route)
    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: 'express-route',
      source: 'heuristic',
    });

    // Create HANDLES_ROUTE edge (File -> Route)
    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'express-route',
      source: 'heuristic',
    });
  }

  if (logVerbose && created > 0) {
    console.debug(`[decorator-route-processing] Created ${created} Route nodes from Express/Hono routes`);
  }
};

/**
 * Process PHP file-based routes (direct file routing without framework).
 * For each PHP file in api/ directory, creates a Route node and extracts
 * response shapes from json_encode() calls using extractPHPResponseShapes.
 *
 * - Creates Route nodes for api/*.php files
 * - Creates HANDLES_ROUTE edges (File -> Route)
 * - Extracts responseKeys/errorKeys from json_encode() calls
 */
export const processPHPRoutes = (
  graph: KnowledgeGraph,
  phpFilePaths: string[],
  phpFileContents: Map<string, string>,
): void => {
  const logVerbose = isVerboseIngestionEnabled();
  let created = 0;

  for (const filePath of phpFilePaths) {
    const routeURL = phpFileToRouteURL(filePath);
    if (!routeURL) continue;

    const content = phpFileContents.get(filePath);
    if (!content) continue;

    // Extract response shapes from json_encode() calls
    const { responseKeys, errorKeys } = extractPHPResponseShapes(content);

    // Create Route node
    const routeId = generateId('Route', `${filePath}:${routeURL}`);
    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        routePath: routeURL,
        filePath,
        httpMethod: 'GET',
        // Spec-named Route fields (M2). See processPHPRoutesWithRepoId above.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
        ...(responseKeys !== undefined && { responseKeys }),
        ...(errorKeys !== undefined && { errorKeys }),
      },
    });
    created++;

    // Create File node if it doesn't exist
    const fileId = generateId('File', filePath);

    // Create DEFINES edge (File -> Route)
    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: 'php-file-route',
      source: 'heuristic',
    });

    // Create HANDLES_ROUTE edge (File -> Route)
    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}:${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'php-file-route',
      source: 'heuristic',
    });
  }

  if (logVerbose && created > 0) {
    console.debug(`[php-route-processing] Created ${created} Route nodes from PHP files`);
  }
};

/**
 * Process Next.js App Router route files (app/api/glob/route.ts pattern).
 * - Creates Route nodes for each API route
 * - Extracts responseKeys/errorKeys from NextResponse.json() calls
 * - Extracts middleware wrapper chains from handler exports
 * - Creates HANDLES_ROUTE edges (File -> Route)
 * - Returns a route registry (routeURL -> filePath) for use in processNextjsFetchRoutes
 */
export const processNextjsRoutes = (
  graph: KnowledgeGraph,
  filePaths: string[],
  fileContents: Map<string, string>,
): Map<string, string> => {
  const logVerbose = isVerboseIngestionEnabled();
  const routeRegistry = new Map<string, string>(); // routeURL -> filePath
  let created = 0;

  for (const filePath of filePaths) {
    const routeURL = nextjsFileToRouteURL(filePath);
    if (!routeURL) continue;

    const content = fileContents.get(filePath);
    if (!content) continue;

    // Extract response shapes from NextResponse.json() calls
    const { responseKeys, errorKeys } = extractResponseShapes(content);

    // Extract middleware wrapper chain
    const mwResult = extractMiddlewareChain(content);
    const middleware = mwResult?.chain ?? [];

    // Create Route node
    const routeId = generateId('Route', routeURL);
    const fileId = generateId('File', filePath);

    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        routePath: routeURL,
        filePath,
        routeType: 'nextjs-app-router',
        // Spec-named Route fields (M2). See processNextjsRoutesWithRepoId above.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
        ...(responseKeys && responseKeys.length > 0 && { responseKeys }),
        ...(errorKeys && errorKeys.length > 0 && { errorKeys }),
        ...(middleware.length > 0 && { middleware }),
      },
    });

    // Create HANDLES_ROUTE edge (File -> Route)
    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}->${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'nextjs-app-router',
      source: 'heuristic',
    });

    routeRegistry.set(routeURL, filePath);
    created++;

    if (logVerbose) {
      console.debug(`[nextjs-route] Created Route ${routeURL} from ${filePath}`);
    }
  }

  if (logVerbose && created > 0) {
    console.debug(`[nextjs-route-processing] Created ${created} Route nodes from Next.js App Router files`);
  }

  return routeRegistry;
};

/**
 * Process ORM queries extracted from parse-worker.ts:
 * - Creates CodeElement nodes for ORM models (user, post, bookings, etc.)
 * - Creates QUERIES edges from enclosing function to model CodeElement
 */
export const processORMQueriesFromExtracted = (
  graph: KnowledgeGraph,
  ormQueries: ExtractedORMQuery[],
): void => {
  const logVerbose = isVerboseIngestionEnabled();

  // Track created CodeElement nodes to avoid duplicates
  const modelNodes = new Map<string, string>(); // entityType -> nodeId

  for (const query of ormQueries) {
    // Create or reuse CodeElement node for the model
    let modelNodeId = modelNodes.get(query.entityType);
    if (!modelNodeId) {
      modelNodeId = generateId('CodeElement', `orm-model:${query.entityType}`);
      graph.addNode({
        id: modelNodeId,
        label: 'CodeElement',
        properties: {
          name: query.entityType,
          description: 'model/table',
          entityType: query.entityType,
        },
      });
      modelNodes.set(query.entityType, modelNodeId);
    }

    // Create QUERIES edge from sourceId (function) to model CodeElement
    const relId = generateId('QUERIES', `${query.sourceId}:${query.entityType}:${query.operation}`);
    graph.addRelationship({
      id: relId,
      sourceId: query.sourceId,
      targetId: modelNodeId,
      type: 'QUERIES',
      confidence: 1.0,
      reason: query.operation,
      source: 'heuristic',
    });
  }

  if (logVerbose && ormQueries.length > 0) {
    console.debug(`[orm-processing] Created ${modelNodes.size} CodeElement nodes and ${ormQueries.length} QUERIES edges`);
  }
};

/**
 * Process Expo Router file-based routes:
 * - Creates Route nodes for files in app/ directory
 * - Creates HANDLES_ROUTE edges (File -> Route)
 * - Returns a route registry (routeURL -> filePath) for use in processExpoRouterNavigations
 *
 * NOTE: Skips Next.js App Router route.ts files - those are handled by processNextjsRoutes
 * which extracts responseKeys, errorKeys, and middleware.
 */
export const processExpoRoutes = (
  graph: KnowledgeGraph,
  filePaths: string[],
): Map<string, string> => {
  const logVerbose = isVerboseIngestionEnabled();
  const routeRegistry = new Map<string, string>(); // routeURL -> filePath

  // Next.js App Router route pattern: app/api/**/route.ts
  // These should be handled by processNextjsRoutes, not here
  const nextjsRoutePattern = /(?:^|\/)app\/api\/.*\/route\.(ts|js|tsx|jsx)$/;

  for (const filePath of filePaths) {
    // Skip Next.js App Router route handlers - they need responseKeys/errorKeys/middleware extraction
    if (nextjsRoutePattern.test(filePath)) continue;

    const routeURL = expoFileToRouteURL(filePath);
    if (!routeURL) continue;

    // Create Route node
    const routeId = generateId('Route', routeURL);
    const fileId = generateId('File', filePath);

    graph.addNode({
      id: routeId,
      label: 'Route',
      properties: {
        name: routeURL,
        filePath,
        routeType: 'expo-router',
        // Spec-named Route fields (M2). See processExpoRoutesWithRepoId above.
        controllerClass: deriveControllerClassFromFile(filePath),
        handlerMethod: '',
        isControllerClass: false,
        prefix: '',
      },
    });

    // Create HANDLES_ROUTE edge (File -> Route)
    graph.addRelationship({
      id: generateId('HANDLES_ROUTE', `${fileId}->${routeId}`),
      sourceId: fileId,
      targetId: routeId,
      type: 'HANDLES_ROUTE',
      confidence: 1.0,
      reason: 'expo-router-file',
      source: 'heuristic',
    });

    routeRegistry.set(routeURL, filePath);

    if (logVerbose) {
      console.debug(`[expo-route] Created Route ${routeURL} from ${filePath}`);
    }
  }

  if (logVerbose && routeRegistry.size > 0) {
    console.debug(`[expo-route] Created ${routeRegistry.size} Expo Router routes`);
  }

  return routeRegistry;
};

/**
 * Process Next.js project-level middleware.ts file and link it to matching routes.
 * - Finds middleware.ts at project root
 * - Extracts config.matcher patterns
 * - Updates Route nodes that match the patterns with middleware property
 */
export const processNextjsMiddleware = (
  graph: KnowledgeGraph,
  filePaths: string[],
  fileContents: Map<string, string>,
): void => {
  const logVerbose = isVerboseIngestionEnabled();

  // Find project-level middleware.ts (not in node_modules or app/ directories)
  const middlewarePath = filePaths.find(p =>
    (p === 'middleware.ts' || p === 'middleware.js' || p.endsWith('/middleware.ts') || p.endsWith('/middleware.js')) &&
    !p.includes('node_modules') &&
    !p.includes('/app/')
  );

  if (!middlewarePath) return;

  const content = fileContents.get(middlewarePath);
  if (!content) return;

  const mwConfig = extractNextjsMiddlewareConfig(content);
  if (!mwConfig || mwConfig.matchers.length === 0) return;

  if (logVerbose) {
    console.debug(`[nextjs-middleware] Found middleware at ${middlewarePath} with matchers: ${mwConfig.matchers.join(', ')}`);
  }

  // Compile matchers
  const compiledMatchers = mwConfig.matchers
    .map(m => compileMatcher(m))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // Find all Route nodes and update those that match
  graph.forEachNode(node => {
    if (node.label !== 'Route') return;
    const routeURL = node.properties.routePath ?? node.properties.name;
    if (typeof routeURL !== 'string') return;

    // Check if route matches any matcher
    const matches = compiledMatchers.some(cm => compiledMatcherMatchesRoute(cm, routeURL));
    if (!matches) return;

    // Update middleware property
    const existingMiddleware = node.properties.middleware as string[] | undefined;
    const mwName = mwConfig.exportedName;
    if (existingMiddleware) {
      if (!existingMiddleware.includes(mwName)) {
        node.properties.middleware = [...existingMiddleware, mwName];
      }
    } else {
      node.properties.middleware = [mwName];
    }
  });
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
  'json', 'text', 'blob', 'arrayBuffer', 'formData', 'ok', 'status', 'headers', 'clone',
  // Promise
  'then', 'catch', 'finally',
  // Array
  'map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every',
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'concat', 'join',
  'sort', 'reverse', 'includes', 'indexOf',
  // Object
  'length', 'toString', 'valueOf', 'keys', 'values', 'entries',
  // DOM methods — file-download patterns often reuse `data`/`response` variable names
  'appendChild', 'removeChild', 'insertBefore', 'replaceChild', 'replaceChildren',
  'createElement', 'getElementById', 'querySelector', 'querySelectorAll',
  'setAttribute', 'getAttribute', 'removeAttribute', 'hasAttribute',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'classList', 'className',
  'parentNode', 'parentElement', 'childNodes', 'children',
  'nextSibling', 'previousSibling', 'firstChild', 'lastChild',
  'click', 'focus', 'blur', 'submit', 'reset',
  'innerHTML', 'outerHTML', 'textContent', 'innerText',
]);

export const extractConsumerAccessedKeys = (content: string): string[] => {
  const keys = new Set<string>();

  // Pattern 1: Destructuring from .json() — const { key1, key2 } = await res.json()
  // Also matches: const { key1, key2 } = await (await fetch(...)).json()
  const destructurePattern = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:await\s+)?(?:\w+\.json\s*\(\)|(?:await\s+)?(?:fetch|axios|got)\s*\([^)]*\)(?:\.then\s*\([^)]*\))?(?:\.json\s*\(\))?)/g;
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
  const dataVarDestructure = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:data|result|response|json|body|res)\b/g;
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
  routeRegistry: Map<string, string>,  // routeURL → handlerFilePath
  consumerContents?: Map<string, string>,  // filePath → file content
) => {
  if (isVerboseIngestionEnabled()) {
    console.debug(`[fetch-routes] Processing ${fetchCalls.length} fetch calls against ${routeRegistry.size} routes`);
  }
  // Pre-count how many routes each consumer file matches (for confidence attribution)
  const routeCountByFile = new Map<string, number>();
  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (isVerboseIngestionEnabled()) {
      console.debug(`[fetch-routes] Normalized '${call.fetchURL}' → '${normalized}'`);
    }
    if (!normalized) continue;
    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        if (isVerboseIngestionEnabled()) {
          console.debug(`[fetch-routes] MATCH: normalized '${normalized}' ↔ route '${routeURL}'`);
        }
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
          source: 'heuristic',
        });
        if (isVerboseIngestionEnabled()) {
          console.debug(`[fetch-routes] Created FETCHES: ${sourceId} → ${routeNodeId}, reason=${reason}`);
        }
        break;
      }
    }
  }
};

/**
 * Create FETCHES edges from Expo Router navigation calls (router.push/replace/navigate).
 * These represent client-side navigation between routes, not HTTP fetches.
 * We model them the same way as fetch() calls for consistency in the consumer graph.
 */
export const processExpoRouterNavigations = (
  graph: KnowledgeGraph,
  expoNavCalls: ExtractedExpoNav[],
  routeRegistry: Map<string, string>,  // routeURL → handlerFilePath
) => {
  if (isVerboseIngestionEnabled()) {
    console.debug(`[expo-nav] Processing ${expoNavCalls.length} navigation calls against ${routeRegistry.size} routes`);
  }

  for (const nav of expoNavCalls) {
    // Strip quotes from URL
    const normalized = nav.url.replace(/^['"]|['"]$/g, '');
    if (!normalized || !normalized.startsWith('/')) continue;

    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        const sourceId = generateId('File', nav.filePath);
        const routeNodeId = generateId('Route', routeURL);

        graph.addRelationship({
          id: generateId('FETCHES', `${sourceId}->${routeNodeId}`),
          sourceId,
          targetId: routeNodeId,
          type: 'FETCHES',
          confidence: 0.85,
          reason: `expo-router:${nav.method.toLowerCase()}`,
          source: 'heuristic',
        });
        if (isVerboseIngestionEnabled()) {
          console.debug(`[expo-nav] Created FETCHES: ${sourceId} → ${routeNodeId} via ${nav.method}`);
        }
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
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch { continue; }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch { continue; }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.push({
            filePath: file.path,
            url: urlNode.text,
            method: 'GET',
            sourceId: generateId('File', file.path),
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
            url,
            method,
            sourceId: generateId('File', file.path),
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
      }
    }
  }

  return result;
};

/**
 * Extract Expo Router navigation calls (router.push/replace/navigate) from source files (sequential path).
 * Workers handle this via tree-sitter captures in parse-worker; this function
 * provides the same extraction for the sequential fallback path.
 */
export const extractExpoNavCallsFromFiles = async (
  files: { path: string; content: string }[],
  astCache: ASTCache,
): Promise<ExtractedExpoNav[]> => {
  const parser = await loadParser();
  const result: ExtractedExpoNav[] = [];

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
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch { continue; }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch { continue; }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (captureMap['expo_nav'] && captureMap['expo_nav.url']) {
        const url = captureMap['expo_nav.url'].text;
        const navMethod = captureMap['expo_nav.method']?.text;
        result.push({
          filePath: file.path,
          url,
          method: navMethod?.toUpperCase() ?? 'PUSH',
          sourceId: generateId('File', file.path),
          lineNumber: captureMap['expo_nav'].startPosition.row,
        });
      }
    }
  }

  return result;
};

/**
 * Process extracted MCP tool definitions from @mcp.tool() decorators.
 * Creates Tool nodes and HANDLES_TOOL edges from handler files to tools.
 */
export const processToolDefsFromExtracted = async (
  graph: KnowledgeGraph,
  toolDefs: ExtractedToolDef[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<void> => {
  const logVerbose = isVerboseIngestionEnabled();
  if (logVerbose) {
    console.debug(`[tool-processing] Processing ${toolDefs.length} tool definitions`);
  }

  for (let i = 0; i < toolDefs.length; i++) {
    const toolDef = toolDefs[i];
    if (i % 50 === 0) {
      onProgress?.(i, toolDefs.length);
      await yieldToEventLoop();
    }

    // Create Tool node
    const toolId = generateId('Tool', `${toolDef.filePath}:${toolDef.name}`);
    graph.addNode({
      id: toolId,
      label: 'Tool',
      properties: {
        name: toolDef.name,
        filePath: toolDef.filePath,
        description: toolDef.description,
        lineNumber: toolDef.lineNumber,
      },
    });

    // Create HANDLES_TOOL edge (File → Tool)
    const fileId = generateId('File', toolDef.filePath);
    graph.addRelationship({
      id: generateId('HANDLES_TOOL', `${fileId}:${toolId}`),
      sourceId: fileId,
      targetId: toolId,
      type: 'HANDLES_TOOL',
      confidence: 1.0,
      reason: 'mcp-tool-decorator',
      source: 'heuristic',
    });

    // Try to resolve the function and create CALLS edge (Tool → Function)
    const funcResolved = ctx.resolve(toolDef.name, toolDef.filePath);
    if (funcResolved && funcResolved.candidates.length > 0) {
      const funcId = funcResolved.candidates[0].nodeId;
      const confidence = TIER_CONFIDENCE[funcResolved.tier];
      graph.addRelationship({
        id: generateId('CALLS', `${toolId}:${funcId}`),
        sourceId: toolId,
        targetId: funcId,
        type: 'CALLS',
        confidence,
        reason: 'mcp-tool-handler',
        source: 'heuristic',
      });
    }
  }

  if (logVerbose) {
    console.debug(`[tool-processing] Created ${toolDefs.length} Tool nodes`);
  }
};
