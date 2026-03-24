/**
 * Import resolution types — shared across all per-language resolvers.
 *
 * Extracted from import-resolution.ts to co-locate types with their consumers.
 */

import type { TsconfigPaths, GoModuleConfig, CSharpProjectConfig, ComposerConfig } from './index.js';
import type { SwiftPackageConfig } from '../language-config.js';
import type { ImportResolutionContext } from '../import-processor.js';

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
