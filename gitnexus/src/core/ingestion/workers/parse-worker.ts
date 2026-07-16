import { parentPort, threadId, workerData } from 'node:worker_threads';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CPP from 'tree-sitter-cpp';
// Explicit subpath import — see parser-loader.ts for rationale (#1013).
import CSharp from 'tree-sitter-c-sharp/bindings/node/index.js';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { requireVendoredGrammar } from '../../tree-sitter/vendored-grammars.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../languages/index.js';
import {
  getTreeSitterBufferSize,
  getTreeSitterContentByteLength,
  TREE_SITTER_MAX_BUFFER,
} from '../constants.js';
import {
  ARRAY_METHOD_HOC_BLOCKLIST_SET,
  DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET,
  deriveDefaultExportHocName,
} from '../ts-js-hoc-utils.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import type { SkippedPath } from './clone-safety.js';
import { postResultCloneSafe } from './post-result.js';
import { mergeResult } from './result-merge.js';
import type { SymbolTableReader } from '../model/symbol-table.js';
import type {
  ExtractedRouterConstructorPrefix,
  ExtractedRouterInclude,
  ExtractedRouterImport,
  ExtractedRouterModuleAlias,
} from '../route-extractors/fastapi-router-bindings.js';

/** Language grammar type accepted by Parser.setLanguage(). */
type TreeSitterLanguage = Parameters<typeof Parser.prototype.setLanguage>[0];

// ── Worker grammar loading — enforcement boundary (#2091/#2093, #2101) ───────
// The worker maintains its own grammar table (the guarded vendored-grammar
// loads below + `languageMap`) and intentionally does NOT consult the runtime
// `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` opt-out. It does not need to: the MAIN
// THREAD's `parseableScanned` filter (pipeline-phases/parse-impl.ts, gated on
// `parser-loader.isLanguageAvailable`, which honors the runtime opt-out and a
// genuinely-absent binding alike) excludes files of an unavailable/opted-out
// language BEFORE any chunk is dispatched, so the worker never receives them.
// That main-thread filter is the single enforcement point. Any future change
// that dispatches files to the worker WITHOUT first passing them through
// `isLanguageAvailable` must re-introduce the gate here. (The cleaner end-state
// — routing this table through `parser-loader.getLanguageGrammar` so there is
// one loader — is the deferred Tier-1 consolidation.)
// Swift/Dart/Kotlin/C are vendored grammars loaded from `vendor/` by absolute
// path (NEVER copied into node_modules — see vendored-grammars.ts / #2111). Each
// may be absent on a platform without a prebuild or a toolchain-less /
// `--ignore-scripts` install, so every load is guarded so a missing binding
// cannot crash the worker at module-load (#2091/#2093, #2116).
let Swift: TreeSitterLanguage | null = null;
try {
  Swift = requireVendoredGrammar('tree-sitter-swift') as TreeSitterLanguage;
} catch {}

let Dart: TreeSitterLanguage | null = null;
try {
  Dart = requireVendoredGrammar('tree-sitter-dart') as TreeSitterLanguage;
} catch {}

let Kotlin: TreeSitterLanguage | null = null;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin') as TreeSitterLanguage;
} catch {}

let C: TreeSitterLanguage | null = null;
try {
  C = requireVendoredGrammar('tree-sitter-c') as TreeSitterLanguage;
} catch {}
import { getLanguageFromFilename } from 'gitnexus-shared';
import {
  buildConcreteTypedefDefinitionRanges,
  FUNCTION_NODE_TYPES,
  findAncestorBeforeBoundary,
  getDefinitionNodeFromCaptures,
  findEnclosingClassInfo,
  findObjectLiteralBindingInfo,
  type EnclosingClassInfo,
  getLabelFromCaptures,
  genericFuncName,
  inferFunctionLabel,
  isSuppressedConcreteTypedefDuplicate,
  isQualifiableScopeLabel,
  qualifyRustImplTargetByModScope,
  CLASS_CONTAINER_TYPES,
  PARAMETER_LIST_NODE_TYPES,
  LOCAL_SCOPE_BODY_NODE_TYPES,
  type SyntaxNode,
} from '../utils/ast-helpers.js';
import { extractCallArgTypes, type MixedChainStep } from '../utils/call-analysis.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { generateId } from '../../../lib/utils.js';
import {
  extractVueScript,
  extractTemplateComponents,
  isVueSetupTopLevel,
} from '../vue-sfc-extractor.js';
import type { NodeLabel, ParameterTypeClass } from 'gitnexus-shared';
import type { FieldInfo, FieldExtractorContext } from '../field-types.js';
import type { MethodInfo, MethodExtractorContext } from '../method-types.js';
import type { VariableExtractorContext, VariableInfo } from '../variable-types.js';
import {
  buildMethodProps,
  arityForIdFromInfo,
  typeTagForId,
  constTagForId,
  buildCollisionGroups,
  parameterShapeIdTag,
} from '../utils/method-props.js';
import {
  extractTemplateArguments,
  templateArgumentsIdTag,
  templateConstraintsIdTag,
} from '../utils/template-arguments.js';
import type { LanguageProvider } from '../language-provider.js';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile, type ScopeCaptureSourceKind } from '../scope-extractor-bridge.js';
import {
  persistParsedFileShardSync,
  persistDurableParsedFileShardSync,
} from '../../../storage/parsedfile-store.js';
import { extractLaravelRoutes, type ExtractedRoute } from '../route-extractors/laravel.js';
import type { SharedSpringType } from '../route-extractors/spring-shared.js';
import {
  collectFunctionCfgs,
  DEFAULT_PDG_MAX_FUNCTION_LINES,
  type CfgSkipCounts,
} from '../cfg/collect.js';

import { logger } from '../../logger.js';
export type { ExtractedRoute } from '../route-extractors/laravel.js';

// ── ParsedFile store (#1983 parallel serialization) ─────────────────────────
// Read ONCE at worker init from `workerData` (immutable for the run, inherited
// by respawned workers via the pool's factory closure). When set, this worker
// writes its own ParsedFile shards to disk at each job flush instead of
// returning them over the MessageChannel — parallelizing serialization off the
// main thread. `undefined` ⇒ return ParsedFiles in the result (no-store
// fallback). `shardSeq` makes each shard name unique within this worker; global
// uniqueness for the run rests on the process-monotonic `threadId` (never reused
// across respawns) plus the per-run store clear on the main thread.
const PARSED_FILE_STORE_STORAGE_PATH: string | undefined = (
  workerData as { parsedFileStoreStoragePath?: string } | undefined
)?.parsedFileStoreStoragePath;
// Durable, content-addressed ParsedFile store dir (#2038 warm-cache coverage).
// When set AND the flush carries a chunk hash, the worker ALSO writes its
// ParsedFiles to `<durableDir>/<chunkHash>/` so a future warm parse-cache hit
// restores them without re-parsing. `undefined` ⇒ no durable write.
const DURABLE_PARSED_FILE_STORAGE_PATH: string | undefined = (
  workerData as { durableParsedFileStoragePath?: string } | undefined
)?.durableParsedFileStoragePath;
let shardSeq = 0;

// ── PDG/CFG opt-in (#2081 M1) ───────────────────────────────────────────────
// Read ONCE at worker init from `workerData` (the worker never sees
// PipelineOptions — config arrives via the pool factory's `workerData`, see
// KTD7 / U5). When `pdg` is set, the worker builds a per-function control-flow
// graph from the tree-sitter AST (where it lives) and serializes it onto
// `ParsedFile.cfgSideChannel`. Off ⇒ no CFG work and no field — the default for
// every run today. `pdgMaxFunctionLines` bounds per-function CFG cost
// (0/undefined ⇒ no cap; see collectFunctionCfgs).
const PDG_ENABLED: boolean = (workerData as { pdg?: boolean } | undefined)?.pdg === true;
const PDG_MAX_FUNCTION_LINES: number =
  (workerData as { pdgMaxFunctionLines?: number } | undefined)?.pdgMaxFunctionLines ??
  DEFAULT_PDG_MAX_FUNCTION_LINES;

// ── Bootstrap-stage diagnostics (#1741) ────────────────────────────────────
// When GITNEXUS_WORKER_BOOTSTRAP=1 (or --verbose sets GITNEXUS_VERBOSE), each
// worker reports its startup stage timings to stderr — which the pool tees
// and captures (worker-pool.ts captureWorkerStderr). This makes a slow or
// crashing startup diagnosable: you can see whether a worker reached
// "grammars loaded", "ready sent", or never emitted a line at all (=> it
// crashed in a native binding load before this code ran). The pool then
// attaches whatever stderr it captured to its readiness-failure message,
// so the operator sees the real cause instead of "did not report ready".
const BOOTSTRAP_LOG =
  process.env.GITNEXUS_WORKER_BOOTSTRAP === '1' || process.env.GITNEXUS_VERBOSE === '1';
const bootstrapStart = performance.now();
const bootstrapLog = (stage: string): void => {
  if (!BOOTSTRAP_LOG) return;
  const ms = Math.round(performance.now() - bootstrapStart);
  process.stderr.write(`[parse-worker bootstrap] thread=${threadId} ${stage} (+${ms}ms)\n`);
};
// First line we can emit: every static import above (tree-sitter native
// bindings, language grammars, helper modules) has already resolved by the
// time this module-body statement runs.
bootstrapLog('imports + grammars loaded');
// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: SupportedLanguages;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    // Method/field metadata — extensible via buildMethodProps spread
    [key: string]: unknown;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD' | 'HAS_PROPERTY';
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: NodeLabel;
  qualifiedName?: string;
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
  parameterTypeClasses?: ParameterTypeClass[];
  returnType?: string;
  declaredType?: string;
  templateArguments?: string[];
  ownerId?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
  isAbstract?: boolean;
  isFinal?: boolean;
  isDeleted?: boolean;
  annotations?: string[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** From call AST; omitted for some seeds (e.g. Java `::`) so arity filter is skipped */
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
   * Steps are ordered base-first (innermost to outermost). Examples:
   *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
   *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
   *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverMixedChain?: MixedChainStep[];
  argTypes?: (string | undefined)[];
}

export interface ExtractedAssignment {
  filePath: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** Receiver text (e.g., 'user' from user.address = value) */
  receiverText: string;
  /** Property name being written (e.g., 'address') */
  propertyName: string;
  /** Resolved type name of the receiver if available from TypeEnv */
  receiverTypeName?: string;
  /** 1-indexed line number of the assignment site (used for per-site dedup) */
  line?: number;
}

export interface ExtractedFetchCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

export interface FetchWrapperDef {
  filePath: string;
  functionName: string;
}

export interface ExtractedDecoratorRoute {
  filePath: string;
  routePath: string;
  httpMethod: string;
  decoratorName: string;
  lineNumber: number;
  /**
   * Decorator receiver identifier (e.g. `router` for `@router.get(...)`,
   * `app` for `@app.get(...)`). Used by parse-impl to decide which routes
   * participate in `include_router(prefix=...)` joining.
   */
  decoratorReceiver?: string;
  /**
   * Raw text of a non-literal decorator path argument (`#2391`), e.g.
   * `API_V1_WIDGETS_GET` or `API_V1 + "/widgets"`. Present only when the
   * decorator's first argument was NOT a string literal, in which case
   * `routePath` is empty and parse-impl resolves the constant cross-file (or
   * drops the route on failure). Absent for ordinary string-literal routes.
   */
  routePathExpr?: string;
  /**
   * Parsed operand list for {@link routePathExpr} — an identifier reference or a
   * `+`-concatenation, in the {@link Operand} shape the constant resolver folds.
   * `undefined` when the expression was not a foldable string form (e.g. an
   * attribute access), in which case the route is dropped at resolution.
   */
  routePathOperands?: Operand[];
  /**
   * FastAPI `app.include_router(prefix='/x')` prefix that applies to
   * this route. Filled by parse-impl after cross-file aggregation; the
   * routes phase joins it via `normalizeExtractedRoutePath`. `null` /
   * absent ⇒ no prefix applies.
   */
  prefix?: string | null;
  /**
   * Name of the handler the route decorator sits on (the decorated
   * method/function — e.g. `create` for `@PostMapping("/orders") Order create()`).
   * Captured at extraction where the decorated definition node is in hand, so
   * the routes phase can resolve it to a real handler symbol UID via the
   * SemanticModel (same `(filePath, name) → nodeId` lookup Laravel routes use).
   * Absent when the extractor could not identify the decorated definition;
   * resolution then falls back (the Route node simply carries no handlerSymbolId).
   */
  handlerName?: string;
}

/**
 * One Python file's module-level string constants (#2391), used by parse-impl to
 * resolve non-literal decorator route paths cross-file. `constants` is the
 * `Map`-based {@link ModuleConstants} shape — it survives the worker
 * `postMessage` boundary (structured clone) and the parse cache
 * (`mapReplacer`/`mapReviver`) without conversion.
 */
export interface ExtractedModuleConstants {
  filePath: string;
  constants: ModuleConstants;
}

export interface ExtractedToolDef {
  filePath: string;
  toolName: string;
  description: string;
  lineNumber: number;
  handlerNodeId?: string;
}

export interface ExtractedORMQuery {
  filePath: string;
  orm: 'prisma' | 'supabase';
  model: string;
  method: string;
  lineNumber: number;
}

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

/** All-scope type bindings from TypeEnv — includes function-local scopes.
 *  Used by BindingAccumulator for cross-file type propagation (Phase 9+).
 *
 *  Carries only file-scope entries (`scope = ''`). Serializing function-scope
 *  bindings over IPC cost ~4.9 MB with zero downstream consumers.
 *  `parse-worker.ts` now iterates only `typeEnv.fileScope()` and the
 *  sequential path's `type-env.ts::flush()` is also narrowed to file
 *  scope — see the `BindingAccumulator` class JSDoc for the unified
 *  narrowing contract across both execution paths.
 *
 *  **Phase 9 reversion checklist** (when a downstream consumer of
 *  function-scope bindings lands):
 *    1. Change the loop in `runParseJob` below from `typeEnv.fileScope()`
 *       back to `typeEnv.allScopes()`.
 *    2. Emit three-element tuples `[scope, varName, typeName]`.
 *    3. Widen the `bindings` field on this interface back to
 *       `[string, string, string][]`.
 *    4. Update the pipeline adapter in `pipeline.ts` to unpack three
 *       elements and populate `BindingEntry.scope` from the first tuple
 *       element instead of hardcoding `''`.
 *    5. Also revert `type-env.ts::flush()` to iterate `env` instead of
 *       just `FILE_SCOPE` if the sequential path needs function-scope data too.
 *    6. Consider renaming this interface back to `FileAllScopeBindings`
 *       along with widening. */
export interface FileScopeBindings {
  filePath: string;
  /** [varName, typeName] pairs from the file scope only. */
  bindings: [string, string][];
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  fetchWrapperDefs: FetchWrapperDef[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  routerIncludes: ExtractedRouterInclude[];
  routerImports: ExtractedRouterImport[];
  routerConstructorPrefixes?: ExtractedRouterConstructorPrefix[];
  /**
   * Optional. Project-wide `SharedSpringType` view of route-defining
   * class/interface declarations, produced by the provider's
   * `extractRouteInheritanceTypes` hook (Java/Spring). parse-impl aggregates
   * these and runs a cross-file pass that resolves interface-inherited routes
   * into additional `decoratorRoutes` (#2288). Optional for cache backward
   * compatibility; consumers must guard with `?? []`.
   */
  springTypes?: SharedSpringType[];
  /**
   * Optional. `from <pkg> import <module>` records from Python files
   * where `<module>` is later used as a Shape-A include receiver
   * (`<host>.include_router(<module>.router, prefix='/x')`). parse-impl
   * uses these to promote Shape-A short-key entries to long keys, so
   * same-named modules in different packages don't share prefixes.
   * Optional for cache backward compatibility (older cache entries
   * predate the field; consumers must guard with `if (… ?? [])`).
   */
  routerModuleAliases?: ExtractedRouterModuleAlias[];
  /**
   * Per-file Python module-level string constants (#2391). parse-impl aggregates
   * these into a repo-wide, file-path-keyed map and resolves each decorator
   * route's non-literal path expression against it. Optional for cache backward
   * compatibility (older entries predate the field; consumers guard with `?? []`).
   */
  moduleConstants?: ExtractedModuleConstants[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  constructorBindings: FileConstructorBindings[];
  /** All-scope type bindings from TypeEnv for BindingAccumulator (includes function-local). */
  fileScopeBindings: FileScopeBindings[];
  /**
   * Per-file `ParsedFile` artifacts from the new scope-based resolution
   * pipeline (RFC #909 Ring 2). Empty unless the file's provider implements
   * `emitScopeCaptures` — default for every language today, so this is
   * additive and leaves the legacy DAG untouched. Consumed by #921's
   * finalize-orchestrator.
   */
  parsedFiles: ParsedFile[];
  skippedLanguages: Record<string, number>;
  /**
   * Files whose parse output carried a value the structured-clone algorithm
   * couldn't serialize across the worker boundary (#2112). The clone-safety
   * net stripped or dropped the offending value so the result could be
   * delivered; these paths are surfaced to the operator so the (rare) data
   * loss is visible. Optional for cache backward compatibility — older cache
   * entries predate the field; consumers must guard with `?? []`.
   */
  skippedPaths?: SkippedPath[];
  /**
   * Per-language CFG-bearing functions skipped during the worker walk, bucketed
   * by reason (#2195): too-many-lines, too-deeply-nested (the proactive
   * depth-guard bail), or build-error. Survives the parse cache (a small number
   * map, kept by `...result` in slimParseWorkerResultsForCache) and is merged +
   * logged per-language in `dispatchChunkParse` (alongside `skippedLanguages`),
   * so a CFG coverage gap is visible. Like that sibling telemetry the warn is
   * emitted for freshly-parsed chunks, not re-emitted on a warm cache hit.
   * Optional for cache backward-compatibility — older shards predate it.
   */
  cfgSkipped?: Record<string, CfgSkipCounts>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

type WorkerIncomingMessage =
  | { type: 'sub-batch'; files: ParseWorkerInput[] }
  | { type: 'flush'; chunkHash?: string };

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const languageMap: Record<string, TreeSitterLanguage> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  ...(C ? { [SupportedLanguages.C]: C } : {}),
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Ruby]: Ruby,
  [SupportedLanguages.Vue]: TypeScript.typescript,
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// ============================================================================
// Per-file O(1) memoization — avoids repeated parent-chain walks per symbol.
// Three bare Maps cleared at file boundaries. Map.get() returns undefined for
// missing keys, so `cached !== undefined` distinguishes "not computed" from
// a stored null (enclosing class/function not found = top-level).
// ============================================================================

const classIdCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const functionIdCache = new Map<SyntaxNode, string | null>();
const exportCache = new Map<SyntaxNode, boolean>();

const clearCaches = (): void => {
  classIdCache.clear();
  functionIdCache.clear();
  exportCache.clear();
  fieldInfoCache.clear();
  methodInfoCache.clear();
};

// ============================================================================
// FieldExtractor cache — extract field metadata once per class, reuse for each property.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const fieldInfoCache = new Map<number, Map<string, FieldInfo>>();

/**
 * Walk up from a definition node to find the nearest enclosing class/struct/interface
 * AST node. Returns the SyntaxNode itself (not an ID) for passing to FieldExtractor.
 */
function findEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Return singleton_class directly so the method extractor sees it as
      // the owner node and correctly marks methods as static. Name resolution
      // for qualified names is handled separately by findEnclosingClassInfo.
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * For C++ out-of-class method definitions (e.g. `void Foo::bar() {}`), extract the
 * class name from the qualified_identifier scope and find the class declaration in the
 * file's AST. Returns the class SyntaxNode or null if not found.
 *
 * Handles pointer/reference return types where function_declarator is nested inside
 * pointer_declarator or reference_declarator.
 */
function findClassNodeByQualifiedName(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;

  // Find the function_declarator, recursively unwrapping pointer_declarator /
  // reference_declarator chains (e.g. int** Foo::bar() has
  // pointer_declarator → pointer_declarator → function_declarator).
  let funcDecl: SyntaxNode | null = null;
  if (declarator.type === 'function_declarator') {
    funcDecl = declarator;
  } else {
    let current: SyntaxNode | null = declarator;
    while (current && !funcDecl) {
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'function_declarator') {
          funcDecl = child;
          break;
        }
      }
      if (!funcDecl) {
        const next = current.namedChildren.find(
          (c) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
        );
        current = next ?? null;
      }
    }
  }
  if (!funcDecl) return null;

  // Check if the inner declarator is a qualified_identifier (Foo::bar)
  const innerDecl = funcDecl.childForFieldName('declarator');
  if (!innerDecl || innerDecl.type !== 'qualified_identifier') return null;

  const scope = innerDecl.childForFieldName('scope');
  if (!scope) return null;
  const className = scope.text;

  // Search the file for a matching class/struct specifier, including inside
  // namespace_definition blocks (the majority of production C++ uses namespaces).
  const root = node.tree.rootNode;
  const classTypes = new Set(['class_specifier', 'struct_specifier']);
  const searchIn = (parent: SyntaxNode): SyntaxNode | null => {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (classTypes.has(child.type)) {
        const nameNode = child.childForFieldName('name');
        if (nameNode?.text === className) return child;
      }
      // Recurse into namespace blocks
      if (child.type === 'namespace_definition') {
        const found = searchIn(child);
        if (found) return found;
      }
    }
    return null;
  };
  return searchIn(root);
}

/**
 * Minimal no-op SymbolTable stub for FieldExtractorContext in the worker.
 * Field extraction only uses symbolTable.lookupExactAll for optional type
 * resolution — returning [] causes the extractor to use the raw type
 * string, which is fine for us. Every other method is a no-op so the
 * stub remains safe if a future FieldExtractor consults it through the
 * full {@link SymbolTableReader} surface.
 */
const NOOP_SYMBOL_TABLE: SymbolTableReader = {
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
  lookupExactAll: () => [],
  lookupCallableByName: () => [],
  getFiles: () => [][Symbol.iterator](),
  getStats: () => ({ fileCount: 0 }),
};

/**
 * Get (or extract and cache) field info for a class node.
 * Returns a name→FieldInfo map, or undefined if the provider has no field extractor
 * or the class yielded no fields.
 */
function getFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = fieldInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.fieldExtractor.extract(classNode, context);
  if (!result?.fields?.length) return undefined;

  cached = new Map<string, FieldInfo>();
  for (const field of result.fields) {
    cached.set(field.name, field);
  }
  fieldInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// MethodExtractor cache — extract method metadata once per class, reuse for each method.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const methodInfoCache = new Map<number, Map<string, MethodInfo>>();

/**
 * Get (or extract and cache) method info for a class node.
 * Returns a "name:line" → MethodInfo map, or undefined if the provider has no method extractor
 * or the class yielded no methods.
 * Keyed by name:line (not name alone) to support overloaded methods in Java/Kotlin.
 */
function getMethodInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: MethodExtractorContext,
): Map<string, MethodInfo> | undefined {
  if (!provider.methodExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = methodInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.methodExtractor.extract(classNode, context);
  if (!result?.methods?.length) return undefined;

  cached = new Map<string, MethodInfo>();
  for (const method of result.methods) {
    cached.set(`${method.name}:${method.line}`, method);
  }
  methodInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// Enclosing function detection (for call extraction) — cached
// ============================================================================

/** Walk up AST to find enclosing function, return its generateId or null for top-level.
 *  Applies provider.labelOverride so the label matches the definition phase (single source of truth). */
const findEnclosingFunctionId = (
  node: SyntaxNode,
  filePath: string,
  provider: LanguageProvider,
): string | null => {
  const cached = functionIdCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const efnResult = provider.methodExtractor?.extractFunctionName?.(current, filePath);
      const funcName = efnResult?.funcName ?? genericFuncName(current);
      const label = efnResult?.label ?? inferFunctionLabel(current.type);
      if (funcName) {
        // Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
        // null means "skip as definition" — keep original label for scope identification.
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        // Qualify with enclosing class to match definition-phase node IDs
        const classInfo = cachedFindEnclosingClassInfo(
          current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const encLang = getLanguageFromFilename(filePath);
        const standaloneMethodInfo =
          (finalLabel === 'Method' || finalLabel === 'Constructor') &&
          encLang === SupportedLanguages.Go &&
          provider.methodExtractor?.extractFromNode
            ? provider.methodExtractor.extractFromNode(current, {
                filePath,
                language: encLang,
              })
            : null;
        const ownerName = classInfo?.className ?? standaloneMethodInfo?.receiverType ?? undefined;
        const qualifiedName = ownerName ? `${ownerName}.${funcName}` : funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // Use the same MethodExtractor (getMethodInfo) as the definition phase.
        // When same-arity collisions exist, also append ~type1,type2.
        let arity: number | undefined;
        let encTypeTag = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          if (standaloneMethodInfo) {
            arity = standaloneMethodInfo.parameters.some((p) => p.isVariadic)
              ? undefined
              : standaloneMethodInfo.parameters.length;
          } else {
            const classNode =
              findEnclosingClassNode(current) ?? findClassNodeByQualifiedName(current);
            if (classNode && encLang) {
              const methodMap = getMethodInfo(classNode, provider, {
                filePath,
                language: encLang,
              });
              const defLine = current.startPosition.row + 1;
              const info = methodMap?.get(`${funcName}:${defLine}`);
              if (info) {
                arity = info.parameters.some((p) => p.isVariadic)
                  ? undefined
                  : info.parameters.length;
                if (methodMap && arity !== undefined) {
                  const g = buildCollisionGroups(methodMap);
                  encTypeTag =
                    typeTagForId(methodMap, funcName, arity, info, encLang, g) +
                    constTagForId(methodMap, funcName, arity, info, g);
                }
              }
            }
          }
        }
        const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        let finalLabel: NodeLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling, finalLabel);
          if (override !== null) finalLabel = override;
        }
        // Qualify custom result with enclosing class
        const classInfo = cachedFindEnclosingClassInfo(
          current.previousSibling ?? current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const qualifiedName = classInfo
          ? `${classInfo.className}.${customResult.funcName}`
          : customResult.funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // When same-arity collisions exist, also append ~type1,type2.
        const sigNode = current.previousSibling ?? current;
        let arity2: number | undefined;
        let encTypeTag2 = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          const encLang2 = getLanguageFromFilename(filePath);
          const classNode2 =
            findEnclosingClassNode(sigNode) ?? findClassNodeByQualifiedName(sigNode);
          if (classNode2 && encLang2) {
            const methodMap2 = getMethodInfo(classNode2, provider, {
              filePath,
              language: encLang2,
            });
            const defLine2 = sigNode.startPosition.row + 1;
            const info2 = methodMap2?.get(`${customResult.funcName}:${defLine2}`);
            if (info2) {
              arity2 = info2.parameters.some((p) => p.isVariadic)
                ? undefined
                : info2.parameters.length;
              if (methodMap2 && arity2 !== undefined) {
                const g2 = buildCollisionGroups(methodMap2);
                encTypeTag2 =
                  typeTagForId(methodMap2, customResult.funcName, arity2, info2, encLang2, g2) +
                  constTagForId(methodMap2, customResult.funcName, arity2, info2, g2);
              }
            }
          }
        }
        const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag2}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    current = current.parent;
  }
  functionIdCache.set(node, null);
  return null;
};

/** Cached wrapper for findEnclosingClassInfo — avoids repeated parent walks. */
const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
  getQualifiedOwnerName?: (node: SyntaxNode, simpleName: string) => string | null,
): EnclosingClassInfo | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;

  const result = findEnclosingClassInfo(
    node,
    filePath,
    resolveEnclosingOwner,
    getQualifiedOwnerName,
  );
  classIdCache.set(node, result);
  return result;
};

/** Cached wrapper for export checking — avoids repeated parent walks per symbol. */
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

// Label detection moved to shared getLabelFromCaptures in utils.ts

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js

// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (
  files: ParseWorkerInput[],
  onProgress?: (filesProcessed: number) => void,
): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    calls: [],
    assignments: [],
    routes: [],
    fetchCalls: [],
    fetchWrapperDefs: [],
    decoratorRoutes: [],
    routerIncludes: [],
    routerImports: [],
    routerConstructorPrefixes: [],
    routerModuleAliases: [],
    toolDefs: [],
    ormQueries: [],
    constructorBindings: [],
    fileScopeBindings: [],
    parsedFiles: [],
    skippedLanguages: {},
    cfgSkipped: {},
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = Math.max(1, Math.min(100, Math.ceil(files.length / 10)));

  const onFileProcessed = onProgress
    ? () => {
        totalProcessed++;
        if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
          lastReported = totalProcessed;
          onProgress(totalProcessed);
        }
      }
    : undefined;

  for (const [language, langFiles] of byLanguage) {
    const provider = getProvider(language);
    const queryString = provider.treeSitterQueries;
    if (!queryString) {
      // Standalone providers (regex-based, no tree-sitter) that implement
      // emitScopeCaptures resolve via the scope-resolution pipeline, which
      // re-extracts from source on the main thread.
      if (provider.emitScopeCaptures) {
        // The worker no longer builds `ParsedFile`s for standalone providers
        // either — scope-resolution re-extracts on the main thread, and for
        // standalone COBOL the graph nodes come from cobolPhase, not this
        // artifact (#1983). Count one unit of progress per file, as before.
        for (let i = 0; i < langFiles.length; i++) {
          result.fileCount++;
          onFileProcessed?.();
        }
      }
      continue;
    }
    const tsxFiles: ParseWorkerInput[] = [];
    const regularFiles: ParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      // Manual loop (not spread) — `push(...arr)` blows the stack on very
      // large arrays when langFiles has tens of thousands of entries.
      for (const f of langFiles) regularFiles.push(f);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
        } catch (err) {
          // A throw here drops the whole language group — surface it to the pool
          // (#2264) instead of silently skipping. The old empty catch hid real
          // extractor/parser failures, not just an unavailable grammar.
          reportWarning(
            `Skipped ${regularFiles.length} ${language} file(s) after a processing error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + regularFiles.length;
      }
    }

    // Process tsx files separately (different grammar)
    if (tsxFiles.length > 0) {
      if (isLanguageAvailable(language, tsxFiles[0].path)) {
        try {
          setLanguage(language, tsxFiles[0].path);
          processFileGroup(tsxFiles, language, queryString, result, onFileProcessed);
        } catch (err) {
          // See above — surface a tsx-group processing failure rather than
          // silently dropping every file in it (#2264).
          reportWarning(
            `Skipped ${tsxFiles.length} ${language} (tsx) file(s) after a processing error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  if (onProgress && totalProcessed !== lastReported) {
    onProgress(totalProcessed);
  }

  return result;
};

// Express/Hono method names that register routes
const EXPRESS_ROUTE_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'all',
  'use',
  'route',
]);

/**
 * Walk a tree-sitter AST subtree looking for a call to the global `fetch()` function.
 * Returns `true` if found within `maxDepth` levels of nesting — keeps the check
 * lightweight so it doesn't slow down parse-worker on large function bodies.
 */
const checkForFetchCall = (node: SyntaxNode, depth = 0, maxDepth = 5): boolean => {
  if (depth > maxDepth) return false;
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'fetch') return true;
  }
  for (let i = 0; i < node.childCount; i++) {
    if (checkForFetchCall(node.child(i)!, depth + 1, maxDepth)) return true;
  }
  return false;
};

// HTTP client methods that are ONLY used by clients, not Express route registration.
// Methods like get/post/put/delete/patch overlap with Express — those are captured by
// the express_route handler as route definitions, not consumers. The fetch() global
// function is captured separately by the route.fetch query.
const HTTP_CLIENT_ONLY_METHODS = new Set(['head', 'options', 'request', 'ajax']);

// Known HTTP client receivers u2014 skip these, they're API consumers not routes
const HTTP_CLIENT_RECEIVERS = new Set([
  'axios',
  'request',
  'fetch',
  'http',
  'https',
  'got',
  'ky',
  'superagent',
  'needle',
  'undici',
  'apiclient',
  'client',
  'httpclient',
  'api',
  '$http',
  'session',
  'httpservice',
  'conn',
]);

// Decorator names that indicate HTTP route handlers (NestJS, Flask, FastAPI, Spring)
const ROUTE_DECORATOR_NAMES = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Route',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'route',
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
  'PatchMapping',
]);

// ============================================================================
// ORM Query Detection (Prisma + Supabase)
// ============================================================================

const PRISMA_QUERY_RE =
  /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;
const SUPABASE_QUERY_RE =
  /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

/**
 * Extract ORM query calls from file content via regex.
 * Appends results to the provided array (avoids allocation when no matches).
 */
export function extractORMQueries(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  if (!hasPrisma && !hasSupabase) return;

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }
}

// ============================================================================
// FastAPI router prefix detection (Python)
// ============================================================================
//
// The extraction lives in `../route-extractors/fastapi-router-bindings`
// (a pure-function module — NOT a worker, no `worker_threads`, no
// `parentPort`). It's imported here only so the worker entry can call it
// per file; this module does not re-export it. Downstream consumers
// import the function and its types directly from `route-extractors/`.

import { extractFastAPIRouterBindings } from '../route-extractors/fastapi-router-bindings.js';
import {
  extractPythonModuleConstants,
  parseConstOperands,
  type ModuleConstants,
  type Operand,
} from '../route-extractors/python-const-resolver.js';

/**
 * Report a non-fatal worker issue to the pool over IPC so a caught error is not
 * invisible to the operator (#2264). The pool logs it on the main thread AND
 * resets the worker idle timer (so a worker grinding through failing files isn't
 * falsely idle-evicted). Falls back to the local logger when there's no parent —
 * this code also runs on the main thread in tests / the non-worker path. Fatal,
 * group-aborting errors go through the message handler's
 * `{ type: 'error', errorStack }` channel instead.
 */
function reportWarning(message: string): void {
  if (parentPort) {
    parentPort.postMessage({ type: 'warning', message });
  } else {
    logger.warn(message);
  }
}

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: Parser.Query;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    reportWarning(
      `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const file of files) {
    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (getTreeSitterContentByteLength(file.content) > TREE_SITTER_MAX_BUFFER) continue;

    // Authoritative in-flight signal for the pool: lets `WorkerPool` exclude
    // exactly this file if the worker dies during parse/extract, instead of
    // guessing from `items[lastProgress]` (which the language-grouped order
    // here would defeat). The pool gracefully ignores this when running an
    // older worker build that doesn't emit it.
    if (parentPort) {
      parentPort.postMessage({ type: 'starting-file', path: file.path });
    }

    // Vue SFC preprocessing: extract <script> block content
    let parseContent = file.content;
    let scopeSourceKind: ScopeCaptureSourceKind = 'full-file';
    let lineOffset = 0;
    let isVueSetup = false;
    if (language === SupportedLanguages.Vue) {
      const extracted = extractVueScript(file.content);
      if (!extracted) continue; // skip .vue files with no script block
      parseContent = extracted.scriptContent;
      scopeSourceKind = 'pre-extracted-script';
      lineOffset = extracted.lineOffset;
      isVueSetup = extracted.isSetup;
    }

    // Per-language source-text transform (e.g., UE macro stripping for C++).
    // Length-preserving — see LanguageProvider.preprocessSource contract.
    parseContent =
      getProvider(language).preprocessSource?.(parseContent, file.path) ?? parseContent;

    clearCaches(); // Reset memoization before each new file

    let tree;
    try {
      tree = parseSourceSafe(
        parser,
        parseContent,
        undefined,
        {
          bufferSize: getTreeSitterBufferSize(parseContent),
        },
        file.path,
      );
    } catch (err) {
      reportWarning(
        `Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch (err) {
      reportWarning(
        `Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const concreteTypedefRanges = buildConcreteTypedefDefinitionRanges(matches);

    const provider = getProvider(language);

    // Produce the `ParsedFile` for the scope-resolution pipeline HERE, reusing
    // the tree we just parsed (no second tree-sitter parse). Scope-resolution
    // consumes these via the disk-backed parsedfile-store instead of
    // re-extracting each file from source on the main thread — which
    // accumulated an unbounded native tree-sitter leak on huge repos (#1983;
    // see parsedfile-store.ts). parse-impl flushes `result.parsedFiles` to disk
    // per chunk and does NOT retain them in main-thread heap, so this no longer
    // costs ~1× the semantic model in RAM during parse.
    const parsedFile = extractParsedFile(
      provider,
      parseContent,
      file.path,
      reportWarning,
      tree,
      scopeSourceKind,
    );
    if (parsedFile !== undefined) {
      // Capture-time side-channel (#1983): `extractParsedFile` just ran the
      // provider's `emitScopeCaptures`, which (for C++ ADL/namespace marks,
      // C `static`-linkage names, and Kotlin companion scopes) populated
      // module-level maps as a SIDE EFFECT that is NOT on `parsedFile`'s
      // scopes/defs. Snapshot
      // that per-file state as plain data onto `ParsedFile.captureSideChannel`
      // so the main thread can restore it (via `ScopeResolver.applyCaptureSideChannel`)
      // WITHOUT a re-parse, after this ParsedFile crosses the worker boundary /
      // disk store. Providers without capture-time side effects leave the hook
      // undefined and this is a no-op. `undefined` return ⇒ no field added.
      //
      // `extractParsedFile` returns a frozen ParsedFile, so re-wrap (shallow
      // copy — scopes/defs are carried by reference) to attach the field rather
      // than mutate the frozen object.
      const sideChannel = provider.collectCaptureSideChannel?.(file.path);
      let withChannels =
        sideChannel !== undefined ? { ...parsedFile, captureSideChannel: sideChannel } : parsedFile;

      // CFG side-channel (#2081 M1): build the per-function control-flow graph
      // here, where the tree-sitter AST is still in hand, and attach it as plain
      // serializable data. Only on a --pdg run and only for languages with a
      // cfgVisitor (TS/JS in M1). The same disk-store/warm-cache machinery that
      // carries captureSideChannel carries this — its coherence rests on the
      // SCHEMA_BUMP + the pdg-folded chunk-hash key (see parse-cache.ts).
      if (PDG_ENABLED && provider.cfgVisitor) {
        // Isolate the CFG build per file: a throw here (an unexpected tree-sitter
        // node shape) must NOT propagate — it would escape processFileGroup to the
        // language-group catch, which treats any throw as "parser unavailable" and
        // silently drops EVERY remaining file in the group. Skip CFG for this one
        // file; parsing + scope resolution proceed unaffected (CFG is a
        // strictly-additive opt-in). collectFunctionCfgs ALSO isolates per
        // FUNCTION now (#2195) — a deep-nesting bail or a single malformed function
        // is counted in `skipped` and skipped, not allowed to lose the whole file.
        try {
          const { cfgs, skipped } = collectFunctionCfgs(
            tree.rootNode,
            provider.cfgVisitor,
            file.path,
            PDG_MAX_FUNCTION_LINES,
            // Embedded scripts (Vue SFC <script>) parse at row 0 but live at
            // `lineOffset` in the file — shift the CFG into file coordinates so
            // it joins its graph node and BasicBlock lines map to source.
            lineOffset,
          );
          if (cfgs.length) withChannels = { ...withChannels, cfgSideChannel: cfgs };
          // Surface per-function CFG skips per-language (#2195): merged + logged
          // in mergeChunkResults. Only accumulate when something was skipped so
          // the common (nothing-skipped) case stays a no-op.
          if (skipped.tooManyLines || skipped.tooDeeplyNested || skipped.buildError) {
            const agg = (result.cfgSkipped ??= {});
            const prev = agg[language] ?? { tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 };
            agg[language] = {
              tooManyLines: prev.tooManyLines + skipped.tooManyLines,
              tooDeeplyNested: prev.tooDeeplyNested + skipped.tooDeeplyNested,
              buildError: prev.buildError + skipped.buildError,
            };
          }
        } catch (err) {
          reportWarning(
            `CFG build failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      result.parsedFiles.push(withChannels);
    }

    // Build per-file type environment + constructor bindings in a single AST walk.
    // The legacy heritage pre-pass that seeded a file-local parentMap for
    // buildTypeEnv was removed in RING4-1 (#942) along with the rest of the
    // call-resolution DAG. Inheritance is now emitted by scope-resolution
    // (preEmitInheritanceEdges + @reference.inherits), so buildTypeEnv runs with
    // an empty parentMap — cross-file inheritance was never resolved here anyway.
    const parentMap: ReadonlyMap<string, readonly string[]> = new Map();
    const typeEnv = buildTypeEnv(tree, language, {
      filePath: file.path,
      parentMap,
      enclosingFunctionFinder: provider?.enclosingFunctionFinder,
      extractFunctionName: provider?.methodExtractor?.extractFunctionName,
    });
    const callRouter = provider.callRouter;

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({
        filePath: file.path,
        bindings: [...typeEnv.constructorBindings],
      });
    }

    // Serialize file-scope bindings for BindingAccumulator. These feed the
    // ExportedTypeMap enrichment loop in pipeline.ts — the only current
    // consumer of worker-path binding data.
    //
    // Historical note: we previously serialized all scopes
    // (`typeEnv.allScopes()`), which pushed ~4.9 MB of function-scope
    // bindings across the IPC boundary on every worker batch with zero
    // downstream readers. Narrowing to `fileScope()` recovers that cost.
    // See the `FileScopeBindings` JSDoc above for the Phase 9 reversion
    // path when a function-scope consumer lands.
    const fileScope = typeEnv.fileScope();
    if (fileScope.size > 0) {
      const scopeBindings: [string, string][] = [];
      for (const [varName, typeName] of fileScope) {
        scopeBindings.push([varName, typeName]);
      }
      result.fileScopeBindings.push({ filePath: file.path, bindings: scopeBindings });
    }

    // Per-file map: decorator end-line → decorator info, for associating with definitions
    const fileDecorators = new Map<number, { name: string; arg?: string; isTool?: boolean }>();

    // Track start indices of definition nodes already processed by higher-priority captures
    // (e.g. @definition.function) to avoid duplicate nodes when @definition.const/@definition.variable
    // patterns overlap with the same source range.
    const processedDefinitionNodes = new Set<string>();
    const variableInfoCache = new Map<number, Map<string, VariableInfo>>();

    for (const match of matches) {
      const captureMap: Record<string, SyntaxNode> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      if (isSuppressedConcreteTypedefDuplicate(captureMap, concreteTypedefRanges)) continue;

      // Import matches: IMPORTS edges are emitted by the scope-resolution
      // phase from finalized ImportEdges (RING4-1 #942 / RING4-2 #943 removed
      // the legacy per-file import-map extraction that ran here). Skip.
      if (captureMap['import'] && captureMap['import.source']) {
        continue;
      }

      // Extract assignment sites (field write access)
      if (
        captureMap['assignment'] &&
        captureMap['assignment.receiver'] &&
        captureMap['assignment.property']
      ) {
        const receiverText = captureMap['assignment.receiver'].text;
        const propertyName = captureMap['assignment.property'].text;
        if (receiverText && propertyName) {
          const srcId =
            findEnclosingFunctionId(captureMap['assignment'], file.path, provider) ||
            generateId('File', file.path);
          let receiverTypeName: string | undefined;
          if (typeEnv) {
            receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']) ?? undefined;
          }
          result.assignments.push({
            filePath: file.path,
            sourceId: srcId,
            receiverText,
            propertyName,
            line: captureMap['assignment'].startPosition.row + 1,
            ...(receiverTypeName ? { receiverTypeName } : {}),
          });
        }
        if (!captureMap['call']) continue;
      }

      // Store decorator metadata for later association with definitions
      if (captureMap['decorator'] && captureMap['decorator.name']) {
        const decoratorName = captureMap['decorator.name'].text;
        const decoratorArg = captureMap['decorator.arg']?.text;
        // #2391: the first positional arg captured as either a string node
        // (`arg_str`, present even for the empty-string literal `""` which has no
        // `string_content`) or a non-literal expression (`arg_expr`: an
        // identifier or a `+`-concatenation).
        const decoratorArgStr = captureMap['decorator.arg_str'];
        const decoratorArgExpr = captureMap['decorator.arg_expr'];
        const decoratorReceiver = captureMap['decorator.receiver']?.text;
        const decoratorNode = captureMap['decorator'];
        // Store by the decorator's end line — the definition follows immediately after
        fileDecorators.set(decoratorNode.endPosition.row, {
          name: decoratorName,
          arg: decoratorArg,
        });

        if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
          const method = decoratorName.replace('Mapping', '').toUpperCase();
          const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
            ? method
            : 'GET';
          const base = {
            filePath: file.path,
            httpMethod,
            decoratorName,
            lineNumber: decoratorNode.startPosition.row + lineOffset,
            ...(decoratorReceiver ? { decoratorReceiver } : {}),
          };
          if (decoratorArgStr) {
            // String-literal path (the fast path, unchanged). Empty-string
            // literal `""` has no `string_content` → `decoratorArg` undefined →
            // routePath '' (a valid path under an APIRouter prefix).
            result.decoratorRoutes.push({ ...base, routePath: decoratorArg ?? '' });
          } else if (decoratorArgExpr) {
            // #2391 non-literal path (imported/composed constant). Emit the raw
            // expression + its operands for cross-file resolution in parse-impl;
            // `routePath` stays empty until resolved (or the route is dropped).
            const operands: Operand[] | null =
              decoratorArgExpr.type === 'identifier'
                ? [{ kind: 'ref', name: decoratorArgExpr.text }]
                : parseConstOperands(decoratorArgExpr);
            result.decoratorRoutes.push({
              ...base,
              routePath: '',
              routePathExpr: decoratorArgExpr.text,
              ...(operands ? { routePathOperands: operands } : {}),
            });
          }
          // Otherwise the first arg is absent or an unsupported shape
          // (attribute access, call, …) → skip; never a phantom `POST /`.
        }
        // MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
        if (decoratorName === 'tool') {
          // Re-store with isTool flag for the definition handler
          fileDecorators.set(decoratorNode.endPosition.row, {
            name: decoratorName,
            arg: decoratorArg,
            isTool: true,
          });
        }
        continue;
      }

      // Extract HTTP consumer URLs: fetch(), axios.get(), $.get(), requests.get(), etc.
      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // HTTP client calls: axios.get('/path'), $.post('/path'), requests.get('/path')
      // Skip methods also in EXPRESS_ROUTE_METHODS to avoid double-registering Express
      // routes as both route definitions AND consumers (both queries match same AST node)
      if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        if (method && HTTP_CLIENT_ONLY_METHODS.has(method) && url.startsWith('/')) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // Express/Hono route registration: app.get('/path', handler)
      if (
        captureMap['express_route'] &&
        captureMap['express_route.method'] &&
        captureMap['express_route.path']
      ) {
        const method = captureMap['express_route.method'].text;
        const routePath = captureMap['express_route.path'].text;
        if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith('/')) {
          // Extract the receiver (the object the method is called on) to filter out
          // HTTP client calls like axios.get('/api/users') that match the same pattern
          // as Express route registrations.
          const callNode = captureMap['express_route'];
          const funcNode = callNode.childForFieldName?.('function') ?? callNode.children?.[0];
          // Walk through nested member_expressions and call_expressions to
          // reach the innermost receiver identifier.  Handles chains like:
          //   this.httpService.get('/path')   -> member chain    -> 'httpservice'
          //   getClient().get('/path')         -> call_expression -> 'getclient'
          //   axios.get('/path')               -> bare identifier -> 'axios'
          let receiverNode = funcNode?.childForFieldName?.('object') ?? funcNode?.children?.[0];
          while (
            receiverNode?.type === 'member_expression' ||
            receiverNode?.type === 'call_expression'
          ) {
            if (receiverNode.type === 'member_expression') {
              // Drill into the property (rightmost part) of the member expression
              const propNode = receiverNode.childForFieldName?.('property');
              if (propNode) {
                receiverNode = propNode;
              } else {
                break;
              }
            } else {
              // call_expression: unwrap to the function being called
              const innerFunc =
                receiverNode.childForFieldName?.('function') ?? receiverNode.children?.[0];
              if (innerFunc && innerFunc !== receiverNode) {
                receiverNode = innerFunc;
              } else {
                break;
              }
            }
          }
          const receiverText = receiverNode?.text?.toLowerCase() ?? '';

          if (HTTP_CLIENT_RECEIVERS.has(receiverText)) {
            // This is an HTTP client call, not a route definition u2014 skip it
            continue;
          }

          const httpMethod =
            method === 'all' || method === 'use' || method === 'route'
              ? 'GET'
              : method.toUpperCase();
          result.decoratorRoutes.push({
            filePath: file.path,
            routePath,
            httpMethod,
            decoratorName: `express.${method}`,
            lineNumber: captureMap['express_route'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNode = captureMap['call'];
        const callNameNode = captureMap['call.name'];
        const callExtractor = provider.callExtractor;

        if (callExtractor) {
          // ── Path 1: Language-specific call site (bypasses routing) ────
          // Try language-specific extraction (e.g. Java `::` method references)
          // without callNameNode.  If successful, skip routing and the generic
          // path entirely.
          const langCallSite = callExtractor.extract(callNode, undefined);
          if (langCallSite) {
            if (!provider.isBuiltInName(langCallSite.calledName)) {
              const sourceId =
                findEnclosingFunctionId(callNode, file.path, provider) ||
                generateId('File', file.path);
              const receiverName =
                langCallSite.callForm === 'member' ? langCallSite.receiverName : undefined;
              let receiverTypeName = receiverName
                ? typeEnv.lookup(receiverName, callNode)
                : undefined;
              // Type-as-receiver heuristic (e.g. Java `User::getName`)
              if (
                langCallSite.typeAsReceiverHeuristic &&
                receiverName !== undefined &&
                receiverTypeName === undefined &&
                langCallSite.callForm === 'member'
              ) {
                const c0 = receiverName.charCodeAt(0);
                if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
              }
              result.calls.push({
                filePath: file.path,
                calledName: langCallSite.calledName,
                sourceId,
                callForm: langCallSite.callForm,
                ...(receiverName !== undefined ? { receiverName } : {}),
                ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
              });
            }
            continue;
          }

          // ── Path 2: Generic extraction via @call.name ────────────────
          if (callNameNode) {
            const calledName = callNameNode.text;

            // Dispatch: route language-specific calls (properties, imports).
            // Call-based heritage (Ruby include/extend/prepend) is no longer
            // routed here — those calls return 'skip' from the router and the
            // mixin edges are emitted by scope-resolution (emitHeritageEdges).
            const routed = callRouter?.(calledName, captureMap['call']);
            if (routed) {
              if (routed.kind === 'skip') continue;

              if (routed.kind === 'import') {
                // Call-routed imports (e.g. Ruby `require`) are emitted as
                // IMPORTS edges by the scope-resolution phase; the legacy
                // per-file extraction that consumed these was removed in
                // RING4-2 (#943). Skip.
                continue;
              }

              if (routed.kind === 'properties') {
                // #1978: thread the qualifier so a routed property's owner edge
                // points at the *qualified* nested-class node (Outer.Inner) rather
                // than a now-nonexistent simple `Class:file:Inner` id. Gated on the
                // flag → byte-identical when off. Mirrors the main owner path.
                const propGetQualifiedOwnerName =
                  provider.classExtractor?.qualifiedNodeId === true
                    ? (node: SyntaxNode, simpleName: string): string | null =>
                        provider.classExtractor!.extractQualifiedName(node, simpleName)
                    : undefined;
                const propEnclosingInfo = cachedFindEnclosingClassInfo(
                  captureMap['call'],
                  file.path,
                  provider.resolveEnclosingOwner,
                  propGetQualifiedOwnerName,
                );
                const propEnclosingClassId =
                  propEnclosingInfo?.qualifiedClassId ?? propEnclosingInfo?.classId ?? null;
                // Enrich routed properties with FieldExtractor metadata
                let routedFieldMap: Map<string, FieldInfo> | undefined;
                if (provider.fieldExtractor && typeEnv) {
                  const classNode = findEnclosingClassNode(captureMap['call']);
                  if (classNode) {
                    routedFieldMap = getFieldInfo(classNode, provider, {
                      typeEnv,
                      symbolTable: NOOP_SYMBOL_TABLE,
                      filePath: file.path,
                      language,
                    });
                  }
                }
                for (const item of routed.items) {
                  const routedFieldInfo = routedFieldMap?.get(item.propName);
                  const propQualifiedName = propEnclosingInfo
                    ? `${propEnclosingInfo.className}.${item.propName}`
                    : item.propName;
                  const nodeId = generateId('Property', `${file.path}:${propQualifiedName}`);
                  result.nodes.push({
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
                      ...(item.declaredType
                        ? { declaredType: item.declaredType }
                        : routedFieldInfo?.type
                          ? { declaredType: routedFieldInfo.type }
                          : {}),
                      ...(routedFieldInfo?.rawDeclaredType !== undefined
                        ? { rawDeclaredType: routedFieldInfo.rawDeclaredType }
                        : {}),
                      ...(routedFieldInfo?.annotations !== undefined &&
                      routedFieldInfo.annotations.length > 0
                        ? { annotations: routedFieldInfo.annotations }
                        : {}),
                      ...(routedFieldInfo?.visibility !== undefined
                        ? { visibility: routedFieldInfo.visibility }
                        : {}),
                      ...(routedFieldInfo?.isStatic !== undefined
                        ? { isStatic: routedFieldInfo.isStatic }
                        : {}),
                      ...(routedFieldInfo?.isReadonly !== undefined
                        ? { isReadonly: routedFieldInfo.isReadonly }
                        : {}),
                    },
                  });
                  result.symbols.push({
                    filePath: file.path,
                    name: item.propName,
                    nodeId,
                    type: 'Property',
                    ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                    ...(item.declaredType
                      ? { declaredType: item.declaredType }
                      : routedFieldInfo?.type
                        ? { declaredType: routedFieldInfo.type }
                        : {}),
                    ...(routedFieldInfo?.visibility !== undefined
                      ? { visibility: routedFieldInfo.visibility }
                      : {}),
                    ...(routedFieldInfo?.isStatic !== undefined
                      ? { isStatic: routedFieldInfo.isStatic }
                      : {}),
                    ...(routedFieldInfo?.isReadonly !== undefined
                      ? { isReadonly: routedFieldInfo.isReadonly }
                      : {}),
                  });
                  // Only emit File -> Property DEFINES for top-level properties
                  // (issue #1944); class members are reached via HAS_PROPERTY.
                  if (!propEnclosingClassId) {
                    const fileId = generateId('File', file.path);
                    const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                    result.relationships.push({
                      id: relId,
                      sourceId: fileId,
                      targetId: nodeId,
                      type: 'DEFINES',
                      confidence: 1.0,
                      reason: '',
                    });
                  }
                  if (propEnclosingClassId) {
                    result.relationships.push({
                      id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                      sourceId: propEnclosingClassId,
                      targetId: nodeId,
                      type: 'HAS_PROPERTY',
                      confidence: 1.0,
                      reason: '',
                    });
                  }
                }
                continue;
              }

              // kind === 'call' — fall through to normal call processing below
            }

            if (!provider.isBuiltInName(calledName)) {
              const callSite = callExtractor.extract(callNode, callNameNode);
              if (callSite) {
                const sourceId =
                  findEnclosingFunctionId(callNode, file.path, provider) ||
                  generateId('File', file.path);
                let receiverTypeName = callSite.receiverName
                  ? typeEnv.lookup(callSite.receiverName, callNode)
                  : undefined;

                // Type-as-receiver heuristic
                if (
                  callSite.typeAsReceiverHeuristic &&
                  callSite.receiverName !== undefined &&
                  receiverTypeName === undefined &&
                  callSite.callForm === 'member'
                ) {
                  const c0 = callSite.receiverName.charCodeAt(0);
                  if (c0 >= 65 && c0 <= 90) receiverTypeName = callSite.receiverName;
                }

                const inferLiteralType = provider.typeConfig?.inferLiteralType;
                // Skip when no arg list / zero args: nothing to infer for overload typing
                const argTypes =
                  inferLiteralType && callSite.argCount !== undefined && callSite.argCount > 0
                    ? extractCallArgTypes(callNode, inferLiteralType, (varName, cn) =>
                        typeEnv.lookup(varName, cn),
                      )
                    : undefined;

                result.calls.push({
                  filePath: file.path,
                  calledName: callSite.calledName,
                  sourceId,
                  ...(callSite.argCount !== undefined ? { argCount: callSite.argCount } : {}),
                  ...(callSite.callForm !== undefined ? { callForm: callSite.callForm } : {}),
                  ...(callSite.receiverName !== undefined
                    ? { receiverName: callSite.receiverName }
                    : {}),
                  ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
                  ...(callSite.receiverMixedChain !== undefined
                    ? { receiverMixedChain: callSite.receiverMixedChain }
                    : {}),
                  ...(argTypes !== undefined ? { argTypes } : {}),
                });
              }
            }
          }
        }
        continue;
      }

      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const defaultNodeLabel = getLabelFromCaptures(captureMap, provider);
      if (!defaultNodeLabel) continue;

      const nameNode = captureMap['name'];
      const extractedClassSymbol =
        definitionNode && provider.classExtractor?.isTypeDeclaration(definitionNode)
          ? provider.classExtractor.extract(definitionNode, {
              name: nameNode?.text,
              type: defaultNodeLabel,
            })
          : null;
      const nodeLabel = extractedClassSymbol?.type ?? defaultNodeLabel;
      const isClassLikeLabel =
        nodeLabel === 'Class' ||
        nodeLabel === 'Struct' ||
        nodeLabel === 'Interface' ||
        nodeLabel === 'Enum' ||
        nodeLabel === 'Record';
      if (
        isClassLikeLabel &&
        provider.classExtractor?.shouldSkipClassCapture?.({
          captureMap,
          definitionNode,
          nameNode,
          nodeLabel,
        }) === true
      ) {
        continue;
      }

      const exportDefaultCall =
        nodeLabel === 'Function' && definitionNode?.type === 'export_statement'
          ? definitionNode.namedChildren.find((child) => child.type === 'call_expression')
          : undefined;
      const defaultExportHocName = (() => {
        if (exportDefaultCall === undefined) return null;
        const argList = exportDefaultCall.childForFieldName?.('arguments');
        const callback = argList?.namedChildren.find(
          (child) => child.type === 'arrow_function' || child.type === 'function_expression',
        );
        if (callback === undefined) return null;

        const callee = exportDefaultCall.childForFieldName?.('function');
        if (
          callee?.type === 'identifier' &&
          DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET.has(callee.text)
        )
          return null;
        if (callee?.type === 'member_expression') {
          const property = callee.childForFieldName?.('property');
          if (
            property?.type === 'property_identifier' &&
            ARRAY_METHOD_HOC_BLOCKLIST_SET.has(property.text)
          )
            return null;
        }

        return deriveDefaultExportHocName(file.path);
      })();

      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (
        !nameNode &&
        nodeLabel !== 'Constructor' &&
        !extractedClassSymbol &&
        !defaultExportHocName
      )
        continue;

      const nodeName =
        extractedClassSymbol?.name ?? defaultExportHocName ?? (nameNode ? nameNode.text : 'init');
      // Dedup: variable captures (Const/Static/Variable) may overlap with higher-priority
      // captures (e.g. `const fn = () => {}` matches both @definition.function and @definition.const).
      // Multi-name declarations share the same definition node, so include the emitted name.
      if (definitionNode) {
        const definitionBaseKey = `${definitionNode.startIndex}`;
        if (nodeLabel === 'Const' || nodeLabel === 'Static' || nodeLabel === 'Variable') {
          const definitionNameKey = `${definitionBaseKey}:${nodeName}`;
          if (
            processedDefinitionNodes.has(definitionBaseKey) ||
            processedDefinitionNodes.has(definitionNameKey)
          ) {
            continue;
          }
          processedDefinitionNodes.add(definitionNameKey);
        } else {
          processedDefinitionNodes.add(definitionBaseKey);
        }
      }

      const startLine = definitionNode
        ? definitionNode.startPosition.row + lineOffset
        : nameNode
          ? nameNode.startPosition.row + lineOffset
          : lineOffset;

      // Compute enclosing class BEFORE node ID — needed to qualify method IDs
      const needsOwner =
        nodeLabel === 'Method' ||
        nodeLabel === 'Constructor' ||
        nodeLabel === 'Property' ||
        nodeLabel === 'Function';
      // #1978: thread the class-extractor's qualifier into the owner walk when the
      // language opts into qualified node ids, so a nested member's owner resolves
      // to the *qualified* class id (Outer.Inner). Gated on the flag → byte-identical
      // when off. Mirrors parsing-processor.ts.
      const getQualifiedOwnerName =
        provider.classExtractor?.qualifiedNodeId === true
          ? (node: SyntaxNode, simpleName: string): string | null =>
              // #1991: LOCKSTEP — a Ruby `module` owner is not a typeDeclaration, so
              // extractQualifiedName returns null; fall back to the scope walk so a
              // method inside a nested module owns through the SAME qualified Trait
              // id its node uses on the worker path too.
              provider.classExtractor!.extractQualifiedName(node, simpleName) ??
              provider.classExtractor!.qualifyScopeName?.(node, simpleName) ??
              null
          : undefined;
      // A Property declared inside a function/lambda BODY is a function-LOCAL
      // binding (e.g. Kotlin `val (a,b) = pair` or a `for ((k,v) in m)` loop
      // destructuring emitted as `@definition.property` to dodge the local-symbol
      // pruner), NOT a class member. Such locals must not get a HAS_PROPERTY owner
      // edge from the enclosing class. Detect them by walking from the def node:
      // if a function-like ancestor is reached BEFORE any class container, the
      // property is enclosed by a function. Language-agnostic — genuine class
      // fields sit directly in the class body with no intervening function, so
      // they are unaffected (#1919 review CF3).
      //
      // EXCEPTION: a constructor PARAMETER property (TypeScript
      // `constructor(public name: string)`) is also enclosed by a function, but
      // it IS a class member — it is reached through the parameter list, not the
      // executable body. So only strip the owner when the property is NOT inside
      // a parameter list of that function (i.e. it's a body local).
      const propOwnerNode = nameNode || definitionNode;
      // A Property is function-local (and must NOT get a class HAS_PROPERTY owner)
      // when its nearest enclosing executable body — reached before any class
      // container — is a function/accessor/initializer body, AND it is not a
      // constructor parameter-property (rescued by the param-list carve-out).
      // Uses LOCAL_SCOPE_BODY_NODE_TYPES (not FUNCTION_NODE_TYPES): the latter
      // mis-includes Dart bare signatures (over-stripping accessors) and omits
      // Kotlin/Swift init+accessor bodies (under-stripping their locals) — see
      // the #1919 review of this guard.
      const isFunctionLocalProperty =
        nodeLabel === 'Property' &&
        propOwnerNode !== undefined &&
        findAncestorBeforeBoundary(
          propOwnerNode,
          LOCAL_SCOPE_BODY_NODE_TYPES,
          CLASS_CONTAINER_TYPES,
        ) !== null &&
        findAncestorBeforeBoundary(
          propOwnerNode,
          PARAMETER_LIST_NODE_TYPES,
          LOCAL_SCOPE_BODY_NODE_TYPES,
        ) === null;
      const enclosingClassInfo =
        needsOwner && !isFunctionLocalProperty
          ? cachedFindEnclosingClassInfo(
              nameNode || definitionNode,
              file.path,
              provider.resolveEnclosingOwner,
              getQualifiedOwnerName,
            )
          : null;
      const enclosingClassId =
        enclosingClassInfo?.qualifiedClassId ?? enclosingClassInfo?.classId ?? null;
      const objectLiteralOwnerInfo =
        !enclosingClassId && nodeLabel === 'Method' && definitionNode
          ? findObjectLiteralBindingInfo(definitionNode, file.path)
          : null;

      // #1978: hoisted ABOVE qualifiedName/node-id (load-bearing order) so a
      // class-like node can key its id by its fully-qualified path. Derived from
      // the SAME extractQualifiedName the owner edge uses → owner id == node id.
      const classNodeForSymbol = definitionNode || nameNode;
      const qualifiedTypeName =
        extractedClassSymbol?.qualifiedName ??
        (classNodeForSymbol && provider.classExtractor?.isTypeDeclaration(classNodeForSymbol)
          ? (provider.classExtractor.extractQualifiedName(classNodeForSymbol, nodeName) ?? nodeName)
          : // #1991: LOCKSTEP with parsing-processor.ts — qualify a Ruby `module`
            // (Trait) via the scope walk so same-tail nested mixin modules get
            // distinct ids on the worker path too. Gated on qualifiedNodeId.
            isQualifiableScopeLabel(nodeLabel) &&
              provider.classExtractor?.qualifiedNodeId === true &&
              classNodeForSymbol
            ? (provider.classExtractor.qualifyScopeName?.(classNodeForSymbol, nodeName) ??
              undefined)
            : undefined);

      // Qualify method/property IDs with enclosing class name to avoid collisions.
      // Class-like nodes use their own fully-qualified path as the id key when the
      // language enables qualifiedNodeId (#1978); everything else is unchanged.
      // #1982: LOCKSTEP with parsing-processor.ts — a Rust inherent-impl with an
      // UNSCOPED bare target is keyed by the enclosing `mod_item` scope so the
      // worker-path Impl node id matches the sequential path and the owner walk.
      const rustImplQualifiedName =
        nodeLabel === 'Impl' &&
        definitionNode?.type === 'impl_item' &&
        nameNode?.type === 'type_identifier'
          ? qualifyRustImplTargetByModScope(definitionNode, nodeName)
          : undefined;

      const qualifiedName =
        rustImplQualifiedName !== undefined
          ? rustImplQualifiedName
          : // #1991: LOCKSTEP — include Trait so a Ruby mixin module's qualified
            // scope id keys the worker-path node, matching the sequential path.
            (isClassLikeLabel || isQualifiableScopeLabel(nodeLabel)) &&
              provider.classExtractor?.qualifiedNodeId === true &&
              qualifiedTypeName !== undefined
            ? qualifiedTypeName
            : enclosingClassInfo
              ? `${enclosingClassInfo.className}.${nodeName}`
              : nodeName;

      // Extract method metadata BEFORE generating node ID — parameterCount is needed
      // to disambiguate overloaded methods via #<arity> suffix in the ID.
      let declaredType: string | undefined;
      let methodProps: Record<string, unknown> = {};
      let arityForId: number | undefined; // raw param count for ID, even for variadic
      let defMethodMap: Map<string, MethodInfo> | undefined;
      let defMethodInfo: MethodInfo | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        // Use MethodExtractor for method metadata — provides parameterCount, parameterTypes,
        // returnType, isAbstract/isFinal/annotations, visibility, and more.
        let enrichedByMethodExtractor = false;
        if (provider.methodExtractor && definitionNode) {
          const classNode =
            findEnclosingClassNode(definitionNode) ?? findClassNodeByQualifiedName(definitionNode);
          if (classNode) {
            const methodMap = getMethodInfo(classNode, provider, {
              filePath: file.path,
              language,
            });
            const defLine = definitionNode.startPosition.row + 1;
            const info = methodMap?.get(`${nodeName}:${defLine}`);
            if (info) {
              enrichedByMethodExtractor = true;
              arityForId = arityForIdFromInfo(info);
              methodProps = buildMethodProps(info);
              defMethodMap = methodMap;
              defMethodInfo = info;
            }
          }
        }

        // For top-level methods (e.g. Go method_declaration), try extractFromNode
        if (
          !enrichedByMethodExtractor &&
          provider.methodExtractor?.extractFromNode &&
          definitionNode
        ) {
          const info = provider.methodExtractor.extractFromNode(definitionNode, {
            filePath: file.path,
            language,
          });
          if (info) {
            enrichedByMethodExtractor = true;
            arityForId = arityForIdFromInfo(info);
            methodProps = buildMethodProps(info);
          }
        }
      }

      // Append #<paramCount> to owned callable IDs to disambiguate overloads.
      // Top-level Function IDs stay stable; functions inside an owner may overload.
      // When same-arity collisions exist, append ~type1,type2 for further disambiguation.
      const needsAritySuffix =
        nodeLabel === 'Method' ||
        nodeLabel === 'Constructor' ||
        (nodeLabel === 'Function' && enclosingClassId !== null);
      let arityTag = needsAritySuffix && arityForId !== undefined ? `#${arityForId}` : '';
      if (arityTag && defMethodMap && defMethodInfo) {
        const groups = buildCollisionGroups(defMethodMap);
        arityTag += typeTagForId(
          defMethodMap,
          nodeName,
          arityForId,
          defMethodInfo,
          language,
          groups,
        );
        arityTag += constTagForId(defMethodMap, nodeName, arityForId, defMethodInfo, groups);
      }
      const parameterShapeTag =
        nodeLabel === 'Function' || nodeLabel === 'Method'
          ? parameterShapeIdTag(
              methodProps.parameterTypes as string[] | undefined,
              methodProps.parameterTypeClasses as ParameterTypeClass[] | undefined,
            )
          : '';
      const classTemplateArguments =
        extractedClassSymbol?.templateArguments ??
        provider.classExtractor?.extractTemplateArgumentsFromCapture?.({
          captureMap,
          definitionNode,
          nameNode,
        }) ??
        (captureMap['template-arguments']
          ? extractTemplateArguments(captureMap['template-arguments'].text)
          : undefined) ??
        (nameNode && nameNode.text ? extractTemplateArguments(nameNode.text) : undefined);
      const classTemplateTag =
        (nodeLabel === 'Class' ||
          nodeLabel === 'Struct' ||
          nodeLabel === 'Interface' ||
          nodeLabel === 'Enum' ||
          nodeLabel === 'Record') &&
        classTemplateArguments !== undefined &&
        classTemplateArguments.length > 0
          ? templateArgumentsIdTag(classTemplateArguments)
          : '';
      // SFINAE / `requires`-clause aware ID disambiguation (issue #1579).
      // Function-template overloads with identical parameterTypes but
      // mutually-exclusive constraints (e.g. `enable_if_t<is_integral_v<T>>`
      // vs `enable_if_t<is_floating_point_v<T>>`) need distinct graph nodes
      // so the constraint-filter step in `narrowOverloadCandidates` has two
      // candidates to narrow between. Without this tag they collapse to a
      // single Function node and the SFINAE call resolves to only one edge
      // regardless of which overload's constraint holds. This mirrors the
      // sequential `parsing-processor` path removed in #1983 — the worker is
      // now the sole parse path, so it must stamp the constraint tag and the
      // `templateConstraints` node property the resolver looks up by re-
      // hashing the def's constraints (see graph-bridge ids.ts / node-lookup.ts).
      let parsedTemplateConstraints: unknown = undefined;
      let constraintsTag = '';
      if (
        (nodeLabel === 'Function' || nodeLabel === 'Method') &&
        provider.extractTemplateConstraints !== undefined &&
        definitionNode
      ) {
        try {
          parsedTemplateConstraints = provider.extractTemplateConstraints(definitionNode);
          if (parsedTemplateConstraints !== undefined) {
            constraintsTag = templateConstraintsIdTag(parsedTemplateConstraints);
          }
        } catch (err) {
          // Optional C++ template-constraint enrichment: fall back to no tag, but
          // surface the failure (#2264) — matches the CFG-build warning above.
          reportWarning(
            `Template-constraint extraction failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
          parsedTemplateConstraints = undefined;
          constraintsTag = '';
        }
      }
      const nodeId = generateId(
        nodeLabel,
        `${file.path}:${qualifiedName}${classTemplateTag}${arityTag}${parameterShapeTag}${constraintsTag}`,
      );

      let description: string | undefined;
      try {
        description = provider.descriptionExtractor?.(nodeLabel, nodeName, captureMap);
      } catch (err) {
        // A throw here (an unexpected tree-sitter node shape, a provider bug) must
        // NOT propagate — it would escape processFileGroup to the language-group
        // catch, which treats any throw as "parser unavailable" and silently drops
        // every remaining file in the group. Mirrors the extractTemplateConstraints
        // guard above (#2286 review).
        reportWarning(
          `Description extraction failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        description = undefined;
      }

      let frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      // Suppress Spring framework hint for methods inside interfaces
      // (Feign clients, JAX-RS proxies are consumers, not providers)
      if (frameworkHint && definitionNode) {
        let classCheck = definitionNode.parent;
        while (classCheck) {
          if (classCheck.type === 'interface_declaration') {
            frameworkHint = null;
            break;
          }
          if (classCheck.type === 'class_declaration' || classCheck.type === 'program') {
            break;
          }
          classCheck = classCheck.parent;
        }
      }

      // Decorators appear on lines immediately before their definition; allow up to
      // MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
      const MAX_DECORATOR_SCAN_LINES = 5;
      if (definitionNode) {
        const defStartLine = definitionNode.startPosition.row;
        for (
          let checkLine = defStartLine - 1;
          checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES);
          checkLine--
        ) {
          const dec = fileDecorators.get(checkLine);
          if (dec) {
            // Use first (closest) decorator found for framework hint
            if (!frameworkHint) {
              frameworkHint = {
                framework: 'decorator',
                entryPointMultiplier: 1.2,
                reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ''}`,
              };
            }
            // Emit tool definition if this is a @tool decorator
            if (dec.isTool) {
              result.toolDefs.push({
                filePath: file.path,
                toolName: nodeName,
                description: (dec.arg || description || '').slice(0, 200),
                lineNumber: definitionNode.startPosition.row + lineOffset,
                handlerNodeId: nodeId,
              });
            }
            fileDecorators.delete(checkLine);
          }
        }
      }

      // Property metadata extraction (not needed before nodeId — Properties don't overload)
      if (nodeLabel === 'Property' && definitionNode) {
        // FieldExtractor is the single source of truth when available
        if (provider.fieldExtractor && typeEnv) {
          const classNode = findEnclosingClassNode(definitionNode);
          if (classNode) {
            const fieldMap = getFieldInfo(classNode, provider, {
              typeEnv,
              symbolTable: NOOP_SYMBOL_TABLE,
              filePath: file.path,
              language,
            });
            const info = fieldMap?.get(nodeName);
            if (info) {
              declaredType = info.type ?? undefined;
              // Mutate methodProps BEFORE the `{...methodProps}` spread below —
              // rawDeclaredType is the verbatim generic type text (U1, PR #2200).
              if (info.rawDeclaredType !== undefined) {
                methodProps.rawDeclaredType = info.rawDeclaredType;
              }
              // Field annotations ('@Name' strings, U2 PR #2200) — omit when empty.
              if (info.annotations !== undefined && info.annotations.length > 0) {
                methodProps.annotations = info.annotations;
              }
              methodProps.visibility = info.visibility;
              methodProps.isStatic = info.isStatic;
              methodProps.isReadonly = info.isReadonly;
            }
          }
        }
      }

      // Variable/Const/Static metadata extraction via VariableExtractor
      if (
        (nodeLabel === 'Const' || nodeLabel === 'Static' || nodeLabel === 'Variable') &&
        definitionNode &&
        provider.variableExtractor
      ) {
        let variableInfoByName = variableInfoCache.get(definitionNode.startIndex);
        if (!variableInfoByName) {
          const varCtx: VariableExtractorContext = {
            filePath: file.path,
            language,
          };
          variableInfoByName = new Map(
            provider.variableExtractor
              .extractAll(definitionNode, varCtx)
              .map((info) => [info.name, info]),
          );
          variableInfoCache.set(definitionNode.startIndex, variableInfoByName);
        }
        const varInfo = variableInfoByName.get(nodeName);
        if (varInfo) {
          if (varInfo.type) declaredType = varInfo.type;
          methodProps.visibility = varInfo.visibility;
          methodProps.isStatic = varInfo.isStatic;
          methodProps.isConst = varInfo.isConst;
          methodProps.isMutable = varInfo.isMutable;
          methodProps.scope = varInfo.scope;
        }
      }

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNode ? definitionNode.startPosition.row + lineOffset : startLine,
          endLine: definitionNode ? definitionNode.endPosition.row + lineOffset : startLine,
          language: language,
          isExported:
            language === SupportedLanguages.Vue && isVueSetup
              ? isVueSetupTopLevel(nameNode || definitionNode)
              : cachedExportCheck(provider.exportChecker, nameNode || definitionNode, nodeName),
          ...(qualifiedTypeName !== undefined ? { qualifiedName: qualifiedTypeName } : {}),
          ...(classTemplateArguments !== undefined && classTemplateArguments.length > 0
            ? { templateArguments: classTemplateArguments }
            : {}),
          ...(parsedTemplateConstraints !== undefined
            ? { templateConstraints: parsedTemplateConstraints }
            : {}),
          ...(frameworkHint
            ? {
                astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
                astFrameworkReason: frameworkHint.reason,
              }
            : {}),
          ...(description !== undefined ? { description } : {}),
          ...methodProps,
          ...(declaredType !== undefined ? { declaredType } : {}),
        },
      });

      // enclosingClassId already computed above (before nodeId generation)
      const ownerId = enclosingClassId ?? objectLiteralOwnerInfo?.ownerId;

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
        ...(qualifiedTypeName !== undefined ? { qualifiedName: qualifiedTypeName } : {}),
        parameterCount: methodProps.parameterCount as number | undefined,
        requiredParameterCount: methodProps.requiredParameterCount as number | undefined,
        parameterTypes: methodProps.parameterTypes as string[] | undefined,
        parameterTypeClasses: methodProps.parameterTypeClasses as ParameterTypeClass[] | undefined,
        returnType: methodProps.returnType as string | undefined,
        ...(declaredType !== undefined ? { declaredType } : {}),
        ...(classTemplateArguments !== undefined && classTemplateArguments.length > 0
          ? { templateArguments: classTemplateArguments }
          : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        visibility: methodProps.visibility as string | undefined,
        isStatic: methodProps.isStatic as boolean | undefined,
        isReadonly: methodProps.isReadonly as boolean | undefined,
        isAbstract: methodProps.isAbstract as boolean | undefined,
        isFinal: methodProps.isFinal as boolean | undefined,
        ...(methodProps.isDeleted !== undefined
          ? { isDeleted: methodProps.isDeleted as boolean }
          : {}),
        ...(methodProps.isVirtual !== undefined
          ? { isVirtual: methodProps.isVirtual as boolean }
          : {}),
        ...(methodProps.isOverride !== undefined
          ? { isOverride: methodProps.isOverride as boolean }
          : {}),
        ...(methodProps.isAsync !== undefined ? { isAsync: methodProps.isAsync as boolean } : {}),
        ...(methodProps.isPartial !== undefined
          ? { isPartial: methodProps.isPartial as boolean }
          : {}),
        ...(methodProps.annotations !== undefined
          ? { annotations: methodProps.annotations as string[] }
          : {}),
      });

      // Only emit File -> Symbol DEFINES for top-level symbols (issue #1944).
      if (ownerId === undefined) {
        const fileId = generateId('File', file.path);
        const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
        result.relationships.push({
          id: relId,
          sourceId: fileId,
          targetId: nodeId,
          type: 'DEFINES',
          confidence: 1.0,
          reason: '',
        });
      }

      // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
      if (ownerId !== undefined) {
        const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
        result.relationships.push({
          id: generateId(memberEdgeType, `${ownerId}->${nodeId}`),
          sourceId: ownerId,
          targetId: nodeId,
          type: memberEdgeType,
          confidence: 1.0,
          reason: objectLiteralOwnerInfo
            ? 'object literal method belongs to exported object binding'
            : '',
        });
      }

      // ── Fetch wrapper detection: record functions that call fetch() internally ──
      if (
        nodeLabel === 'Function' &&
        definitionNode &&
        nameNode &&
        (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript)
      ) {
        if (checkForFetchCall(definitionNode)) {
          result.fetchWrapperDefs.push({
            filePath: file.path,
            functionName: nameNode.text,
          });
        }
      }
    }

    // Extract framework routes via provider detection (e.g., Laravel routes.php)
    if (provider.isRouteFile?.(file.path)) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      for (const r of extractedRoutes) result.routes.push(r);
    }

    // Extract ORM queries (Prisma, Supabase)
    extractORMQueries(file.path, parseContent, result.ormQueries);

    // Extract FastAPI include_router(prefix=...) and `from <mod> import router`
    // sites. parse-impl aggregates these into a per-module prefix map and
    // injects the resolved prefix onto each ExtractedDecoratorRoute that
    // came from a `@router.<verb>` decorator. Python-only.
    if (language === SupportedLanguages.Python) {
      extractFastAPIRouterBindings(
        file.path,
        parseContent,
        result.routerIncludes,
        result.routerImports,
        (result.routerModuleAliases ??= []),
        (result.routerConstructorPrefixes ??= []),
      );
      // #2391: harvest module-level string constants + from-imports so parse-impl
      // can resolve non-literal decorator route paths cross-file. Only emit for
      // files that carry something resolvable (a constant definition or an import
      // binding) to keep the aggregate bounded on large repos.
      const constants = extractPythonModuleConstants(tree);
      if (constants.literals.size > 0 || constants.exprs.size > 0 || constants.imports.size > 0) {
        (result.moduleConstants ??= []).push({ filePath: file.path, constants });
      }
    }

    // Language-specific decorator route extraction via provider hook.
    // The provider's extractDecoratorRoutes walks the AST for framework-specific
    // route patterns (e.g., Java Spring class-level prefix joining). Routes are
    // appended to decoratorRoutes for the routes phase to emit as Route nodes.
    if (provider.extractDecoratorRoutes) {
      const frameworkRoutes = provider.extractDecoratorRoutes(tree, file.path, lineOffset);
      for (const r of frameworkRoutes) result.decoratorRoutes.push(r);
    }

    // Project-wide route-inheritance type collection via provider hook (#2288).
    // The per-file SharedSpringType views are aggregated by the parse phase,
    // which then resolves interface-inherited routes cross-file.
    if (provider.extractRouteInheritanceTypes) {
      const springTypes = provider.extractRouteInheritanceTypes(tree, file.path);
      if (springTypes.length > 0) (result.springTypes ??= []).push(...springTypes);
    }

    // Vue: emit CALLS edges for components used in <template>
    if (language === SupportedLanguages.Vue) {
      const templateComponents = extractTemplateComponents(file.content);
      for (const componentName of templateComponents) {
        result.calls.push({
          filePath: file.path,
          calledName: componentName,
          sourceId: generateId('File', file.path),
          callForm: 'free',
        });
      }
    }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
  nodes: [],
  relationships: [],
  symbols: [],
  calls: [],
  assignments: [],
  routes: [],
  fetchCalls: [],
  fetchWrapperDefs: [],
  decoratorRoutes: [],
  routerIncludes: [],
  routerImports: [],
  routerConstructorPrefixes: [],
  routerModuleAliases: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  cfgSkipped: {},
  fileCount: 0,
};
let cumulativeProcessed = 0;
// `mergeResult` (+ its `appendAll`) lives in ./result-merge.ts (extracted so it
// can be unit-tested without importing this entry module).

// Signal the pool that worker-side initialization (parser imports, language
// grammars, type-env setup, all helper modules) is complete and the message
// handler below is about to be attached. The pool's `waitForWorkerReady`
// resolves on this handshake — without it, a worker that crashes during
// top-of-script init slips past pool startup (Node's `online` event fires
// before the script body runs) and the pool only notices via the first
// dispatch's idle timeout (~30s). Emit once; the dispatch handler treats
// any subsequent `ready` message as a benign no-op.
//
// Native postMessage carries the ready handshake — Node's structured
// clone delivers `{type:'ready'}` to the pool's waitForWorkerReady
// listener directly. The pool drops the slot if this isn't seen within
// `WORKER_READY_TIMEOUT_MS` (5s), so emitting it AFTER all top-of-script
// init (imports, native binding loads, type-env setup) completes is the
// load-bearing signal that this worker is ready for dispatch.
bootstrapLog('ready sent');
parentPort!.postMessage({ type: 'ready' });

// Module-scope `TextDecoder` for sub-batch content. The pool sends each
// file's content as a `Uint8Array` (zero-copy ArrayBuffer transfer); we
// decode to string lazily here, once per file, before handing to
// tree-sitter. Hoisted to module scope so we don't allocate a new
// ICU-backed decoder per sub-batch — `TextDecoder.decode()` is
// stateless across calls and safe to share.
const sharedContentDecoder = new TextDecoder('utf-8');

/**
 * Convert the pool's sub-batch `files` array (content as `Uint8Array`,
 * transferred zero-copy) into the `ParseWorkerInput[]` shape
 * `processBatch` expects (content as `string`). This is the one place
 * the UTF-8 decode happens — runs on the worker thread in parallel with
 * continued main-thread work.
 */
function decodeSubBatchFiles(
  files: Array<{ path: string; content: Uint8Array | string }>,
): ParseWorkerInput[] {
  return files.map((f) => ({
    path: f.path,
    // Test scaffolding (the writeReadyWorker preamble that wraps
    // parentPort.on) may already convert content to string before
    // calling here; tolerate both shapes so the same worker code
    // exercises real and synthetic dispatches.
    content: typeof f.content === 'string' ? f.content : sharedContentDecoder.decode(f.content),
  }));
}

let firstTaskLogged = false;
parentPort!.on('message', (msg: WorkerIncomingMessage) => {
  if (!firstTaskLogged) {
    firstTaskLogged = true;
    bootstrapLog('first task received');
  }
  try {
    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg.type === 'sub-batch') {
      const files = decodeSubBatchFiles(
        msg.files as Array<{ path: string; content: Uint8Array | string }>,
      );
      const result = processBatch(files, (filesProcessed) => {
        parentPort!.postMessage({
          type: 'progress',
          filesProcessed: cumulativeProcessed + filesProcessed,
        });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      // Signal ready for next sub-batch
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg.type === 'flush') {
      // #1983 parallel serialization: when a store path is configured, write
      // this job's ParsedFiles to our own disk shard HERE (at the flush
      // boundary, where `accumulated.parsedFiles` is complete) and drop them
      // from the result so the main thread never deserializes/re-serializes
      // them. Writing at flush — not per sub-batch — encodes the invariant
      // "a shard is written iff its result is delivered": a worker that dies
      // before flush wrote no shard, so the pool's job retry yields exactly
      // one. `undefined` store path keeps ParsedFiles in the result (no-store
      // fallback). The write is synchronous: blocking this dedicated worker
      // thread protects the main thread and avoids threading async through the
      // accumulate path; per-job write time is small vs the parse it follows.
      if (
        (PARSED_FILE_STORE_STORAGE_PATH || DURABLE_PARSED_FILE_STORAGE_PATH) &&
        accumulated.parsedFiles.length > 0
      ) {
        const seq = shardSeq++;
        // #2038 warm-cache coverage: ALSO write a durable, content-addressed
        // shard keyed by chunk hash so a future warm parse-cache hit (no worker
        // runs) can restore these ParsedFiles without re-parsing. Same bytes,
        // same `seq`, so durable and run-scoped shards correlate. Only when the
        // flush carried a chunk hash (content-addressed dispatch).
        if (DURABLE_PARSED_FILE_STORAGE_PATH && typeof msg.chunkHash === 'string') {
          persistDurableParsedFileShardSync(
            DURABLE_PARSED_FILE_STORAGE_PATH,
            msg.chunkHash,
            threadId,
            seq,
            accumulated.parsedFiles,
          );
        }
        if (PARSED_FILE_STORE_STORAGE_PATH) {
          persistParsedFileShardSync(
            PARSED_FILE_STORE_STORAGE_PATH,
            `w${threadId}-${seq}`,
            accumulated.parsedFiles,
          );
          accumulated.parsedFiles = [];
        }
      }
      postResultCloneSafe(accumulated);
      // Reset for potential reuse
      accumulated = {
        nodes: [],
        relationships: [],
        symbols: [],
        calls: [],
        assignments: [],
        routes: [],
        fetchCalls: [],
        fetchWrapperDefs: [],
        decoratorRoutes: [],
        routerIncludes: [],
        routerImports: [],
        routerConstructorPrefixes: [],
        routerModuleAliases: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        fileScopeBindings: [],
        parsedFiles: [],
        skippedLanguages: {},
        cfgSkipped: {},
        fileCount: 0,
      };
      cumulativeProcessed = 0;
      return;
    }
  } catch (err) {
    // Carry the worker-side stack across the MessageChannel, not just the
    // message. Without this, an unexpected worker throw (e.g. the minified
    // `this.#<x> is not a function` family) reaches the operator as a bare
    // one-liner with no file:line — exactly what made #2068 undebuggable. The
    // pool embeds `errorStack` into its death/circuit-breaker reason so the
    // surfaced "Phase 'parse' failed" message points at the real frame (the
    // stack's first line already carries the error's type + message). We send
    // primitive fields (not the raw Error) so a non-cloneable `cause` payload
    // can never turn the report itself into a `messageerror`. `errorStack` is
    // optional on the wire, so an older pool ignores it.
    const e = err instanceof Error ? err : new Error(String(err));
    parentPort!.postMessage({
      type: 'error',
      error: e.message,
      errorStack: e.stack,
    });
  }
});
