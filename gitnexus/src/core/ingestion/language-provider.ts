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

import type { SupportedLanguages } from '../../config/supported-languages.js';
import type { LanguageTypeConfig } from './type-extractors/types.js';
import type { CallRouter } from './call-routing.js';
import type { ExportChecker } from './export-detection.js';
import type { ImportResolverFn } from './import-resolvers/types.js';
import type { NamedBindingExtractorFn } from './named-bindings/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { NodeLabel } from '../graph/types.js';

// ── Shared type aliases ────────────────────────────────────────────────────
/** Tree-sitter query captures: capture name → AST node (or undefined if not captured). */
export type CaptureMap = Record<string, SyntaxNode | undefined>;

// ── Strategy tag types ─────────────────────────────────────────────────────
/** MRO strategy for multiple inheritance resolution. */
export type MroStrategy = 'first-wins' | 'c3' | 'leftmost-base' | 'implements-split' | 'qualified-syntax';
/** How a language handles imports — determines wildcard synthesis behavior. */
export type ImportSemantics = 'named' | 'wildcard' | 'namespace';

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
  /** Tree-sitter query strings for definitions, imports, calls, heritage */
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
  /** How this language handles imports.
   *  - 'named': per-symbol imports (JS/TS, Java, C#, Rust, PHP, Kotlin)
   *  - 'wildcard': whole-module imports, needs synthesis (Go, Ruby, C/C++, Swift)
   *  - 'namespace': namespace imports, needs moduleAliasMap (Python)
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

  // ── Enclosing function resolution ───────────────────────────────
  /** Resolve the enclosing function name + label from an AST ancestor node
   *  that is NOT a standard FUNCTION_NODE_TYPE.  For languages where the
   *  function body is a sibling of the signature (e.g. Dart: function_body ↔
   *  function_signature are siblings under program/class_body), the default
   *  parent walk cannot find the enclosing function.  This hook lets the
   *  language provider inspect each ancestor and return the resolved result.
   *  Return null to continue the default walk.
   *  Default: undefined (standard parent walk only). */
  readonly enclosingFunctionFinder?: (ancestorNode: SyntaxNode) => { funcName: string; label: NodeLabel } | null;

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

  // ── Noise filtering ────────────────────────────────────────────────
  /** Built-in/stdlib names that should be filtered from the call graph for this language.
   *  Default: undefined (no language-specific filtering). */
  readonly builtInNames?: ReadonlySet<string>;
}

/** Runtime type — same as LanguageProviderConfig but with defaults guaranteed present. */
export interface LanguageProvider extends Omit<LanguageProviderConfig,
  'importSemantics' | 'heritageDefaultEdge' | 'mroStrategy'
> {
  readonly importSemantics: ImportSemantics;
  readonly heritageDefaultEdge: 'EXTENDS' | 'IMPLEMENTS';
  readonly mroStrategy: MroStrategy;
  /** Check if a name is a built-in/stdlib function that should be filtered from the call graph. */
  readonly isBuiltInName: (name: string) => boolean;
}

const DEFAULTS: Pick<LanguageProvider, 'importSemantics' | 'heritageDefaultEdge' | 'mroStrategy'> = {
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
