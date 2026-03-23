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
import type { ImportResolverFn, NamedBindingExtractorFn } from './import-resolution.js';
import type { SyntaxNode } from './ast-helpers.js';

/**
 * Complete capability bundle for a supported language.
 *
 * Required capabilities must be provided by every language.
 * Optional capabilities have sensible defaults (no-op or empty).
 */
export interface LanguageProvider {
  // ── Identity ──────────────────────────────────────────────────────
  readonly id: SupportedLanguages;
  /** File extensions that map to this language (e.g., ['.ts', '.tsx']) */
  readonly extensions: readonly string[];

  // ── Parser ────────────────────────────────────────────────────────
  /** Tree-sitter query strings for definitions, imports, calls, heritage */
  readonly treeSitterQueries: string;

  // ── Core Capabilities (required) ──────────────────────────────────
  /** Type extraction: declarations, initializers, for-loop bindings */
  readonly typeConfig: LanguageTypeConfig;
  /** Export detection: is this AST node a public/exported symbol? */
  readonly exportChecker: ExportChecker;
  /** Import resolution: resolves raw import path to file system path */
  readonly importResolver: ImportResolverFn;

  // ── Optional Capabilities ─────────────────────────────────────────
  /** Call routing for languages that express imports/heritage as calls (e.g., Ruby).
   *  Default: no routing (all calls are normal call expressions). */
  readonly callRouter?: CallRouter;
  /** Named binding extraction from import statements.
   *  Default: undefined (language uses wildcard/whole-module imports). */
  readonly namedBindingExtractor?: NamedBindingExtractorFn;

  // ── Import Behavior ───────────────────────────────────────────────
  /** How this language handles imports — determines wildcard synthesis behavior.
   *  - 'named': per-symbol imports (JS/TS, Java, C#, Rust, PHP, Kotlin)
   *  - 'wildcard': whole-module imports, needs synthesis (Go, Ruby, C/C++, Swift)
   *  - 'namespace': namespace imports, needs moduleAliasMap (Python)
   *  Default: 'named'. */
  readonly importSemantics: 'named' | 'wildcard' | 'namespace';

  // ── AST Label Classification ────────────────────────────────────────
  /** Override the default node label for definition.function captures.
   *  Return null to skip (C/C++ duplicate), a different label to reclassify
   *  (e.g., 'Method' for Kotlin), or defaultLabel to keep as-is.
   *  Default: undefined (standard label assignment). */
  readonly labelOverride?: (functionNode: SyntaxNode, defaultLabel: string) => string | null;

  // ── Heritage & MRO ────────────────────────────────────────────────
  /** Default edge type when parent symbol is ambiguous (interface vs class).
   *  Default: 'EXTENDS'. */
  readonly heritageDefaultEdge?: 'EXTENDS' | 'IMPLEMENTS';
  /** Regex to detect interface names by convention (e.g., /^I[A-Z]/ for C#/Java).
   *  When matched, IMPLEMENTS edge is used instead of heritageDefaultEdge. */
  readonly interfaceNamePattern?: RegExp;
  /** MRO strategy for multiple inheritance resolution.
   *  Default: 'first-wins'. */
  readonly mroStrategy?: 'c3' | 'leftmost-base' | 'implements-split' | 'qualified-syntax' | 'first-wins';

  // ── Description Extraction ──────────────────────────────────────
  /** Extract a semantic description for a definition node (e.g., PHP Eloquent
   *  property arrays, relation method descriptions).
   *  Default: undefined (no description extraction). */
  readonly descriptionExtractor?: (
    nodeLabel: string,
    nodeName: string,
    captureMap: Record<string, any>,
  ) => string | undefined;

  // ── Import Path Preprocessing ────────────────────────────────────
  /** Language-specific transformation of raw import path text before resolution.
   *  Called after sanitization. E.g., Kotlin appends wildcard suffixes.
   *  Default: undefined (no preprocessing). */
  readonly importPathPreprocessor?: (cleaned: string, importNode: SyntaxNode) => string;

  // ── Implicit Import Wiring ──────────────────────────────────────
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

  // ── Framework Route Extraction ──────────────────────────────────
  /** Detect if a file contains framework route definitions (e.g., Laravel routes.php).
   *  When true, the worker extracts routes via the language's route extraction logic.
   *  Default: undefined (no route files). */
  readonly isRouteFile?: (filePath: string) => boolean;
}

/** Required fields that every provider must supply. */
type RequiredProviderFields = 'id' | 'extensions' | 'treeSitterQueries' | 'typeConfig' | 'exportChecker' | 'importResolver';

/** Config accepted by createLanguageProvider: required fields are mandatory, everything else optional with defaults. */
type LanguageProviderConfig =
  Pick<LanguageProvider, RequiredProviderFields> &
  Partial<Omit<LanguageProvider, RequiredProviderFields>>;

/**
 * Create a LanguageProvider with sensible defaults for optional capabilities.
 * Only the required fields (id, extensions, treeSitterQueries, typeConfig,
 * exportChecker, importResolver) must be specified.
 */
export function createLanguageProvider(config: LanguageProviderConfig): LanguageProvider {
  return {
    importSemantics: 'named',
    heritageDefaultEdge: 'EXTENDS',
    mroStrategy: 'first-wins',
    ...config,
  };
}
