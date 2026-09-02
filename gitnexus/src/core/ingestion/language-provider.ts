/**
 * Language Provider interface — the complete capability contract for a supported language.
 *
 * Each language implements this interface in a single file under `languages/`.
 * The pipeline accesses all per-language behavior through this interface.
 *
 * Design pattern: Strategy pattern with compile-time exhaustiveness.
 * The providers table in `languages/index.ts` uses `satisfies Record<SupportedLanguages, LanguageProvider>`
 * so adding a language to the enum without creating a provider is a compiler error.
 */

import type {
  SupportedLanguages,
  MroStrategy,
  CaptureMatch,
  BindingRef,
  TypeRef,
  Scope,
  ScopeId,
  ScopeKind,
  ScopeTree,
  ParsedImport,
  ParsedTypeBinding,
  SymbolDefinition,
  Callsite,
  WorkspaceIndex,
} from 'gitnexus-shared';
import type { LanguageTypeConfig } from './type-extractors/types.js';
import type { CallRouter } from './call-routing.js';
import type { CallExtractor } from './call-types.js';
import type { ClassExtractor } from './class-types.js';
import type { ExportChecker } from './export-detection.js';
import type { FieldExtractor } from './field-extractor.js';
import type { MethodExtractor } from './method-types.js';
import type { VariableExtractor } from './variable-types.js';
import type { ImportResolverFn } from './import-resolvers/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { CfgVisitor } from './cfg/types.js';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import type { ExtractedRoute } from './route-extractors/laravel.js';
import type { SharedSpringType } from './route-extractors/spring-shared.js';
import type {
  ModuleConstants,
  Operand,
  RepoConstants,
} from './route-extractors/constant-resolver.js';
import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from './workers/parse-worker.js';
import type { SpringNonHttpHandlerFact } from './frameworks/spring/non-http-handlers.js';
import type { SpringMessageProducerFact } from './frameworks/spring/message-producers.js';

/** One file's captured Spring async messaging facts, in both directions. */
export interface SpringMessagingFacts {
  /** Callables carrying a listener annotation — the inbound side. */
  readonly handlers: readonly SpringNonHttpHandlerFact[];
  /** Messaging-template publishes — the outbound side. */
  readonly producers: readonly SpringMessageProducerFact[];
}

// ── Shared type aliases ────────────────────────────────────────────────────
/** Tree-sitter query captures: capture name → AST node (or undefined if not captured). */
export type CaptureMap = Record<string, SyntaxNode | undefined>;

export interface DefinitionPropertiesContext {
  readonly nodeLabel: NodeLabel;
  readonly nodeName: string;
  readonly filePath: string;
  readonly definitionNode: SyntaxNode;
  readonly parsedImports: readonly ParsedImport[];
  readonly isExported: boolean;
}

export type DefinitionPropertiesExtractor = (
  context: DefinitionPropertiesContext,
) => Readonly<Record<string, unknown>> | undefined;

export interface RuntimeCallableIdentity {
  readonly name: string;
  readonly descriptorParameterTypes: readonly string[] | undefined;
}

/**
 * Optional language-owned bridge from runtime/compiler symbol identities to
 * source graph symbols. Framework importers use this instead of naming
 * languages or reproducing compiler conventions in shared ingestion code.
 */
export interface RuntimeSymbolStrategy {
  /** Runtime owner names that may contain this callable/property. */
  readonly callableOwnerAliases?: (
    node: GraphNode,
    owner: GraphNode | undefined,
  ) => readonly string[];
  /** Whether a runtime callable identity can conservatively identify a node. */
  readonly matchesCallable: (node: GraphNode, runtime: RuntimeCallableIdentity) => boolean;
}

/** Run optional provider enrichment without allowing one hook failure to drop
 * the rest of the worker's language batch. */
export function runDefinitionPropertiesExtractor(
  extractor: DefinitionPropertiesExtractor,
  context: DefinitionPropertiesContext,
  onError: (error: unknown) => void,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return extractor(context);
  } catch (error) {
    onError(error);
    return undefined;
  }
}

/** Provider metadata is additive; graph identity and source-location fields
 * supplied by the worker remain authoritative. */
export function mergeCanonicalDefinitionProperties<
  TCanonical extends Readonly<Record<string, unknown>>,
>(
  providerProperties: Readonly<Record<string, unknown>>,
  canonicalProperties: TCanonical,
): Record<string, unknown> & TCanonical {
  return { ...providerProperties, ...canonicalProperties } as Record<string, unknown> & TCanonical;
}

// ── Strategy tag types ─────────────────────────────────────────────────────
// NOTE: `MroStrategy` is defined in `gitnexus-shared` and re-exported above
// so `core/ingestion/model/resolve.ts` can consume it without importing from
// this file (which would pull in the full language-registry dependency graph).

/** Configuration for AST-based framework detection patterns. */
export interface AstFrameworkPatternConfig {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
  patterns: string[];
}

/**
 * Everything a language needs to provide.
 * Required fields must be explicitly set; optional fields have defaults
 * applied by defineLanguage().
 */
/**
 * Should the parse worker run {@link LanguageProviderConfig.extractModuleConstants}
 * on this file?
 *
 * Exported so the DECISION is testable without booting a worker. It encodes the
 * one rule that is easy to get backwards: a provider that declares no
 * `moduleConstantHeuristic` harvests unconditionally. Writing the gate as
 * `provider.moduleConstantHeuristic?.(content)` reads `undefined` as "skip" and
 * silently disables the hook for every provider without a heuristic — which is
 * exactly how Python's already-shipped harvest was turned off (#2391/#2980).
 */
export function shouldHarvestModuleConstants(
  provider: Pick<LanguageProvider, 'extractModuleConstants' | 'moduleConstantHeuristic'>,
  content: string,
): boolean {
  if (!provider.extractModuleConstants) return false;
  return !provider.moduleConstantHeuristic || provider.moduleConstantHeuristic(content);
}

interface LanguageProviderConfig {
  // ── Identity ──────────────────────────────────────────────────────
  readonly id: SupportedLanguages;
  /** File extensions that map to this language (e.g., ['.ts', '.tsx']) */
  readonly extensions: readonly string[];

  /** Entry-point function name patterns specific to this language.
   *  Merged with universal patterns at runtime for process detection scoring.
   *  Default: [] (only universal patterns apply). */
  readonly entryPointPatterns?: readonly RegExp[];

  /** AST-based framework detection patterns for this language.
   *  Used by detectFrameworkFromAST to identify framework entry points.
   *  Default: [] (no AST framework detection for this language). */
  readonly astFrameworkPatterns?: readonly AstFrameworkPatternConfig[];

  // ── Parser ────────────────────────────────────────────────────────
  /** Parse strategy: 'tree-sitter' (default) uses AST parsing via tree-sitter.
   *  'standalone' means the language has its own regex-based processor and
   *  should be skipped by the tree-sitter pipeline (e.g., COBOL, Markdown). */
  readonly parseStrategy?: 'tree-sitter' | 'standalone';
  /** Tree-sitter query strings for definitions, imports, calls, heritage.
   *  Required for tree-sitter languages; empty string for standalone processors. */
  readonly treeSitterQueries: string;

  /**
   * Optional source-text transform that runs **before** tree-sitter parses the file.
   *
   * Used to elide language constructs that confuse the grammar without affecting
   * source-position fidelity — e.g., Unreal Engine reflection macros (`UCLASS`,
   * `UFUNCTION`, `MODULENAME_API`) in C++ headers that prevent the parser from
   * recognising class/function names correctly.
   *
   * **Length / position preservation:** the returned string MUST have the same
   * JavaScript `.length` as the input AND preserve every newline (`\n`/`\r`)
   * position byte-for-byte. Implementations replace elided characters with
   * ASCII spaces while leaving newlines untouched. With this contract:
   *
   *   - tree-sitter's reported `startPosition.row`/`startPosition.column`
   *     match the original file exactly (line/column come from newline counts)
   *   - `startIndex`/`endIndex` byte offsets match the original file exactly
   *     **when the elided range is pure ASCII** (UTF-16 `.length` equals UTF-8
   *     byte length only for ASCII).
   *
   * Implementations targeting languages where elided ranges may contain
   * non-ASCII content must therefore preserve byte length, not just `.length`,
   * if downstream code uses `startIndex` to slice the original UTF-8 bytes.
   * The current C++ UE-macro preprocessor relies on the practical fact that
   * UE reflection macros and module-export tokens are ASCII-only.
   *
   * Must be a pure function — same input always yields the same output, and
   * re-applying it to its own output changes nothing.
   *
   * Applied by the parse worker (`parse-worker.ts`), by `extractParsedFile`
   * (`scope-extractor-bridge.ts`) on the parse-cache-miss path, and by the
   * embedding parse (`embeddings/ast-utils.ts`, which does not go through the
   * bridge). Any *new* path that re-parses a file must apply it too, or the two
   * halves of the pipeline analyze different programs — and note the set is not
   * closed today: language-owned re-parse helpers reached through other
   * provider hooks (e.g. `populateRangeBindings`) still see raw text.
   * `test/unit/preprocess-source-parity.test.ts` pins the bridge equivalence.
   *
   * Default: undefined (no preprocessing — `file.content` is parsed verbatim).
   */
  readonly preprocessSource?: (sourceText: string, filePath: string) => string;

  /**
   * Runtime/compiler identity reconciliation for framework metadata. The
   * central importer owns ambiguity handling; providers only supply aliases
   * and language-specific callable compatibility.
   */
  readonly runtimeSymbolStrategy?: RuntimeSymbolStrategy;

  // ── Core (required) ───────────────────────────────────────────────
  /** Type extraction: declarations, initializers, for-loop bindings */
  readonly typeConfig: LanguageTypeConfig;
  /** Export detection: is this AST node a public/exported symbol? */
  readonly exportChecker: ExportChecker;
  /** Import resolution: resolves raw import path to file system path */
  readonly importResolver: ImportResolverFn;

  // ── Calls & Imports (optional) ────────────────────────────────────
  /** Call routing for languages that express imports/heritage as calls (e.g., Ruby).
   *  Default: no routing (all calls are normal call expressions). */
  readonly callRouter?: CallRouter;
  /** Language-specific transformation of raw import path text before resolution.
   *  Called after sanitization. E.g., Kotlin appends wildcard suffixes.
   *  Default: undefined (no preprocessing). */
  readonly importPathPreprocessor?: (cleaned: string, importNode: SyntaxNode) => string;

  // ── Enclosing owner resolution ─────────────────────────────────
  /** Resolve a container node during enclosing-owner tree walks.
   *  Called when a CLASS_CONTAINER_TYPES node is found while walking up.
   *  - Return a different SyntaxNode to remap the container (e.g., Ruby
   *    singleton_class → enclosing class/module).
   *  - Return null to skip this container and keep walking up.
   *  - Omit (undefined) to use the container node as-is (default).
   *  Default: undefined (no remapping). */
  readonly resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null;

  // ── Enclosing function resolution ───────────────────────────────
  /** Resolve the enclosing function name + label from an AST ancestor node
   *  that is NOT a standard FUNCTION_NODE_TYPE.  For languages where the
   *  function body is a sibling of the signature (e.g. Dart: function_body ↔
   *  function_signature are siblings under program/class_body), the default
   *  parent walk cannot find the enclosing function.  This hook lets the
   *  language provider inspect each ancestor and return the resolved result.
   *  Return null to continue the default walk.
   *  Default: undefined (standard parent walk only). */
  readonly enclosingFunctionFinder?: (
    ancestorNode: SyntaxNode,
  ) => { funcName: string; label: NodeLabel } | null;

  // ── Template constraint extraction (SFINAE / `requires`) ────────────
  /**
   * Extract a per-language template-constraint payload for a templated
   * function / method definition. Used by `parsing-processor` to
   * disambiguate same-name same-arity overloads whose distinguishing
   * signal is their template constraints rather than their parameter
   * types — the canonical C++ SFINAE case (issue #1579):
   *
   *   template<class T, std::enable_if_t<is_integral_v<T>, int> = 0>
   *   void process(T);   // overload A
   *
   *   template<class T, std::enable_if_t<is_floating_point_v<T>, int> = 0>
   *   void process(T);   // overload B
   *
   * Both overloads' `parameterTypes` collapse to `['T']`, so without a
   * constraint fingerprint in the graph node ID they merge into one
   * Function node and the resolver only ever sees one candidate to
   * narrow. The hook's return value is stamped onto the node's ID via
   * `templateConstraintsIdTag()` AND stored on the node's
   * `templateConstraints` property so `resolveDefGraphId` can look up
   * the right overload by re-hashing the def's constraints at resolve
   * time.
   *
   * Returns the opaque payload (any JSON-serializable shape — the
   * producing adapter owns it; shared code MUST NOT inspect) or
   * `undefined` when no constraints exist / the node isn't a templated
   * function. Languages without SFINAE / concept semantics leave this
   * undefined and the disambiguation is a pass-through.
   *
   * Cloneability contract: the returned payload crosses the worker boundary
   * via structured clone, so it MUST be structured-clone-safe (no functions,
   * symbols, or tree-sitter `SyntaxNode`s — only plain data). Wrap the return
   * with `assertCloneable` from `workers/clone-safety.ts` so a future leak is a
   * compile error at the source instead of a runtime DataCloneError (#2143).
   */
  readonly extractTemplateConstraints?: (definitionNode: SyntaxNode) => unknown;

  // ── Labels ────────────────────────────────────────────────────────
  /** Override the default node label for definition.function captures.
   *  Return null to skip (C/C++ duplicate), a different label to reclassify
   *  (e.g., 'Method' for Kotlin), or defaultLabel to keep as-is.
   *  Default: undefined (standard label assignment). */
  readonly labelOverride?: (functionNode: SyntaxNode, defaultLabel: NodeLabel) => NodeLabel | null;

  /**
   * Suppress a definition query match after its default label is known.
   * Languages use this for syntax that represents an implicit declaration
   * unless an explicit declaration with the same semantics is present.
   *
   * `defaultLabel` is supplied so an implementation can scope itself to one
   * kind of definition; implementations whose capture map alone decides the
   * question may ignore it.
   */
  readonly shouldSkipDefinitionCapture?: (
    captureMap: CaptureMap,
    defaultLabel: NodeLabel,
  ) => boolean;

  // ── MRO ───────────────────────────────────────────────────────────
  /** MRO strategy for multiple inheritance resolution.
   *  Default: 'first-wins'. */
  readonly mroStrategy?: MroStrategy;

  // ── Language-specific extraction hooks ────────────────────────────
  /** Call extractor for extracting call site information (calledName, callForm,
   *  receiverName, argCount, mixed chains) from @call / @call.name captures.
   *  Produced by createCallExtractor() with a per-language CallExtractionConfig.
   *  Default: undefined — if unset, no calls are extracted for this language.
   *  All tree-sitter providers MUST supply this. */
  readonly callExtractor?: CallExtractor;
  /** Field extractor for extracting field/property definitions from class/struct
   *  declarations. Produces FieldInfo[] with name, type, visibility, static,
   *  readonly metadata. Default: undefined (no field extraction). */
  readonly fieldExtractor?: FieldExtractor;
  /** Method extractor for extracting method/function definitions from class/struct/interface
   *  declarations. Produces MethodInfo[] with name, parameters, visibility, isAbstract,
   *  isFinal, annotations metadata. Default: undefined (no method extraction). */
  readonly methodExtractor?: MethodExtractor;
  /** Variable extractor for extracting metadata from module/file-scoped variable,
   *  constant, and static declarations. Produces VariableInfo with type, visibility,
   *  isConst, isStatic, isMutable metadata. Default: undefined (no variable extraction). */
  readonly variableExtractor?: VariableExtractor;
  /** Add language-owned, structured properties to a definition node. Values
   *  cross the worker boundary and must therefore be structured-clone-safe.
   *  Shared ingestion code treats these properties as opaque. */
  readonly definitionPropertiesExtractor?: DefinitionPropertiesExtractor;
  /** Class/type extractor for deriving canonical qualified names for class-like symbols.
   *  Uses the same provider-driven strategy pattern as method/field extraction so
   *  namespace/package/module rules stay language-specific. */
  readonly classExtractor?: ClassExtractor;
  /** Extract a semantic description for a definition node (e.g., PHP Eloquent
   *  property arrays, relation method descriptions).
   *  Default: undefined (no description extraction). */
  readonly descriptionExtractor?: (
    nodeLabel: NodeLabel,
    nodeName: string,
    captureMap: CaptureMap,
  ) => string | undefined;
  /** Detect if a file contains single-file framework route definitions
   *  (e.g., Laravel `routes/*.php`). When true, the parse worker extracts
   *  routes from that file in isolation via the worker's route logic.
   *  Default: undefined (no route files). */
  readonly isRouteFile?: (filePath: string) => boolean;
  /** Discover the root route file(s) for a whole-repo, cross-file routing
   *  framework (e.g. Django: manage.py → settings → ROOT_URLCONF → root urls.py).
   *  Runs once on the main thread after all files are scanned. `reader` resolves
   *  arbitrary repo-relative paths (in-memory map, then disk) so discovery never
   *  depends on which parse chunk a file landed in. Returns one repo-relative
   *  path per discoverable project (empty when the framework is absent) — a
   *  monorepo with several projects yields each project's root.
   *  Pairs with `extractRoutes`; languages with this hook are skipped by the
   *  worker's single-file `isRouteFile` path. */
  readonly discoverRootRouteFiles?: (
    files: Array<{ path: string; content?: string }>,
    contentMap?: Map<string, string>,
    reader?: (relativePath: string) => string | null,
  ) => string[];
  /** Extract routes from a root route file, following cross-file includes via
   *  `reader`. Runs on the main thread (never in the worker, which has no
   *  filesystem access). `parser` is a tree-sitter parser preloaded with this
   *  language's grammar, available for re-parsing included files.
   *  Default: undefined (no route extraction). */
  readonly extractRoutes?: (
    tree: Parser.Tree,
    filePath: string,
    reader: (relativePath: string) => string | null,
    parser?: Parser | null,
  ) => ExtractedRoute[];

  /**
   * Extract routes that a parsed file declares in its own AST.
   *
   * When defined, the parse worker calls this after per-file capture processing
   * to extract route definitions that require AST-level analysis beyond
   * generic `@decorator` captures (e.g., Java Spring class-level prefix joining,
   * multi-class handling). The returned routes are appended to `decoratorRoutes`.
   *
   * Decorators are the common case and the reason for the name, but not the only
   * shape: JS/TS uses this hook for hand-rolled dispatch guards
   * (`route-extractors/dispatch-guard.ts`), where a raw `node:http` server
   * declares a route by comparing the request path to a literal. Anything that
   * yields a `(path, verb, handler)` triple from one file's AST belongs here —
   * set `ExtractedDecoratorRoute.source` when the provenance is not a decorator,
   * so the `HANDLES_ROUTE` edge does not claim one.
   *
   * Default: undefined (no language-specific route extraction).
   */
  readonly extractDecoratorRoutes?: (
    tree: Parser.Tree,
    filePath: string,
    lineOffset: number,
  ) => ExtractedDecoratorRoute[];

  /**
   * Name of the function a route decorator captured by the worker's generic
   * `@decorator` query applies to, given the decorator's own AST node.
   *
   * The worker knows a decorator is a route decorator but not how this
   * language's grammar attaches it to a definition, so it hands the node over
   * unchanged and takes whatever the language returns. Only languages that
   * declare route handlers through the generic decorator captures need this;
   * languages with a dedicated {@link extractDecoratorRoutes} extractor
   * (JS/TS via `nest.ts`, Java via `spring.ts`) already set
   * `ExtractedDecoratorRoute.handlerName` there and should leave this undefined.
   *
   * Implementations must read their own decorated-definition shape directly and
   * return undefined for anything else — never climb ancestors to find a name,
   * since a decorator that is not attached to a function has no handler and a
   * borrowed enclosing name resolves `handlerSymbolId` to the wrong symbol. The
   * routes phase treats undefined as "fall back to the file-level edge".
   *
   * Default: undefined (no handler name from generic decorator captures).
   */
  readonly decoratorRouteHandlerName?: (decoratorNode: SyntaxNode) => string | undefined;

  /**
   * Collect a project-wide, language-agnostic view of route-defining
   * class/interface declarations (`SharedSpringType`) from a parsed file.
   *
   * When defined, the parse worker calls this per file and the parse phase
   * aggregates the results, then runs a cross-file pass that resolves
   * interface-inherited routes (a concrete controller inherits the `@*Mapping`s
   * its interfaces declare) and appends them to `decoratorRoutes`. Separate from
   * `extractDecoratorRoutes` because inheritance needs all files, not one.
   *
   * Default: undefined (no interface-inheritance route resolution).
   */
  readonly extractRouteInheritanceTypes?: (
    tree: Parser.Tree,
    filePath: string,
  ) => SharedSpringType[];

  /**
   * Optional post-capture emission of synthetic structure members (nodes,
   * symbols, ownership edges) that have no AST method node — e.g. Lombok
   * accessors. Called once per file after the capture loop, at the same
   * post-capture site as {@link extractDecoratorRoutes}.
   *
   * `classOwnersByNodeId` maps in-memory tree-sitter node ids of type
   * declarations materialized in THIS file's capture loop to their graph
   * node ids. Keys are never persisted; they exist only for the duration
   * of the worker pass.
   *
   * Default: undefined (no synthetic structure members).
   */
  readonly synthesizeStructureMembers?: (
    tree: Parser.Tree,
    filePath: string,
    classOwnersByNodeId: ReadonlyMap<number, string>,
  ) => {
    nodes: ReadonlyArray<{
      id: string;
      label: string;
      properties: Record<string, unknown>;
    }>;
    symbols: ReadonlyArray<{
      filePath: string;
      name: string;
      nodeId: string;
      type: string;
      ownerId?: string;
      parameterCount?: number;
      requiredParameterCount?: number;
      parameterTypes?: string[];
      returnType?: string;
      visibility?: string;
      isStatic?: boolean;
      isAbstract?: boolean;
      isFinal?: boolean;
    }>;
    relationships: ReadonlyArray<{
      id: string;
      sourceId: string;
      targetId: string;
      type: string;
      confidence: number;
      reason: string;
    }>;
  };

  /**
   * Harvest this file's module-level string constants (#2391 core, #2980 Java
   * parity) into the language-agnostic {@link ModuleConstants} shape, so the
   * parse phase can resolve non-literal decorator route paths cross-file.
   *
   * The worker calls this when BOTH hold:
   *  - the provider declares no `moduleConstantHeuristic`, or the one it
   *    declares matched — syntax-driven, e.g. a `static final String` field or
   *    a constants-bearing import; NEVER a class-name pattern like
   *    `*Constants`, which silently drops route constants living in classes
   *    named e.g. `ApiPaths`/`Routes`, and
   *  - the extraction yields something resolvable (a literal, an expression, or
   *    an import binding), keeping the aggregate bounded on large repos.
   *
   * Default: undefined (no constant harvest; non-literal route paths of this
   * language floor to skip).
   */
  readonly extractModuleConstants?: (tree: Parser.Tree) => ModuleConstants;

  /**
   * Cheap content heuristic deciding whether the worker should run
   * {@link extractModuleConstants} on a file. Guards the harvest cost on huge
   * repos: files that cannot contribute (no constant-bearing syntax) are not
   * walked. Must be syntax-driven (field/import shape), not identifier
   * pattern-matching on class names.
   *
   * Default: undefined — harvest EVERY file of this language. A gate is opt-in
   * because getting it wrong silently drops routes that already resolve, and a
   * missed gate only costs time. Declare one only where the cost bites (Java's
   * Maven monorepos) and only after checking it against every shape
   * {@link extractModuleConstants} accepts.
   */
  readonly moduleConstantHeuristic?: (content: string) => boolean;

  /**
   * Prepare this language's harvested constants once the complete repo map is
   * available and before route operands are folded. The parse phase passes only
   * entries owned by this provider, so implementations can build one reusable
   * language-specific index and may materialize deferred bindings in place.
   *
   * Default: undefined (the harvested constants are already fold-ready).
   */
  readonly prepareRouteConstants?: (repo: RepoConstants) => void;

  /**
   * Spring async messaging facts captured for one file — the listener
   * annotations that subscribe to a broker destination and the template calls
   * that publish to one.
   *
   * Both families are collected during capture and restored on the main thread
   * by {@link LanguageProviderConfig.applyCaptureSideChannel}, so they are only
   * readable AFTER scope resolution has run. The `springDestinations` phase is
   * the caller; routing through a provider hook is what keeps that phase from
   * naming a language to reach a per-language fact store.
   *
   * Default: undefined — this language captures no Spring messaging facts, and
   * the phase contributes nothing for its files.
   */
  readonly getSpringMessagingFacts?: (filePath: string) => SpringMessagingFacts;

  /**
   * Whether this language INTERPOLATES its string literals — Kotlin's
   * `"orders-$env"` and `"orders-${env}"` are string templates evaluated at
   * runtime, while Java's are ordinary characters.
   *
   * A capability rather than a language name, because shared ingestion code may
   * not branch on a language (see AGENTS.md) and because the capability is what
   * the consumer actually needs. Spring destination resolution is the caller:
   * in an interpolating language an unescaped `$` in a destination literal is a
   * runtime value and must be refused, and `"${app.topic}"` is a TEMPLATE, not
   * a Spring property placeholder — the placeholder has to be written
   * `"\${app.topic}"` there. Reading either as an address gives two unrelated
   * services one shared destination node.
   *
   * Default: false — literals are literal, `$` is a character.
   */
  readonly interpolatesStringLiterals?: boolean;

  /**
   * Fold one file's non-literal route-path operand list
   * (`routePathExpr`/`routePathOperands` of an `ExtractedDecoratorRoute`)
   * against the repo-wide, file-path-keyed constant map, or null when it cannot
   * be fully folded (skip floor — never a phantom path). Languages whose
   * qualified refs resolve through class imports (`Outer.CONST`,
   * `com.example.ApiPaths.USERS`) need this hook because the shared fold has no
   * notion of qualified names; Python's bare-name refs use the shared default.
   *
   * Default: undefined (the parse phase falls back to the shared
   * language-agnostic operand fold).
   */
  readonly foldRoutePathOperands?: (
    filePath: string,
    operands: readonly Operand[],
    repo: RepoConstants,
  ) => string | null;

  // ── Noise filtering ────────────────────────────────────────────────
  /** Built-in/stdlib names that should be filtered from the call graph for this language.
   *  Default: undefined (no language-specific filtering). */
  readonly builtInNames?: ReadonlySet<string>;

  // ══════════════════════════════════════════════════════════════════════════
  //  Scope-based resolution hooks (RFC #909 — Ring 1 #911)
  //
  //  All hooks below are OPTIONAL with safe defaults so existing providers
  //  continue to compile unchanged. Ring 2 (#919–#925) wires these into the
  //  central `ScopeExtractor` + finalize pipeline; Ring 3 per-language
  //  tickets implement the ones each language needs.
  //
  //  See: https://www.notion.so/346dc50b6ed281cfaacbe480bf231d50 §5.2
  // ══════════════════════════════════════════════════════════════════════════

  // ── Parse phase (per-capture interpretation) ───────────────────────

  /**
   * Emit scope captures from raw source, **pre-grouped per tree-sitter
   * query match**. Tree-sitter-based providers run a scope query
   * (embedded as a string constant in each language's `query.ts`) and
   * emit one `CaptureMatch` per query match; standalone providers
   * (COBOL) emit matches from a regex tagger. The return shape is
   * parser-agnostic: the central `ScopeExtractor` consumes
   * `CaptureMatch[]` without knowing which parser produced them.
   *
   * **Pre-grouping is the provider's job.** The extractor expects each
   * `CaptureMatch` to correspond to one logical match — e.g., an import
   * statement match carries `@import.statement` + `@import.source` +
   * `@import.name` keyed under their capture names. Providers MUST
   * preserve the tree-sitter match boundaries so the extractor's topic
   * routing (scope / declaration / import / type-binding / reference)
   * lands on coherent records.
   *
   * Required for any provider participating in scope-based resolution
   * (the sole resolution path).
   *
   * **Sync return.** Tree-sitter query execution and COBOL's regex
   * tagger are both synchronous; no current or foreseeable provider
   * needs async work inside this hook. The sync signature lets
   * `parse-worker.ts` (#920) invoke it inline in its already-sync
   * per-file loop without cascading `async` through the batch pipeline.
   *
   * Default: undefined (no scope-based captures emitted for this language).
   */
  readonly emitScopeCaptures?: (
    sourceText: string,
    filePath: string,
    /**
     * Optional pre-parsed tree-sitter Tree the caller has already
     * produced (e.g. from the parse phase's AST cache). When supplied,
     * the provider SHOULD skip its own `parser.parse(sourceText)` and
     * run its capture query against the supplied tree directly. Typed
     * as `unknown` here to avoid leaking the tree-sitter dependency
     * into the provider contract — the provider casts at use site.
     * Cache miss (parameter omitted or undefined) is always safe and
     * MUST trigger a fresh parse.
     */
    cachedTree?: unknown,
    /**
     * Optional metadata about how `sourceText` was produced.
     *
     * Most providers ignore this and treat `sourceText` as full file content.
     * Vue uses it to distinguish:
     *   - `full-file`: full `.vue` SFC source
     *   - `pre-extracted-script`: worker-preprocessed bare `<script>` content
     *
     * Default: `{ sourceKind: 'full-file' }`.
     */
    sourceMeta?: {
      readonly sourceKind?: 'full-file' | 'pre-extracted-script';
    },
  ) => readonly CaptureMatch[];

  /**
   * Snapshot the capture-time side-channel state that this provider's
   * `emitScopeCaptures` just populated for `filePath` into module-level maps,
   * returning a plain JSON-serializable value (or `undefined` when there is
   * nothing to carry).
   *
   * Called in the parse worker IMMEDIATELY after `emitScopeCaptures` runs for
   * a file (see `parse-worker.ts`), and the result is stored on the produced
   * `ParsedFile.captureSideChannel`. Scope-resolution on the main thread reuses
   * that serialized `ParsedFile` and skips re-extraction (#1983), so this hook
   * is how the worker-computed marks survive the worker→main boundary and the
   * disk store WITHOUT a main-thread re-parse. The main thread restores them
   * via the matching `ScopeResolver.applyCaptureSideChannel` hook.
   *
   * Cloneability contract: MUST return plain data (objects / arrays /
   * primitives — no functions, symbols, or tree-sitter `SyntaxNode`s) so it
   * survives BOTH the worker→main structured clone AND `JSON.stringify` + the
   * parsedfile-store interning reviver. Wrap the return with `assertCloneable`
   * from `workers/clone-safety.ts` so a future non-serializable leak is a
   * compile error at the source instead of a runtime DataCloneError (#2143).
   *
   * Default: undefined (provider has no capture-time module-level side effects).
   */
  readonly collectCaptureSideChannel?: (filePath: string) => unknown;

  /**
   * Per-language control-flow-graph builder (#2081 M1, PDG/taint substrate).
   * Invoked IN THE PARSE WORKER (where the AST lives) for each function node,
   * gated on the `--pdg` opt-in; the resulting per-function CFGs are serialized
   * onto `ParsedFile.cfgSideChannel` and emitted as BasicBlock nodes + CFG
   * edges during scope-resolution. `TNode` is `SyntaxNode` for the tree-sitter
   * languages. Default: undefined (language has no CFG support yet — TS/JS are
   * the M1 set).
   */
  readonly cfgVisitor?: CfgVisitor<SyntaxNode>;

  /**
   * Interpret a raw `@import.statement` capture group into a `ParsedImport`.
   * The central finalize algorithm resolves `ParsedImport.targetRaw` to a
   * concrete file via `resolveImportTarget` and materializes the final
   * `ImportEdge` with `targetModuleScope` / `targetDefId` filled in.
   *
   * Required when `emitScopeCaptures` is implemented.
   */
  readonly interpretImport?: (captures: CaptureMatch) => ParsedImport | null;

  /**
   * Do this language's imports EXECUTE at the point in the program where they
   * are written?
   *
   * The scope extractor marks an import `runsOnlyWhenCalled` when the statement
   * sits inside a `Function` scope (Pass 3): where imports are executed
   * statements, one written in a function body runs only when that function is
   * called — Python's `def f(): from x import Y`, Ruby's
   * `def f; require 'x'; end`, a CommonJS `require()` in a body (which
   * `javascript/captures.ts` does capture, via its own AST walk). That rule is
   * about EXECUTION. It says nothing true about a language whose "import" is
   * not an executed statement at all, and in such a language moving one into a
   * function body defers exactly nothing.
   *
   * "Where written" is about execution time, not textual placement: a
   * `#include` is spliced precisely where it is written and still answers
   * `false`, because splicing is not running.
   *
   * **The failure directions are not symmetric, which is why the default is
   * what it is.** Answering `false` for a language that really does execute
   * its imports un-defers a deliberately lazy one, and `check --cycles`
   * reports a cycle its author broke on purpose — wrong, but visible on screen
   * and arguable by whoever reads it. Answering `true` for a language that
   * does not SUPPRESSES a cycle that is entirely real: nobody sees it, so
   * nobody can argue with it. Getting this wrong in the `true` direction hides
   * a true cycle, and that is the failure that matters.
   *
   * Absent — the default — reads as `true`, so every provider that does not
   * name this keeps today's behaviour exactly. The flag never ADDS deferral;
   * declaring `false` only WITHHOLDS it.
   *
   * Declared `false` by, and only by:
   *
   *   - **C and C++** — `#include` is a preprocessor directive. The header's
   *     text is spliced in before a line of the program runs, wherever the
   *     directive sits, and C permits one inside a function body. C++'s only
   *     other Pass-3 import form, `using ns::name` / `using namespace ns`, is
   *     compile-time name lookup, is legal in a function body too, and defers
   *     no more than an `#include` does.
   *   - **Rust** — `use` is a compile-time path alias, not a statement that
   *     runs. `fn f() { use crate::m::X; }` is legal, and putting the `use`
   *     there changes only where the name is VISIBLE, never when anything
   *     happens; Rust has no module-initialization order in the JS/Python
   *     sense and permits intra-crate module cycles outright. It is the
   *     structural twin of C++'s `using ns::name`. `rust/query.ts` captures
   *     `(use_declaration)` and nothing else, so this covers the whole
   *     surface. (The claim here is the narrow one: POSITION does not defer a
   *     Rust import. Whether a Rust `use` can create an initialization
   *     dependency *at all* is a larger and separate question, and this flag
   *     deliberately does not answer it.)
   *   - **COBOL** — `COPY` is a pure textual splice performed by the copybook
   *     preprocessor, the `#include` case exactly. Latent today: the COBOL
   *     `@scope.function` capture covers a single line (`cobol/captures.ts`
   *     ranges sections and paragraphs `line → line`), so a `COPY` on any
   *     later line never resolves inside one and Pass 3 has nothing to mark.
   *     Declared anyway, so that giving those anchors their true multi-line
   *     ranges cannot silently start suppressing real copybook cycles.
   *
   * Per-provider rather than per-import, and that is sufficient — the question
   * this answers is narrower than "do this language's imports execute". It is
   * only ever asked of an import that resolved INSIDE A FUNCTION SCOPE, so the
   * real domain is: *can a function-local import in this language be
   * non-executing?* No supported language has two forms that are both
   * function-local and disagree. C++ has two forms, `#include` and
   * `using ns::name`; both can appear in a body and both are compile-time.
   *
   * PHP is the case that looks like a counterexample and is not. It does mix —
   * `use Foo\Bar;` aliases at compile time while `require` executes — but
   * `use` cannot appear in a function body at all (`php/query.ts` records this
   * twice: "`namespace_use_declaration` is an import only at top level / inside
   * namespace scope"), so it never reaches this flag. Absent is therefore
   * PERMANENTLY correct for PHP, including the day `require` is captured: a
   * `require` in a body will correctly defer, and a `use` still cannot get
   * here. Do not read PHP as a reason to build a per-`ParsedImport`
   * classification hook — it would cost a provider call per import on the
   * extractor's hot path, and `ParsedImport.kind` does not discriminate the
   * thing being asked anyway.
   *
   * A capability on the provider rather than a language check in
   * `scope-extractor.ts`: shared `core/ingestion/` pipeline code must not name
   * languages (AGENTS.md), and "imports here are not executed statements" is a
   * property of the language, not of the walk.
   *
   * Default: undefined, read as `true` (imports execute where they are
   * written; position defers them).
   */
  readonly importsExecuteWhereWritten?: boolean;

  /**
   * What is the implicit receiver on a Function scope? For instance methods
   * this is `self`/`this`; for standalone functions it is `null`. Consulted
   * by `Registry.lookup` Step 2 via the `resolveTypeRef` helper.
   *
   * Required for any language with method dispatch (OO semantics).
   *
   * Default: undefined (treated as `null` — no implicit receiver).
   */
  readonly receiverBinding?: (functionScope: Scope) => TypeRef | null;

  /**
   * Interpret a raw type-binding capture (parameter annotation, `self`,
   * assignment with constructor RHS, …) into a `ParsedTypeBinding`. The
   * central extractor attaches the resulting `TypeRef` to the appropriate
   * scope's `typeBindings` map.
   *
   * Default: undefined (falls back to `{ boundName: captures.name, rawTypeName: captures.type, source: 'annotation' }`).
   */
  readonly interpretTypeBinding?: (captures: CaptureMatch) => ParsedTypeBinding | null;

  /**
   * Override the `ScopeKind` assigned to a scope capture. Use when the
   * capture name alone can't resolve the kind (e.g., tree-sitter captures
   * a `block` that is semantically an `Expression` in this language).
   *
   * Default: undefined (the central extractor uses the capture name's
   * suffix — `@scope.function` → `'Function'`, etc.).
   */
  readonly resolveScopeKind?: (captures: CaptureMatch) => ScopeKind | null;

  /**
   * Report the receiver names this scope BINDS rather than inherits — see
   * `Scope.ownsReceivers` (#2701).
   *
   * Called once per `@scope.*` capture during scope-tree construction.
   * Return the shared frozen set for a scope that starts a fresh receiver
   * (a JS/TS ordinary `function`, whose `this` is bound at call time), and
   * `undefined` for one that inherits it (an arrow function, and every
   * closure form in languages that capture the receiver lexically).
   *
   * Default: undefined everywhere — the receiver walk is unchanged.
   */
  readonly scopeOwnsReceivers?: (captures: CaptureMatch) => ReadonlySet<string> | undefined;

  /**
   * Override where a declaration's name becomes visible. By default the name
   * is bound in the innermost enclosing scope; return a different `ScopeId`
   * to hoist it (JS `var` → enclosing function scope; Ruby `def` inside
   * `begin` → enclosing class scope).
   *
   * Return `null` to delegate to the central default (innermost enclosing
   * scope). This matches the `X | null` convention used by the other optional
   * hooks and supports partial overrides — e.g., a JS provider can return a
   * hoisted scope for `var` declarations and `null` for `let`/`const`, without
   * re-implementing the default lookup.
   *
   * **Purity:** must be a pure function of its inputs — same parameters must
   * yield the same `ScopeId` (or `null`) across invocations. No closure over
   * mutable state. Required so scope-tree construction stays deterministic
   * across re-parses.
   *
   * Default: undefined (the central extractor uses `innermostScope.id`).
   */
  readonly bindingScopeFor?: (
    declCapture: CaptureMatch,
    innermostScope: Scope,
    scopeTree: ScopeTree,
  ) => ScopeId | null;

  // ── Finalize phase (cross-file + materialization) ──────────────────

  /**
   * Resolve a `ParsedImport.targetRaw` expression to a concrete file path in
   * the workspace. Language-specific resolution: Python relative imports,
   * JS package.json + node_modules, Go module paths, Java classpath,
   * COBOL COPY paths. Ports today's per-language import resolver.
   *
   * Required when `emitScopeCaptures` is implemented. Ring 2 PKG #922
   * provides the adapter that bridges today's resolver shape to this hook.
   */
  readonly resolveImportTarget?: (
    parsedImport: ParsedImport,
    workspaceIndex: WorkspaceIndex,
  ) => string | readonly string[] | null;

  /**
   * Enumerate the exported names of a file — used by the finalize algorithm
   * to expand `import * from M` into individual `BindingRef`s with
   * `origin: 'wildcard'`.
   *
   * Default: undefined (central finalize walks the target file's
   * `ExportMap.keys()`).
   */
  readonly expandsWildcardTo?: (
    targetFile: string,
    workspaceIndex: WorkspaceIndex,
  ) => readonly string[];

  /**
   * Decide the scope to which a `ParsedImport` attaches. Most languages
   * attach imports to the nearest enclosing `Module`/`Namespace` scope
   * (the default); some languages allow local imports (Python function-local
   * `from x import Y`, Rust fn-local `use`, TS dynamic `import()`) — return
   * a `Function`/`Block` scope id instead.
   *
   * Return `null` to delegate to the central default (nearest enclosing
   * `Module`/`Namespace`). This matches the `X | null` convention used by
   * the other optional hooks and supports partial overrides — a provider
   * that handles only specific import forms non-standardly can `return null`
   * for the common cases and let the central walk handle them.
   *
   * **Purity:** must be a pure function of its inputs — same parameters must
   * yield the same `ScopeId` (or `null`) across invocations. No closure over
   * mutable state. Required so scope-tree construction stays deterministic
   * across re-parses.
   *
   * Default: undefined (central finalize walks to the nearest enclosing
   * `Module` or `Namespace` scope).
   */
  readonly importOwningScope?: (
    parsedImport: ParsedImport,
    innermostScope: Scope,
    scopeTree: ScopeTree,
  ) => ScopeId | null;

  /**
   * Merge local declarations and imported bindings for a single (scope, name)
   * during finalize materialization of a scope's binding table. Language-
   * specific precedence: Python local hides import; TypeScript namespace
   * merging keeps both; Ruby constant resolution has its own rules.
   *
   * Default: undefined (central finalize uses local-first-then-imports,
   * deduping by `DefId`).
   */
  readonly mergeBindings?: (scope: Scope, bindings: readonly BindingRef[]) => readonly BindingRef[];

  // ── Reference-extraction phase ─────────────────────────────────────

  /**
   * Classify a `@reference.call` capture as free / member / constructor /
   * index. Preferred path is declarative via capture sub-tags
   * (`@reference.call.free`, etc.); this hook handles the languages where
   * call form can't be decided statically (Ruby bare `foo(x)` is free-or-
   * member until resolved).
   *
   * Default: undefined (central extractor reads capture sub-tag if present;
   * else treats as `'free'`).
   */
  readonly classifyCallForm?: (
    captures: CaptureMatch,
    enclosingScope: Scope,
  ) => 'free' | 'member' | 'constructor' | 'index';

  // ── Resolution phase (RFC §4v2) ────────────────────────────────────

  /** Order same-name type candidates when a language can index multiple
   * definitions for one logical type. Return null to keep shared ambiguity
   * handling. */
  readonly orderSameNameTypeCandidates?: (params: {
    readonly typeName: string;
    readonly callSiteFilePath: string;
    readonly candidates: readonly SymbolDefinition[];
  }) => readonly SymbolDefinition[] | null;

  /**
   * Is this callable definition compatible with the given call-site arity?
   * Language-specific rules: Python `*args`/`**kwargs`/defaults, JS default
   * params + rest, Kotlin vararg + defaults, Ruby optional/splat/block, Go
   * straight counts, Rust no-variadic-no-defaults.
   *
   * `'incompatible'` is a soft penalty (−0.15 per EvidenceWeights) and is
   * filtered only when at least one `'compatible'` candidate exists;
   * otherwise the incompatible candidate is kept with the penalty so the
   * call-site still links to a best-guess target.
   *
   * Default: undefined (treated as `'unknown'` — no signal either way).
   */
  readonly arityCompatibility?: (
    def: SymbolDefinition,
    callsite: Callsite,
  ) => 'compatible' | 'unknown' | 'incompatible';
}

/** Runtime type — same as LanguageProviderConfig but with defaults guaranteed present. */
export interface LanguageProvider extends Omit<LanguageProviderConfig, 'mroStrategy'> {
  readonly mroStrategy: MroStrategy;
  /** Check if a name is a built-in/stdlib function that should be filtered from the call graph. */
  readonly isBuiltInName: (name: string) => boolean;
}

/**
 * Run each provider's repo-constant preparation hook once over only the files
 * that provider owns. Values are shared with `repo`, so in-place preparation
 * is visible to the subsequent fold without copying the complete map.
 */
export function prepareRouteConstantsByProvider(
  repo: RepoConstants,
  providerForFile: (filePath: string) => Pick<LanguageProvider, 'prepareRouteConstants'> | null,
): void {
  const slices = new Map<
    Pick<LanguageProvider, 'prepareRouteConstants'>,
    Map<string, ModuleConstants>
  >();
  for (const [filePath, constants] of repo) {
    const provider = providerForFile(filePath);
    if (!provider?.prepareRouteConstants) continue;
    let slice = slices.get(provider);
    if (!slice) {
      slice = new Map();
      slices.set(provider, slice);
    }
    slice.set(filePath, constants);
  }
  for (const [provider, slice] of slices) {
    provider.prepareRouteConstants?.(slice);
  }
}

const DEFAULTS: Pick<LanguageProvider, 'mroStrategy'> = {
  mroStrategy: 'first-wins',
};

/** Define a language provider — required fields must be supplied, optional fields get sensible defaults. */
export function defineLanguage(config: LanguageProviderConfig): LanguageProvider {
  const builtIns = config.builtInNames;
  return {
    ...DEFAULTS,
    ...config,
    isBuiltInName: builtIns ? (name: string) => builtIns.has(name) : () => false,
  };
}
