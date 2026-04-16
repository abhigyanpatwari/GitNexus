import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition, SymbolTableReader } from './model/symbol-table.js';
import { CLASS_TYPES, CALL_TARGET_TYPES } from './model/symbol-table.js';
import Parser from 'tree-sitter';
import type { ResolutionContext } from './model/resolution-context.js';
import { TIER_CONFIDENCE, type ResolutionTier } from './model/resolution-context.js';
import type { TieredCandidates } from './model/resolution-context.js';
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
import type { HeritageMap } from './model/heritage-map.js';
import type { BindingAccumulator } from './binding-accumulator.js';
import { getTreeSitterBufferSize } from './constants.js';
import type {
  ExtractedCall,
  ExtractedAssignment,
  ExtractedRoute,
  ExtractedFetchCall,
  FileConstructorBindings,
} from './workers/parse-worker.js';
import type { ExtractedHeritage } from './model/heritage-map.js';
import { normalizeFetchURL, routeMatches } from './route-extractors/nextjs.js';
import { extractTemplateComponents } from './vue-sfc-extractor.js';
import { extractReturnTypeName, stripNullable } from './type-extractors/shared.js';
import type { LiteralTypeInferrer } from './type-extractors/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import { lookupMethodByOwnerWithMRO } from './model/resolve.js';

/** Per-file resolved type bindings for exported symbols.
 *  Populated during call processing, consumed by Phase 14 re-resolution pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

/**
 * Type labels treated as class-like **method-dispatch receivers** by the call
 * resolver — the set walked by the MRO / heritage path for member and static
 * method calls.
 *
 * Derived from `CLASS_TYPES` (the heritage-index set in symbol-table) plus
 * `Impl` — Rust `impl` blocks are the definition site of methods for a struct
 * and must be walkable as receiver-type candidates even though they are not
 * indexed by `lookupClassByName` (which keys off struct/trait names). Keeping
 * this set a strict superset of `CLASS_TYPES` guarantees that anything
 * reachable via `lookupClassByName` also passes this filter, so the two call
 * paths cannot diverge silently.
 *
 * `Interface` is included even though interfaces cannot be directly
 * instantiated in Java/C#/TypeScript: the resolver still needs to reach
 * interface nodes for static-method dispatch (`Interface.staticMethod()`) and
 * default-method resolution via the MRO walker.
 *
 * **Do not reuse this set for constructor-fallback filtering.** Constructors
 * can only instantiate a narrower subset — see `INSTANTIABLE_CLASS_TYPES`
 * below. `resolveStaticCall`'s step-5 class-node fallback uses the narrower
 * set to prevent false `CALLS` edges from constructor-shaped calls to
 * `Interface`, `Trait`, or `Impl` nodes.
 */
const CLASS_LIKE_TYPES = new Set<string>([...CLASS_TYPES, 'Impl']);

/**
 * Type labels that can be the target of a constructor-shaped call when no
 * explicit `Constructor` symbol is indexed — the "return the type itself as
 * the call target" fallback set.
 *
 * Strict subset of both `CLASS_LIKE_TYPES` and `CONSTRUCTOR_TARGET_TYPES`.
 * Excludes:
 *   - `Interface` / `Trait` — not instantiable by definition in any
 *     supported language.
 *   - `Impl` — Rust `impl` blocks are method-definition containers, not
 *     the type itself; the owning `Struct` is the correct target.
 *   - `Enum` — excluded pending language-specific support with motivating
 *     test fixtures (matches `CONSTRUCTOR_TARGET_TYPES`).
 *
 * Used exclusively by `resolveStaticCall`'s step-5 class-node fallback.
 * Keep in sync with `CONSTRUCTOR_TARGET_TYPES` (which additionally contains
 * `'Constructor'` for explicit-constructor-node filtering) when extending.
 */
const INSTANTIABLE_CLASS_TYPES = new Set<string>(['Class', 'Struct', 'Record']);

const MAX_EXPORTS_PER_FILE = 500;
const MAX_TYPE_NAME_LENGTH = 256;

/** Build a map of imported callee names → return types for cross-file call-result binding.
 *  Consulted ONLY when SymbolTable has no unambiguous local match (local-first principle).
 *
 *  Overlapping mechanism (1 of 3): this is the SymbolTable-backed path.
 *  See also:
 *    2. collectExportedBindings (~line 168) / enrichExportedTypeMap — TypeEnv + graph isExported
 *    3. Phase 9 fallback in verifyConstructorBindings (~line 563) — namedImportMap + BindingAccumulator
 *  A future cleanup should merge these into a single resolution pass. */
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
 *  Uses graph node isExported flag — does NOT require isExported on SymbolDefinition.
 *
 *  **Counterpart**: the worker path populates `exportedTypeMap` via the
 *  accumulator enrichment loop in `pipeline.ts` (search for "Worker path
 *  quality enrichment"). Both sites populate the same map with subtly
 *  different export-check semantics — this site uses SymbolTable +
 *  graph lookup, the worker loop uses three-candidate-ID graph lookup.
 *  They must stay in sync until unified. If you edit one, check the other.
 *
 *  Overlapping mechanism (2 of 3): this is the TypeEnv + graph isExported path.
 *  See also:
 *    1. buildImportedReturnTypes (~line 109) — namedImportMap + SymbolTable
 *    3. Phase 9 fallback in verifyConstructorBindings (~line 563) — namedImportMap + BindingAccumulator
 *  A future cleanup should merge these into a single resolution pass. */
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
  symbolTable: SymbolTableReader,
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
  bindingAccumulator?: BindingAccumulator,
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

      let typeName: string | undefined;
      if (callableDefs && callableDefs.length === 1 && callableDefs[0].returnType) {
        typeName = extractReturnTypeName(callableDefs[0].returnType);
      }

      // Phase 9: BindingAccumulator fallback for cross-file return types.
      // Used when the SymbolTable has no return type for a cross-file callee
      // (e.g., a return type that TypeEnv resolved via fixpoint in the source
      // file but was not stored as a SymbolTable returnType annotation).
      // namedImportMap tells us which source file exported the callee so we
      // can look up its file-scope binding via the O(1) fileScopeGet method.
      //
      // Tier gating: only fall back to the accumulator when resolution is
      // unambiguously import-scoped or global. When tiered.tier is 'same-file',
      // the local definition is authoritative even without a return type
      // annotation — using the accumulator here would let an imported callee
      // with the same name shadow the local one, producing false CALLS edges.
      // When multiple callable candidates exist, the accumulator would pick
      // arbitrarily — skip to avoid fabricated edges.
      //
      // Quality note: worker-path accumulator entries are Tier 0/1 only
      // (annotation-declared + same-file constructor inference) — see the
      // BindingAccumulator class JSDoc. For large repos where the worker
      // path dominates, Phase 9 binding accuracy is structurally lower
      // than for sequential-path repos where Tier 2 cross-file propagation
      // is available.
      //
      // Overlapping mechanism note: this is one of three cross-file
      // return-type resolution paths in the codebase:
      //   1. buildImportedReturnTypes (~line 109) — namedImportMap +
      //      SymbolTable.lookupExactFull (structure-processor captured)
      //   2. collectExportedBindings (~line 168) / enrichExportedTypeMap
      //      — TypeEnv + graph isExported flag
      //   3. This fallback — namedImportMap + BindingAccumulator
      // A future cleanup should merge these into a single resolution pass.
      const shouldFallback =
        tiered?.tier !== 'same-file' && (!callableDefs || callableDefs.length <= 1);
      if (!typeName && bindingAccumulator && shouldFallback) {
        const namedImports = ctx.namedImportMap.get(filePath);
        const importBinding = namedImports?.get(calleeName);
        if (importBinding) {
          const rawType = bindingAccumulator.fileScopeGet(
            importBinding.sourcePath,
            importBinding.exportedName,
          );
          if (rawType) {
            typeName = extractReturnTypeName(rawType);
          }
        }
      }

      if (typeName) {
        verified.set(receiverKey(scope, varName), typeName);
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
    const methods = ctx.model.symbols.lookupExactAll(implFile, calledName);
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
  bindingAccumulator?: BindingAccumulator,
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

  // ── Prepare-then-resolve: single preparation loop, deferred resolution ──
  // All files are prepared (parse → query → heritage → TypeEnv) in one loop,
  // then resolved (verifyConstructorBindings → call edges) in a second loop.
  // This ensures:
  //   1. When bindingAccumulator is present, ALL files flush their TypeEnv
  //      bindings before ANY verifyConstructorBindings reads — fixing the
  //      consumer-before-provider ordering bug on the sequential path.
  //   2. globalParentMap is fully populated before resolution, improving
  //      cross-file isSubclassOf accuracy regardless of file order.
  // For the sequential path (<15 files), buffering per-file state is negligible.
  interface PreparedFile {
    file: { path: string; content: string };
    language: SupportedLanguages;
    provider: ReturnType<typeof getProvider>;
    tree: ReturnType<typeof parser.parse>;
    matches: ReturnType<Parser.Query['matches']>;
    parentMap: ReadonlyMap<string, readonly string[]>;
    typeEnv: ReturnType<typeof buildTypeEnv>;
  }
  const prepared: PreparedFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
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

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    // Extract heritage from query matches to build parentMap for buildTypeEnv.
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
      model: ctx.model,
      parentMap,
      importedBindings,
      importedReturnTypes,
      importedRawReturnTypes,
      enclosingFunctionFinder: provider?.enclosingFunctionFinder,
      extractFunctionName: provider?.methodExtractor?.extractFunctionName,
    });
    if (typeEnv && exportedTypeMap) {
      const fileExports = collectExportedBindings(typeEnv, file.path, ctx.model.symbols, graph);
      if (fileExports) exportedTypeMap.set(file.path, fileExports);
    }
    if (bindingAccumulator) {
      typeEnv.flush(file.path, bindingAccumulator);
    }

    prepared.push({ file, language, provider, tree, matches, parentMap, typeEnv });
  }

  // ── Resolution loop: verify constructor bindings and resolve calls ──
  // The accumulator (if present) is now fully populated from the preparation
  // loop above, so verifyConstructorBindings sees all provider bindings
  // regardless of file processing order.
  for (let i = 0; i < prepared.length; i++) {
    const { file, language, provider, tree, matches, parentMap, typeEnv } = prepared[i];

    enclosingFnExtractCache.clear();
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    const callRouter = provider.callRouter;

    const verifiedReceivers =
      typeEnv.constructorBindings.length > 0
        ? verifyConstructorBindings(
            typeEnv.constructorBindings,
            file.path,
            ctx,
            undefined, // graph not available on the sequential path here
            bindingAccumulator, // Phase 9 fallback — same as worker path (R3 parity)
          )
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
      const callExtractor = provider.callExtractor;

      // ── Language-specific call site (e.g. Java :: method references) ──
      if (callExtractor) {
        const langCallSite = callExtractor.extract(callNode, undefined);
        if (langCallSite) {
          if (provider.isBuiltInName(langCallSite.calledName)) return;

          const sourceId =
            findEnclosingFunction(callNode, file.path, ctx, provider) ||
            generateId('File', file.path);
          const receiverName =
            langCallSite.callForm === 'member' ? langCallSite.receiverName : undefined;
          let receiverTypeName =
            receiverName && typeEnv ? typeEnv.lookup(receiverName, callNode) : undefined;

          if (
            langCallSite.typeAsReceiverHeuristic &&
            receiverName !== undefined &&
            receiverTypeName === undefined &&
            langCallSite.callForm === 'member'
          ) {
            const c0 = receiverName.charCodeAt(0);
            if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
          }

          const resolved = resolveCallTarget(
            {
              calledName: langCallSite.calledName,
              callForm: langCallSite.callForm,
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
            id: generateId('CALLS', `${sourceId}:${langCallSite.calledName}->${resolved.nodeId}`),
            sourceId,
            targetId: resolved.nodeId,
            type: 'CALLS',
            confidence: resolved.confidence,
            reason: resolved.reason,
          });

          if (heritageMap && langCallSite.callForm === 'member' && receiverTypeName) {
            const implTargets = findInterfaceDispatchTargets(
              langCallSite.calledName,
              receiverTypeName,
              file.path,
              ctx,
              heritageMap,
              resolved.nodeId,
            );
            for (const impl of implTargets) {
              graph.addRelationship({
                id: generateId('CALLS', `${sourceId}:${langCallSite.calledName}->${impl.nodeId}`),
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
              ctx.model.symbols.add(file.path, item.propName, nodeId, 'Property', {
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
            (ctx.model.types.lookupClassByName(ctorType).length > 0 &&
              ctx.model.types.lookupClassByName(receiverTypeName).length > 0)
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

// FREE_CALLABLE_TYPES imported from symbol-table.ts — single source of truth.

const CONSTRUCTOR_TARGET_TYPES = new Set(['Constructor', 'Class', 'Struct', 'Record']);

/** Per-file cache for module-alias widening. Cleared between files. */
type WidenCache = Map<string, readonly SymbolDefinition[]>;

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
        types.length > 0 ? types : candidates.filter((c) => CALL_TARGET_TYPES.has(c.type));
    }
  } else {
    // CALL_TARGET_TYPES (not FREE_CALLABLE_TYPES) — the post-A4 filter must
    // also admit Method and Constructor candidates, which are now unioned
    // into the pool from `model.methods.lookupMethodByName` rather than
    // `symbols.lookupCallableByName`.
    kindFiltered = candidates.filter((c) => CALL_TARGET_TYPES.has(c.type));
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

/**
 * Count callable candidates matching the kind + arity filter without
 * allocating an intermediate array. Short-circuits once count exceeds
 * `threshold` (default 1) — used by the dispatcher's `skipMember` check
 * where we only need to know "more than one survivor".
 */
const countCallableCandidates = (
  candidates: readonly SymbolDefinition[],
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
  threshold = 1,
): number => {
  let count = 0;
  for (const c of candidates) {
    // Kind filter (mirrors filterCallableCandidates)
    const typeOk =
      callForm === 'constructor'
        ? CONSTRUCTOR_TARGET_TYPES.has(c.type)
        : CALL_TARGET_TYPES.has(c.type);
    if (!typeOk) continue;
    // Arity filter
    if (
      argCount !== undefined &&
      c.parameterCount !== undefined &&
      (argCount < (c.requiredParameterCount ?? c.parameterCount) || argCount > c.parameterCount)
    ) {
      continue;
    }
    count++;
    if (count > threshold) return count; // early exit
  }
  return count;
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
 * Apply overload-hint or arg-type disambiguation to a pre-filtered candidate
 * pool. Returns the unique survivor, or null when neither signal is present,
 * neither can disambiguate, or the pool remains ambiguous.
 *
 * Precedence rule: `overloadHints` wins over `preComputedArgTypes` when both
 * are supplied. The AST-based disambiguator has access to live type inference
 * hooks, whereas `preComputedArgTypes` is a worker-path pre-computation that
 * may be coarser-grained.
 *
 * Single source of truth for the narrowing-signal precedence used by member
 * and constructor resolution paths. Add a new narrowing signal here once, not
 * at each call site.
 */
const disambiguateByOverloadOrArgTypes = (
  pool: SymbolDefinition[],
  overloadHints: OverloadHints | undefined,
  preComputedArgTypes: (string | undefined)[] | undefined,
): SymbolDefinition | null => {
  if (!overloadHints && !preComputedArgTypes) return null;
  if (overloadHints) return tryOverloadDisambiguation(pool, overloadHints);
  if (preComputedArgTypes) return matchCandidatesByArgTypes(pool, preComputedArgTypes);
  return null;
};

/**
 * Collapse Swift-extension duplicate Class/Struct candidates to the primary
 * definition, preferring the shortest file path.
 *
 * Swift extensions (`extension User { ... }` in a separate file) create
 * multiple `Class` nodes sharing the same symbol name — one for the primary
 * declaration and one per extension file. When overload disambiguation and
 * receiver narrowing both fail to converge on a single candidate, this
 * heuristic picks the primary definition based on the assumption that it
 * lives at the shortest file path (e.g. `User.swift` over `UserExtensions.swift`).
 *
 * Intentionally narrower than {@link INSTANTIABLE_CLASS_TYPES}: only `Class`
 * and `Struct` are considered, not `Record`. Swift extensions only produce
 * `Class` duplicates in practice, and C#/Kotlin records do not exhibit the
 * same multi-file-definition pattern, so widening this set risks accidental
 * dedup of legitimately distinct record types.
 *
 * Returns a `ResolveResult` when the heuristic fires, `null` when the
 * candidate pool does not match the shape (mixed types, non-Class/Struct
 * kinds, or `length <= 1`). Callers should fall through to their own null
 * return when this helper returns `null`.
 *
 * Used by `resolveFreeCall`. Having a single source of truth prevents
 * duplication if the heuristic is ever tuned.
 */
const dedupSwiftExtensionCandidates = (
  candidates: readonly SymbolDefinition[],
  tier: ResolutionTier,
): ResolveResult | null => {
  if (candidates.length <= 1) return null;
  const allSameType = candidates.every((c) => c.type === candidates[0].type);
  if (!allSameType) return null;
  if (candidates[0].type !== 'Class' && candidates[0].type !== 'Struct') return null;
  const sorted = [...candidates].sort((a, b) => a.filePath.length - b.filePath.length);
  return toResolveResult(sorted[0], tier);
};

/**
 * Thin dispatcher that routes a call to the appropriate specialized resolver.
 *
 * - `free`        → {@link resolveFreeCall}
 * - `constructor` → {@link resolveStaticCall}  (with pre-resolved tiered pool)
 * - `member` with a known receiver type → {@link resolveMemberCall}, with
 *   file-based fallback for traits/interfaces
 * - `member` without receiver type → module-alias check, then tiered lookup
 *
 * Replaces the former 200+ line function (SM-19: fuzzy-free call resolution).
 */
/**
 * Module-alias resolution for member calls without a receiver type.
 *
 * Handles Python/Ruby `import mod; mod.Symbol()` patterns where the receiver
 * is a module name, not a typed variable. Uses `moduleAliasMap` to scope
 * candidates to the correct module file.
 */
const resolveModuleAliasedCall = (
  call: Pick<ExtractedCall, 'calledName' | 'argCount' | 'callForm' | 'receiverName'>,
  currentFile: string,
  ctx: ResolutionContext,
  widenCache?: WidenCache,
  tieredOverride?: TieredCandidates,
): ResolveResult | null => {
  if (!call.receiverName) return null;
  const aliasMap = ctx.moduleAliasMap?.get(currentFile);
  if (!aliasMap) return null;
  const moduleFile = aliasMap.get(call.receiverName);
  if (!moduleFile) return null;

  // Reuse the caller's pre-computed tiered result when available —
  // the dispatcher already called ctx.resolve(call.calledName, currentFile).
  const tiered = tieredOverride ?? ctx.resolve(call.calledName, currentFile);
  if (!tiered) return null;

  // Try member-form, then constructor-form (for `module.ClassName()` patterns)
  let filtered = filterCallableCandidates(tiered.candidates, call.argCount, call.callForm).filter(
    (c) => c.filePath === moduleFile,
  );
  if (filtered.length === 0) {
    filtered = filterCallableCandidates(tiered.candidates, call.argCount, 'constructor').filter(
      (c) => c.filePath === moduleFile,
    );
  }
  if (filtered.length === 0) {
    // Widen to global callable+method indexes scoped to the aliased module
    // file. Function+ownerId (Python/Rust/Kotlin) is still routed to both
    // indexes until Unit 5 unblocks, so dedup by nodeId.
    const cacheKey = `${call.calledName}\0${moduleFile}`;
    let defs = widenCache?.get(cacheKey);
    if (!defs) {
      const rawCallable = ctx.model.symbols.lookupCallableByName(call.calledName);
      const rawMethods = ctx.model.methods.lookupMethodByName(call.calledName);
      const widenCombined: SymbolDefinition[] = [];
      const widenSeen = new Set<string>();
      for (const d of rawCallable) {
        if (widenSeen.has(d.nodeId)) continue;
        widenSeen.add(d.nodeId);
        widenCombined.push(d);
      }
      for (const d of rawMethods) {
        if (widenSeen.has(d.nodeId)) continue;
        widenSeen.add(d.nodeId);
        widenCombined.push(d);
      }
      defs = widenCombined;
      widenCache?.set(cacheKey, defs);
    }
    filtered = filterCallableCandidates(defs, call.argCount, call.callForm).filter(
      (c) => c.filePath === moduleFile,
    );
    if (filtered.length === 0) {
      filtered = filterCallableCandidates(defs, call.argCount, 'constructor').filter(
        (c) => c.filePath === moduleFile,
      );
    }
  }
  return filtered.length === 1 ? toResolveResult(filtered[0], tiered.tier) : null;
};

/**
 * File-based fallback for member calls where owner-scoped resolution fails.
 *
 * Resolves the receiver type via `ctx.resolve()` and narrows all callable
 * symbols with the method name to the receiver type's defining file(s),
 * then applies ownerId filtering and overload disambiguation.
 *
 * Handles Rust trait dispatch (`repo.find()` where `find` is on a trait impl),
 * cross-file overloaded methods, and similar patterns where ownerId
 * relationships may not be established on all candidates.
 */
const resolveMemberCallByFile = (
  calledName: string,
  receiverTypeName: string,
  currentFile: string,
  ctx: ResolutionContext,
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
  overloadHints?: OverloadHints,
  preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
  const typeResolved = ctx.resolve(receiverTypeName, currentFile);
  if (!typeResolved || typeResolved.candidates.length === 0) return null;
  const typeNodeIds = new Set(typeResolved.candidates.map((d) => d.nodeId));
  const typeFiles = new Set(typeResolved.candidates.map((d) => d.filePath));

  // A4 (plan 006, Unit 4): consult both indexes. Strictly-labeled
  // Method/Constructor are disjoint, but Function+ownerId (Python/Rust/
  // Kotlin) is routed into BOTH indexes by `wrappedAdd` until Unit 5
  // unblocks — dedup by nodeId so overload disambiguation doesn't see
  // phantom duplicates.
  const rawCallablePool = ctx.model.symbols.lookupCallableByName(calledName);
  const rawMethodPool = ctx.model.methods.lookupMethodByName(calledName);
  const combinedPool: SymbolDefinition[] = [];
  const combinedSeen = new Set<string>();
  for (const def of rawCallablePool) {
    if (combinedSeen.has(def.nodeId)) continue;
    combinedSeen.add(def.nodeId);
    combinedPool.push(def);
  }
  for (const def of rawMethodPool) {
    if (combinedSeen.has(def.nodeId)) continue;
    combinedSeen.add(def.nodeId);
    combinedPool.push(def);
  }
  const methodPool = filterCallableCandidates(combinedPool, argCount, callForm);
  const fileFiltered = methodPool.filter((c) => typeFiles.has(c.filePath));
  if (fileFiltered.length === 1) {
    return toResolveResult(fileFiltered[0], typeResolved.tier);
  }

  // ownerId fallback: narrow by ownerId matching the type's nodeId
  const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
  const ownerFiltered = pool.filter((c) => c.ownerId && typeNodeIds.has(c.ownerId));
  if (ownerFiltered.length === 1) return toResolveResult(ownerFiltered[0], typeResolved.tier);

  // Overload disambiguation on the narrowed pool
  if (fileFiltered.length > 1 || ownerFiltered.length > 1) {
    const overloadPool = ownerFiltered.length > 1 ? ownerFiltered : fileFiltered;
    const disambiguated = disambiguateByOverloadOrArgTypes(
      overloadPool,
      overloadHints,
      preComputedArgTypes,
    );
    if (disambiguated) return toResolveResult(disambiguated, typeResolved.tier);
  }

  // Zero-match null-route: receiver type resolved but no candidate matched
  // after file-based and owner-based narrowing. Refuse to emit a CALLS edge
  // rather than guess — matches the SM-10 R3 null-route contract.
  return null;
};

/** Return the sole survivor from a tiered pool after callable + arity filtering, or null. */
const singleCandidate = (
  tiered: TieredCandidates,
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
): ResolveResult | null => {
  const filtered = filterCallableCandidates(tiered.candidates, argCount, callForm);
  return filtered.length === 1 ? toResolveResult(filtered[0], tiered.tier) : null;
};

/** @internal Exported for unit tests. Do not use outside tests. */
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

  if (call.callForm === 'free') {
    return resolveFreeCall(
      call.calledName,
      currentFile,
      ctx,
      call.argCount,
      tiered,
      overloadHints,
      preComputedArgTypes,
    );
  }
  if (call.callForm === 'constructor') {
    return (
      resolveStaticCall(
        call.calledName,
        currentFile,
        ctx,
        call.argCount,
        tiered,
        overloadHints,
        preComputedArgTypes,
      ) ?? singleCandidate(tiered, call.argCount, 'constructor')
    );
  }
  if (call.receiverTypeName) {
    // Skip the owner-scoped MRO path when the tiered pool has genuine
    // overload ambiguity that needs D1-D4+E handling, not D0.
    const skipMember =
      (!!overloadHints || !!preComputedArgTypes) &&
      countCallableCandidates(tiered.candidates, call.argCount, call.callForm) > 1;
    // Try owner-scoped (resolveMemberCall) then file-scoped (resolveMemberCallByFile).
    const memberResult =
      (!skipMember
        ? resolveMemberCall(
            call.receiverTypeName,
            call.calledName,
            currentFile,
            ctx,
            heritageMap,
            call.argCount,
          )
        : null) ??
      resolveMemberCallByFile(
        call.calledName,
        call.receiverTypeName,
        currentFile,
        ctx,
        call.argCount,
        call.callForm,
        overloadHints,
        preComputedArgTypes,
      );
    if (memberResult) return memberResult;

    // Module-alias narrowing runs as a FALLBACK, after owner/file-scoped
    // resolvers have returned null. This ordering is load-bearing: placing
    // alias narrowing first would short-circuit unique owner-scoped answers
    // when a local variable coincidentally matches an alias name, leaking
    // unrelated homonyms from the aliased file onto the wrong receiver type.
    //
    // The type-file verification guard is load-bearing for SM-10 R3: an
    // alias is only a VALID narrowing signal when the alias target file is
    // among the receiver type's defining files. If the alias points at a
    // file that does not hold `receiverTypeName`, any candidate we would
    // pick from there would belong to an unrelated class — a cross-type
    // false positive. ctx.resolve is cached per (name, file), so resolving
    // the receiver type a second time here is free.
    const typeResolves = ctx.resolve(call.receiverTypeName, currentFile);
    const aliasMap = ctx.moduleAliasMap?.get(currentFile);
    const aliasTargetFile =
      call.receiverName && aliasMap ? aliasMap.get(call.receiverName) : undefined;
    if (
      aliasTargetFile &&
      typeResolves &&
      typeResolves.candidates.some((c) => c.filePath === aliasTargetFile)
    ) {
      const aliasResult = resolveModuleAliasedCall(call, currentFile, ctx, widenCache, tiered);
      if (aliasResult) return aliasResult;
    }

    // SM-10 R3 null-route: when the receiver type resolves to indexed types
    // but no scoped resolver (nor the guarded alias fallback) produced a
    // match, that's a genuine miss — refuse to emit a CALLS edge rather
    // than guess via an unscoped singleCandidate that ignores the class
    // hierarchy. When the type is NOT in the index (PHP `mixed`, dynamic
    // types, unresolvable aliases), the scoped resolvers had nothing to
    // work with and singleCandidate is the correct last resort.
    if (typeResolves && typeResolves.candidates.length > 0) {
      return null; // null-route: type resolved, no candidate matched
    }
    return singleCandidate(tiered, call.argCount, call.callForm);
  }
  // Member call with no inferred receiver type — e.g. Python `mod.fn()`
  // where `mod` is a module alias. Module-alias narrowing is the primary
  // disambiguation signal here. Also consulted from the typed-member
  // branch above as a guarded fallback after owner/file-scoped resolvers.
  return (
    resolveModuleAliasedCall(call, currentFile, ctx, widenCache, tiered) ??
    singleCandidate(tiered, call.argCount, call.callForm)
  );
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

  return ctx.model.fields.lookupFieldByOwner(classDef.nodeId, fieldName) ?? undefined;
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
 *   - 0 unique matches → `undefined` (owner-scoped path has no answer)
 *   - 1 unique match   → return it
 *   - ≥2 unique matches → `undefined` (genuine homonym ambiguity; don't silently pick one)
 *
 * The returned `tier` reflects how the owner TYPE was resolved (not the method name).
 * Threaded out here so callers don't need a second `ctx.resolve(ownerType, ...)` call —
 * this decouples callers from `ctx.resolve`'s per-file caching contract.
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

  // MRO walking needs a language hint so we can derive the per-language
  // strategy; compute it once and reuse for every candidate. Unknown
  // extension → fall back to plain direct lookup (D1-D4 still runs on miss).
  const language = heritageMap ? getLanguageFromFilename(filePath) : null;
  const mroStrategy = language != null ? getProvider(language).mroStrategy : null;
  const canWalkMRO = heritageMap != null && mroStrategy != null;

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
          ctx.model,
          mroStrategy,
          argCount,
        )
      : ctx.model.methods.lookupMethodByOwner(candidate.nodeId, methodName, argCount);
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
 * {@link resolveCallTarget} delegates here for member calls.
 *
 * **SEMANTIC CHANGE (2026-04-09):** The confidence tier reflects how the
 * owner TYPE was resolved, not how the method NAME was resolved globally.
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
// SM-13: Free-function call resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a free-function call using `lookupExact` (same-file) + import-scoped
 * resolution via `ctx.resolve()`.
 *
 * Used for `foo()`, `doStuff()` — unqualified calls with no receiver.
 * Also handles Swift/Kotlin implicit constructors (`User()` without `new`)
 * by delegating to {@link resolveStaticCall} when the tiered pool contains
 * class-like targets.
 *
 * {@link resolveCallTarget} delegates here for `callForm === 'free'`.
 *
 * `resolveFreeCall` does not take a `widenCache` parameter. Free calls
 * have no receiver type and rely exclusively on the tiered pool
 * from `ctx.resolve()`.
 *
 * @param calledName  - The called function name (e.g. 'doStuff')
 * @param filePath    - File path of the call site
 * @param ctx         - Resolution context
 * @param argCount    - Optional argument count for arity filtering
 * @param tieredOverride - Pre-computed tiered candidates from an upstream
 *                       `ctx.resolve` call. When provided, skips the redundant
 *                       lookup inside this function.
 * @param overloadHints  - Optional AST-based overload disambiguation hints
 * @param preComputedArgTypes - Optional pre-computed argument types (worker path)
 */
export const resolveFreeCall = (
  calledName: string,
  filePath: string,
  ctx: ResolutionContext,
  argCount?: number,
  tieredOverride?: TieredCandidates,
  overloadHints?: OverloadHints,
  preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
  const tiered = tieredOverride ?? ctx.resolve(calledName, filePath);
  if (!tiered) return null;

  let filteredCandidates = filterCallableCandidates(tiered.candidates, argCount, 'free');

  // Class-target fast path: Swift/Kotlin `User()` — free-form call targeting a
  // class. Delegates to resolveStaticCall for O(1) class + constructor lookup.
  // The `.some()` trigger must stay aligned with `INSTANTIABLE_CLASS_TYPES` —
  // any type admitted here that is not in that set will cause resolveStaticCall
  // to return null, wasting two lookup passes per call. `Enum` is deliberately
  // excluded; `Record` is included so C# records and Kotlin data classes reach
  // the fast path.
  // Align with INSTANTIABLE_CLASS_TYPES by reusing the set directly rather
  // than enumerating literal strings. This converts an invariant that was
  // previously enforced by a comment ("keep this list aligned with
  // INSTANTIABLE_CLASS_TYPES") into one enforced structurally — any future
  // extension of the set (e.g. Kotlin `object`) propagates here automatically.
  // The `dedupSwiftExtensionCandidates` helper used in the tail of this
  // function deliberately uses a narrower literal `'Class' | 'Struct'` check
  // — Swift extensions only produce Class duplicates in practice, so Record
  // is excluded there by design. Do not collapse that helper into
  // INSTANTIABLE_CLASS_TYPES.
  const hasClassTarget =
    filteredCandidates.length === 0 &&
    tiered.candidates.some((c) => INSTANTIABLE_CLASS_TYPES.has(c.type));
  if (hasClassTarget) {
    const staticResult = resolveStaticCall(calledName, filePath, ctx, argCount, tiered);
    if (staticResult) return staticResult;
    // Retry with constructor form: Swift/Kotlin constructor calls look like
    // free function calls (no `new` keyword). If resolveStaticCall didn't
    // match, re-filter with constructor form so CONSTRUCTOR_TARGET_TYPES
    // applies.
    //
    // The retry fires for every null return from `resolveStaticCall`, which
    // can happen for three distinct reasons — all three are handled below:
    //
    //   (a) No explicit `Constructor` node found and zero instantiable
    //       class candidates (e.g. Interface/Trait/Impl only — the SM-12
    //       null-route contract). `filterCallableCandidates` with
    //       `'constructor'` form will also return nothing → we fall
    //       through to the final null return. Correct.
    //
    //   (b) Homonym ambiguity — two or more instantiable class candidates
    //       share the name (e.g. `User` in two files, same tier). The
    //       retry repopulates `filteredCandidates` with both Classes and
    //       they flow into `dedupSwiftExtensionCandidates` below, which
    //       either picks the shortest-path primary or null-routes.
    //       Covered by the R7 Swift-extension dedup test.
    //
    //   (c) `resolveStaticCall` step 4 bailed because the tiered pool
    //       contains ownerless `Constructor` nodes (some extractors emit
    //       constructors without `ownerId`). Those `Constructor` nodes
    //       survive the constructor-form filter below and reach overload
    //       disambiguation, giving the existing filter path a chance to
    //       pick the right one. Correct but currently uncovered by a
    //       dedicated test — the R5 `preComputedArgTypes` path exercises
    //       overload disambiguation for Functions, which is structurally
    //       the same code.
    filteredCandidates = filterCallableCandidates(tiered.candidates, argCount, 'constructor');
  }

  // E. Overload disambiguation
  if (filteredCandidates.length > 1) {
    const disambiguated = overloadHints
      ? tryOverloadDisambiguation(filteredCandidates, overloadHints)
      : preComputedArgTypes
        ? matchCandidatesByArgTypes(filteredCandidates, preComputedArgTypes)
        : null;
    if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
  }

  if (filteredCandidates.length !== 1) {
    // See `dedupSwiftExtensionCandidates` — shared helper, single source of
    // truth for the Swift-extension same-name collision heuristic.
    const deduped = dedupSwiftExtensionCandidates(filteredCandidates, tiered.tier);
    if (deduped) return deduped;
    return null;
  }

  return toResolveResult(filteredCandidates[0], tiered.tier);
};

// ---------------------------------------------------------------------------
// SM-12: Constructor/static call resolution (no fuzzy lookup)
// ---------------------------------------------------------------------------

/**
 * Resolve a constructor or static call using class-scoped lookup (no fuzzy lookup).
 * Used for `new User()` / `User()` calls where the calledName targets a class.
 *
 * Uses {@link TypeRegistry.lookupClassByName} for O(1) class lookup and
 * {@link MethodRegistry.lookupMethodByOwner} for constructor resolution.
 * {@link resolveCallTarget} delegates here for constructor and free-form calls
 * that target a class.
 *
 * Resolution strategy:
 *   1. `lookupClassByName(className)` — O(1) pre-check; bail early if no class exists.
 *   2. `ctx.resolve(className, currentFile)` — import-scoped tier for confidence.
 *   3. Filter to class-like candidates via `CLASS_LIKE_TYPES` and walk each
 *      with `lookupMethodByOwner(classNodeId, className, argCount)` — O(1)
 *      constructor lookup. Only accept results with `type === 'Constructor'`.
 *   4. If step 3 found nothing and the tiered pool contains ownerless
 *      `Constructor` nodes (common in some extractors), bail out so
 *      `filterCallableCandidates` downstream handles Constructor-vs-Class
 *      preference correctly.
 *   5. Class-node fallback: filter `classCandidates` through
 *      `INSTANTIABLE_CLASS_TYPES` and return the sole survivor when there is
 *      exactly one. Null-route on zero survivors (Interface / Trait / Impl
 *      stripped) or multiple (homonym ambiguity).
 *
 * @param className   - The class name (e.g. 'User'). Also used as the method
 *                       name for the `lookupMethodByOwner` scan, because the
 *                       only constructor-shaped call we handle today is
 *                       `ClassName(...)` / `new ClassName(...)`. Named
 *                       constructors like Dart `User.fromJson()` arrive as
 *                       member calls and route through `resolveMemberCall`,
 *                       so this function does not yet need a separate
 *                       `methodName` parameter. Revisit if a language surfaces
 *                       a static-method-shaped call with a distinct member
 *                       name.
 * @param currentFile - File path of the call site
 * @param ctx         - Resolution context
 * @param argCount    - Optional argument count for arity filtering
 * @param tieredOverride - Pre-computed tiered candidates for `className` from
 *                       an upstream `ctx.resolve` call. When provided, skips
 *                       the redundant lookup inside this function. Leave
 *                       unset for direct callers without a prior resolution.
 */
export const resolveStaticCall = (
  className: string,
  currentFile: string,
  ctx: ResolutionContext,
  argCount?: number,
  tieredOverride?: TieredCandidates,
  overloadHints?: OverloadHints,
  preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
  // 1. Pre-check: does a class with this name exist at all? (O(1))
  //    This guards against the expensive `ctx.resolve` walk when the name
  //    is clearly not class-like (e.g. plain functions). When `tieredOverride`
  //    is supplied, the caller has already paid for the tiered lookup, so this
  //    pre-check still prevents the class-candidate filter + lookupMethodByOwner
  //    loop from running on obviously non-class targets.
  const allClasses = ctx.model.types.lookupClassByName(className);
  if (allClasses.length === 0) return null;

  // 2. Scope via ctx.resolve for import-tier information. Reuse the caller's
  //    tiered result when provided — it is computed from the same name and
  //    file context, so re-running the walk would be a pure waste.
  const typeResolved = tieredOverride ?? ctx.resolve(className, currentFile);
  if (!typeResolved) return null;

  const classCandidates = typeResolved.candidates.filter((c) => CLASS_LIKE_TYPES.has(c.type));
  if (classCandidates.length === 0) return null;

  // 3. Try lookupMethodByOwner for explicit Constructor nodes.
  //    Only accept results with type === 'Constructor' — a Method or Function
  //    that happens to share the class name (e.g. C++ methods named after
  //    their class) is not a constructor for resolution purposes.
  //    Same dedup logic as resolveMethodByOwner: diamond inheritance converging
  //    on the same constructor collapses to one hit.
  //
  //    Same-name assumption: the lookup key is `${candidate.nodeId}\0${className}`,
  //    so this finds Constructor nodes whose symbol name equals the class name
  //    (`class User` with a `Constructor` named `User`). Constructors indexed
  //    under a different name (e.g. Python `__init__`) will not be found here —
  //    but they also won't appear in the tiered pool for `ctx.resolve(className)`
  //    for the same reason, so step 4's Constructor-presence check will not
  //    see them either. The two miss cases are symmetric. If a future extractor
  //    indexes Constructor nodes under an alternative name while still setting
  //    `ownerId`, this assumption will need revisiting.
  let firstDef: SymbolDefinition | undefined;
  let ambiguous = false;
  for (const candidate of classCandidates) {
    const def = ctx.model.methods.lookupMethodByOwner(candidate.nodeId, className, argCount);
    if (!def || def.type !== 'Constructor') continue;
    if (!firstDef) {
      firstDef = def;
    } else if (def.nodeId !== firstDef.nodeId) {
      ambiguous = true;
      break;
    }
  }

  if (firstDef && !ambiguous) {
    return toResolveResult(firstDef, typeResolved.tier);
  }

  // 4. lookupMethodByOwner found nothing — check whether the tiered pool
  //    contains Constructor nodes that lack ownerId (common in some extractors).
  //    If so, bail out so the existing filterCallableCandidates path handles
  //    Constructor-vs-Class preference correctly.
  //
  //    This branch also catches the step-3 ambiguous case (`ambiguous = true`
  //    with two distinct Constructor nodes across multiple class candidates):
  //    the same Constructor nodes are indexed under the class name in the
  //    tiered pool, so `.some(Constructor)` is true here and we defer to
  //    step 4.5 (overload/arg-type disambiguation) or the caller's fallback.
  //    Do not remove this check without also handling the ambiguous step-3
  //    path explicitly.
  if (typeResolved.candidates.some((c) => c.type === 'Constructor')) {
    // 4.5. Overload / arg-type disambiguation for ambiguous or ownerless
    //      Constructor pools. When the caller supplied a narrowing signal
    //      (AST-based overload hints from the sequential path, or pre-
    //      computed arg types from the worker path), give disambiguation a
    //      chance before null-routing. Symmetric with resolveMemberCallByFile's
    //      disambiguation pass — both resolvers now share the same signal
    //      precedence via disambiguateByOverloadOrArgTypes. Only fires when
    //      at least one narrowing signal is present; preserves SM-10 R3 for
    //      genuinely ambiguous cases with no disambiguating input.
    if (overloadHints || preComputedArgTypes) {
      const ctorPool = filterCallableCandidates(typeResolved.candidates, argCount, 'constructor');
      if (ctorPool.length > 1) {
        const disambiguated = disambiguateByOverloadOrArgTypes(
          ctorPool,
          overloadHints,
          preComputedArgTypes,
        );
        if (disambiguated) return toResolveResult(disambiguated, typeResolved.tier);
      }
    }
    return null;
  }

  // 5. No constructor nodes at all — fall back to the class node itself, but
  //    ONLY when it is actually instantiable. Interface / Trait / Impl / Enum
  //    are deliberately excluded via `INSTANTIABLE_CLASS_TYPES` to prevent
  //    false `CALLS` edges from constructor-shaped calls to non-instantiable
  //    nodes. This also disambiguates the Rust same-file shadowing case
  //    (`struct User` + `impl User` both present at same-file tier): the
  //    Impl is stripped, leaving the Struct as the sole instantiable target.
  //    Addresses Codex review finding on PR #754.
  const instantiableCandidates = classCandidates.filter((c) =>
    INSTANTIABLE_CLASS_TYPES.has(c.type),
  );
  // Three outcomes below, in order of likelihood after the fix:
  //   length === 0 → all candidates were stripped as non-instantiable (e.g.
  //     Interface / Trait / Impl). Null-route via the fall-through `return
  //     null` — this is the dominant Codex-fix case.
  //   length === 1 → a single instantiable candidate remains, return it.
  //   length  >  1 → two or more instantiable classes share the name (e.g.
  //     homonym classes across files with no import narrowing). Fall through
  //     to `return null` so the caller null-routes rather than guess.
  if (instantiableCandidates.length === 1) {
    return toResolveResult(instantiableCandidates[0], typeResolved.tier);
  }

  return null;
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
      // Fallback: resolve via resolveCallTarget dispatcher (delegates to resolveMemberCall)
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
 *
 * @param bindingAccumulator  Phase 9: optional accumulator carrying file-scope
 *   TypeEnv bindings from all worker-processed files. When the SymbolTable has
 *   no return type for a cross-file callee, `verifyConstructorBindings` falls
 *   back to the accumulator via `namedImportMap` to bind the variable to the
 *   callee's resolved type (e.g. `var x = getUser()` → `x: User`).
 */
export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  constructorBindings?: FileConstructorBindings[],
  heritageMap?: HeritageMap,
  bindingAccumulator?: BindingAccumulator,
) => {
  // Scope-aware receiver types: keyed by filePath → "funcName\0varName" → typeName.
  // The scope dimension prevents collisions when two functions in the same file
  // have same-named locals pointing to different constructor types.
  const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
  if (constructorBindings) {
    for (const { filePath, bindings } of constructorBindings) {
      const verified = verifyConstructorBindings(
        bindings,
        filePath,
        ctx,
        graph,
        bindingAccumulator,
      );
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
  bindingAccumulator?: BindingAccumulator,
): void => {
  // Build per-file receiver type indexes from verified constructor bindings
  const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
  if (constructorBindings) {
    for (const { filePath, bindings } of constructorBindings) {
      const verified = verifyConstructorBindings(
        bindings,
        filePath,
        ctx,
        graph,
        bindingAccumulator,
      );
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
