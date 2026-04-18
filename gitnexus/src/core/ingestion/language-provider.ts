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
import type {
  CallExtractor,
  DispatchDecision,
  ImplicitReceiverOverride,
  ReceiverEnriched,
} from './call-types.js';
import type { ClassExtractor } from './class-types.js';
import type { ExportChecker } from './export-detection.js';
import type { FieldExtractor } from './field-extractor.js';
import type { HeritageExtractor } from './heritage-types.js';
import type { MethodExtractor } from './method-types.js';
import type { VariableExtractor } from './variable-types.js';
import type { ImportResolverFn } from './import-resolvers/types.js';
import type { NamedBindingExtractorFn } from './named-bindings/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';

// ── Shared type aliases ────────────────────────────────────────────────────
/** Tree-sitter query captures: capture name → AST node (or undefined if not captured). */
export type CaptureMap = Record<string, SyntaxNode | undefined>;

// ── Strategy tag types ─────────────────────────────────────────────────────
// NOTE: `MroStrategy` is defined in `gitnexus-shared` and re-exported above
// so `core/ingestion/model/resolve.ts` can consume it without importing from
// this file (which would pull in the full language-registry dependency graph).

/**
 * How a language handles imports — determines wildcard synthesis behavior.
 *
 * Import resolution is a graph-traversal policy with multiple distinct strategies,
 * analogous to MRO for method resolution. Each tag picks a strategy:
 *
 * | Tag                   | Mechanism                                      | Traversal           | Languages                                  |
 * |-----------------------|------------------------------------------------|---------------------|--------------------------------------------|
 * | `named`               | Per-symbol imports                             | None (use-site)     | JS/TS, Java, C#, Rust, PHP, Kotlin, Vue    |
 * | `wildcard-transitive` | Textual paste, symbols chain through files     | BFS closure         | C, C++ (future: Obj-C, Fortran, Nim)       |
 * | `wildcard-leaf`       | Whole public API, single hop                   | None (direct only)  | Go, Ruby, Swift, Dart                      |
 * | `namespace`           | Qualified handle; symbols resolved at call site| None at import      | Python                                     |
 * | `explicit-reexport`   | Opt-in per-symbol re-export (SCAFFOLD)         | Topological DAG     | (future: TS `export *`, Rust `pub use`)    |
 *
 * The `explicit-reexport` tag is a compile-time scaffold; no provider claims it yet.
 * It falls through to `wildcard-leaf` behavior in synthesis so today's TS/Rust
 * handling is unchanged. A future PR will implement the DAG walk for `export *`.
 */
export type ImportSemantics =
  | 'named'
  | 'wildcard-transitive'
  | 'wildcard-leaf'
  | 'namespace'
  | 'explicit-reexport';

/**
 * Everything a language needs to provide.
 * Required fields must be explicitly set; optional fields have defaults
 * applied by defineLanguage().
 */
interface LanguageProviderConfig {
  // ── Identity ──────────────────────────────────────────────────────
  readonly id: SupportedLanguages;
  /** File extensions that map to this language (e.g., ['.ts', '.tsx']) */
  readonly extensions: readonly string[];

  // ── Parser ────────────────────────────────────────────────────────
  /** Parse strategy: 'tree-sitter' (default) uses AST parsing via tree-sitter.
   *  'standalone' means the language has its own regex-based processor and
   *  should be skipped by the tree-sitter pipeline (e.g., COBOL, Markdown). */
  readonly parseStrategy?: 'tree-sitter' | 'standalone';
  /** Tree-sitter query strings for definitions, imports, calls, heritage.
   *  Required for tree-sitter languages; empty string for standalone processors. */
  readonly treeSitterQueries: string;

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
  /** Named binding extraction from import statements.
   *  Default: undefined (language uses wildcard/whole-module imports). */
  readonly namedBindingExtractor?: NamedBindingExtractorFn;
  /** How this language handles imports. See `ImportSemantics` for the full taxonomy.
   *  - 'named': per-symbol imports (JS/TS, Java, C#, Rust, PHP, Kotlin)
   *  - 'wildcard-transitive': textual-include closure; imports chain through files (C, C++)
   *  - 'wildcard-leaf': whole-module single-hop imports; no transitive chaining (Go, Ruby, Swift, Dart)
   *  - 'namespace': qualified namespace imports, needs moduleAliasMap (Python)
   *  - 'explicit-reexport': opt-in per-symbol re-export (scaffold; no provider uses yet)
   *  Default: 'named'. */
  readonly importSemantics?: ImportSemantics;
  /** Language-specific transformation of raw import path text before resolution.
   *  Called after sanitization. E.g., Kotlin appends wildcard suffixes.
   *  Default: undefined (no preprocessing). */
  readonly importPathPreprocessor?: (cleaned: string, importNode: SyntaxNode) => string;
  /** Wire implicit inter-file imports for languages where all files in a module
   *  see each other (e.g., Swift targets, C header inclusion units).
   *  Called with only THIS language's files (pre-grouped by the processor).
   *  Default: undefined (no implicit imports). */
  readonly implicitImportWirer?: (
    languageFiles: string[],
    importMap: ReadonlyMap<string, ReadonlySet<string>>,
    addImportEdge: (src: string, target: string) => void,
    projectConfig: unknown,
  ) => void;

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

  // ── Labels ────────────────────────────────────────────────────────
  /** Override the default node label for definition.function captures.
   *  Return null to skip (C/C++ duplicate), a different label to reclassify
   *  (e.g., 'Method' for Kotlin), or defaultLabel to keep as-is.
   *  Default: undefined (standard label assignment). */
  readonly labelOverride?: (functionNode: SyntaxNode, defaultLabel: NodeLabel) => NodeLabel | null;

  // ── Heritage & MRO ────────────────────────────────────────────────
  /** Default edge type when parent symbol is ambiguous (interface vs class).
   *  Default: 'EXTENDS'. */
  readonly heritageDefaultEdge?: 'EXTENDS' | 'IMPLEMENTS';
  /** Regex to detect interface names by convention (e.g., /^I[A-Z]/ for C#/Java).
   *  When matched, IMPLEMENTS edge is used instead of heritageDefaultEdge. */
  readonly interfaceNamePattern?: RegExp;
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
  /** Class/type extractor for deriving canonical qualified names for class-like symbols.
   *  Uses the same provider-driven strategy pattern as method/field extraction so
   *  namespace/package/module rules stay language-specific. */
  readonly classExtractor?: ClassExtractor;
  /** Heritage extractor for extracting extends/implements/trait-impl relationships
   *  from tree-sitter @heritage.* captures and call-based heritage (e.g., Ruby
   *  include/extend/prepend). Produced by createHeritageExtractor() — pass a
   *  SupportedLanguages value for default behaviour or a full
   *  HeritageExtractionConfig for languages with custom hooks (Go, Ruby).
   *  All tree-sitter providers MUST supply this. */
  readonly heritageExtractor?: HeritageExtractor;
  /** Extract a semantic description for a definition node (e.g., PHP Eloquent
   *  property arrays, relation method descriptions).
   *  Default: undefined (no description extraction). */
  readonly descriptionExtractor?: (
    nodeLabel: NodeLabel,
    nodeName: string,
    captureMap: CaptureMap,
  ) => string | undefined;
  /** Detect if a file contains framework route definitions (e.g., Laravel routes.php).
   *  When true, the worker extracts routes via the language's route extraction logic.
   *  Default: undefined (no route files). */
  readonly isRouteFile?: (filePath: string) => boolean;

  // ── Call-resolution DAG hooks ─────────────────────────────────────
  /**
   * DAG stage 3 hook: synthesize an implicit receiver when the call site omits one.
   *
   * Runs after shared inference (TypeEnv → constructor-map → class-as-receiver →
   * mixed-chain). Return an `ImplicitReceiverOverride` to overlay all fields onto
   * `ReceiverEnriched`; return null to keep current state and proceed to stage 4.
   *
   * Constraints: MUST return null when an explicit receiver is already set, at
   * top-level scope, or for built-in methods. Do not mutate input params.
   * `hint` is opaque to shared stages; consumed by this language's `selectDispatch`.
   *
   * Ruby example: bare `serialize` in `Account#call_serialize` →
   * `{ callForm: 'member', receiverName: 'self', receiverTypeName: 'Account',
   *    receiverSource: 'implicit-self', hint: 'instance' }`
   *
   * @see call-types.ts § ImplicitReceiverOverride
   * @see selectDispatch (stage 4, reads the hint)
   *
   * Default: undefined (no implicit-receiver inference).
   */
  readonly inferImplicitReceiver?: (params: {
    readonly calledName: string;
    readonly callForm: 'free' | 'member' | 'constructor' | undefined;
    readonly receiverName: string | undefined;
    readonly receiverTypeName: string | undefined;
    readonly callNode: SyntaxNode;
    readonly filePath: string;
  }) => ImplicitReceiverOverride | null;

  /**
   * DAG stage 4 hook: decide dispatch strategy (primary path, fallback, MRO view).
   *
   * Runs after stage 3. Return a `DispatchDecision` to override shared defaults;
   * return null to use `defaultDispatchDecision` (constructor→`'constructor'`,
   * member→`'owner-scoped'`, free→`'free'`). Most languages return null.
   *
   * The hook is responsible for its own gating. `ancestryView` only affects
   * `'ruby-mixin'` strategy. Singleton-ancestry miss NEVER falls through to
   * file-scoped fallback in stage 5 (enforced in resolveCallTarget).
   *
   * Ruby examples:
   * - `receiverSource='implicit-self', hint='instance'` →
   *   `{primary: 'owner-scoped', fallback: 'free-arity-narrowed', ancestryView: 'instance'}`
   * - `receiverSource='class-as-receiver'` →
   *   `{primary: 'owner-scoped', ancestryView: 'singleton'}` (miss null-routes)
   * - `receiverSource='implicit-self', hint='singleton'` →
   *   `{primary: 'owner-scoped', fallback: 'free-arity-narrowed', ancestryView: 'singleton'}`
   *
   * @see call-types.ts § DispatchDecision
   * @see call-processor.ts § defaultDispatchDecision, resolveCallTarget
   *
   * Default: undefined (use `defaultDispatchDecision`).
   */
  readonly selectDispatch?: (params: {
    readonly calledName: string;
    readonly callForm: 'free' | 'member' | 'constructor' | undefined;
    readonly receiverName: string | undefined;
    readonly receiverTypeName: string | undefined;
    readonly receiverSource: ReceiverEnriched['receiverSource'];
    readonly hint: string | undefined;
  }) => DispatchDecision | null;

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
   * query match**. Tree-sitter-based providers run a `scopes.scm` query
   * and emit one `CaptureMatch` per query match; standalone providers
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
   * Required for any provider participating in scope-based resolution.
   * Providers that have not yet migrated continue to run through the
   * legacy DAG path (feature-flagged per `REGISTRY_PRIMARY_<LANG>`).
   *
   * Default: undefined (language continues to use legacy DAG).
   */
  readonly emitScopeCaptures?: (
    sourceText: string,
    filePath: string,
  ) => Promise<readonly CaptureMatch[]>;

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
   * Should this scope capture materialize as a real `Scope` node? Return
   * `false` to skip scope creation while still emitting declarations that
   * would have gone inside (they attach to the enclosing real scope).
   *
   * Example: Python `if`/`for`/`while` bodies capture as `@scope.block` but
   * Python has no block scope — hook returns `false` and child declarations
   * lift to the enclosing function/module.
   *
   * Default: undefined (treated as `true` — always create).
   */
  readonly shouldCreateScope?: (captures: CaptureMatch) => boolean;

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
  ) => string | null;

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

  /**
   * Does a binding at this scope shadow bindings of the same name in outer
   * scopes? Default: any binding shadows (standard lexical scoping). Return
   * `false` for transparent-scope edge cases (Python `from x import *`
   * contexts, JS `var` hoisting quirks, COBOL PARAGRAPH transparency).
   *
   * Consulted by `Registry.lookup` Step 1 and by `resolveTypeRef` for
   * shadowing decisions during the lexical chain walk.
   *
   * Default: undefined (treated as `true` — any binding shadows).
   */
  readonly shouldShadow?: (scope: Scope, bindings: readonly BindingRef[]) => boolean;

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
export interface LanguageProvider extends Omit<
  LanguageProviderConfig,
  'importSemantics' | 'heritageDefaultEdge' | 'mroStrategy'
> {
  readonly importSemantics: ImportSemantics;
  readonly heritageDefaultEdge: 'EXTENDS' | 'IMPLEMENTS';
  readonly mroStrategy: MroStrategy;
  /** Check if a name is a built-in/stdlib function that should be filtered from the call graph. */
  readonly isBuiltInName: (name: string) => boolean;
}

const DEFAULTS: Pick<LanguageProvider, 'importSemantics' | 'heritageDefaultEdge' | 'mroStrategy'> =
  {
    importSemantics: 'named',
    heritageDefaultEdge: 'EXTENDS',
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
