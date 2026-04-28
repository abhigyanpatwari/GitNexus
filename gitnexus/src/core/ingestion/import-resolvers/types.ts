/**
 * Import resolution types — shared across all per-language resolvers.
 *
 * Extracted from import-resolution.ts to co-locate types with their consumers.
 */

import type {
  TsconfigPaths,
  GoModuleConfig,
  CSharpProjectConfig,
  ComposerConfig,
} from '../language-config.js';
import type { SwiftPackageConfig } from '../language-config.js';
import type { SuffixIndex } from './utils.js';
import type { SupportedLanguages } from 'gitnexus-shared';

/**
 * Result of resolving an import via language-specific dispatch.
 * - 'files': resolved to one or more files -> add to ImportMap
 * - 'package': resolved to a directory -> add graph edges + store dirSuffix in PackageMap
 * - null: no resolution (external dependency, etc.)
 */
export type ImportResult =
  | { kind: 'files'; files: string[] }
  | { kind: 'package'; files: string[]; dirSuffix: string }
  | null;

/** Bundled language-specific configs loaded once per ingestion run. */
export interface ImportConfigs {
  tsconfigPaths: TsconfigPaths | null;
  goModule: GoModuleConfig | null;
  composerConfig: ComposerConfig | null;
  swiftPackageConfig: SwiftPackageConfig | null;
  csharpConfigs: CSharpProjectConfig[];
}

/** Pre-built lookup structures for import resolution. Build once, reuse across chunks. */
export interface ImportResolutionContext {
  allFilePaths: Set<string>;
  allFileList: string[];
  normalizedFileList: string[];
  index: SuffixIndex;
  resolveCache: Map<string, string | null>;
}

/** Full context for import resolution: file lookups + language configs. */
export interface ResolveCtx extends ImportResolutionContext {
  configs: ImportConfigs;
}

/** Per-language import resolver -- function alias matching ExportChecker/CallRouter pattern. */
export type ImportResolverFn = (
  rawImportPath: string,
  filePath: string,
  resolveCtx: ResolveCtx,
) => ImportResult;

/**
 * A single import resolution strategy — one step in a composable chain.
 * Same signature as ImportResolverFn. Returns null to let the next strategy
 * in the chain try; returns a result (even with empty files) to stop the chain.
 */
export type ImportResolverStrategy = ImportResolverFn;

/**
 * Declarative config for composable import resolution — mirrors the
 * MethodExtractionConfig / CallExtractionConfig pattern.
 *
 * Each language declares an ordered list of strategies to try.
 * The factory (`createImportResolver`) chains them: first non-null result wins.
 */
export interface ImportResolutionConfig {
  /**
   * Documentation-only metadata identifying which language this config serves.
   * **Not used by `createImportResolver`** — the factory only iterates `strategies`.
   * Useful for logging, debugging, and compile-time exhaustiveness checks when
   * mapping `SupportedLanguages → ImportResolutionConfig` in language providers.
   */
  readonly language: SupportedLanguages;
  readonly strategies: readonly ImportResolverStrategy[];
}
