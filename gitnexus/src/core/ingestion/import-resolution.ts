/**
 * Import Resolution Dispatch
 *
 * Per-language dispatch table for import resolution and named binding extraction.
 * Replaces the 120-line if-chain in resolveLanguageImport() and the 7-branch
 * dispatch in extractNamedBindings() with a single table lookup each.
 *
 * Follows the existing ExportChecker / CallRouter pattern:
 *   - Function aliases (not interfaces) to avoid megamorphic inline-cache issues
 *   - `satisfies Record<SupportedLanguages, ...>` for compile-time exhaustiveness
 *   - Const dispatch table — configs are accessed via ctx.configs at call time
 */

import { SupportedLanguages } from '../../config/supported-languages.js';
import type { SyntaxNode } from './utils.js';
import {
  KOTLIN_EXTENSIONS,
  appendKotlinWildcard,
  resolveJvmWildcard,
  resolveJvmMemberImport,
  resolveGoPackageDir,
  resolveGoPackage,
  resolveCSharpImport as resolveCSharpImportHelper,
  resolveCSharpNamespaceDir,
  resolvePhpImport as resolvePhpImportHelper,
  resolveRustImport as resolveRustImportHelper,
  resolveRubyImport as resolveRubyImportHelper,
  resolvePythonImport as resolvePythonImportHelper,
  resolveImportPath,
} from './resolvers/index.js';
import type {
  SuffixIndex,
  TsconfigPaths,
  GoModuleConfig,
  CSharpProjectConfig,
  ComposerConfig,
} from './resolvers/index.js';
import type { SwiftPackageConfig } from './language-config.js';
import {
  extractTsNamedBindings,
  extractPythonNamedBindings,
  extractKotlinNamedBindings,
  extractRustNamedBindings,
  extractPhpNamedBindings,
  extractCsharpNamedBindings,
  extractJavaNamedBindings,
} from './named-binding-extraction.js';
import type { ImportResolutionContext } from './import-processor.js';

// ============================================================================
// Types
// ============================================================================

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

/** A single named import binding: local name in the importing file and exported name from the source. */
export interface NamedBinding { local: string; exported: string }

/** Per-language named binding extractor -- optional (returns undefined if language has no named imports). */
type NamedBindingExtractorFn = (importNode: SyntaxNode) => NamedBinding[] | undefined;

// ============================================================================
// Import path preprocessing
// ============================================================================

/**
 * Clean and preprocess a raw import source text into a resolved import path.
 * Strips quotes/angle brackets (universal) and applies language-specific
 * transformations (currently only Kotlin wildcard import detection).
 */
export function preprocessImportPath(
  sourceText: string,
  importNode: SyntaxNode,
  language: SupportedLanguages,
): string | null {
  const cleaned = sourceText.replace(/['"<>]/g, '');
  // Defense-in-depth: reject null bytes and control characters (matches Ruby call-routing pattern)
  if (!cleaned || cleaned.length > 2048 || /[\x00-\x1f]/.test(cleaned)) return null;
  if (language === SupportedLanguages.Kotlin) {
    return appendKotlinWildcard(cleaned, importNode);
  }
  return cleaned;
}

// ============================================================================
// Per-language resolver functions
// ============================================================================

/**
 * Standard single-file resolution (TS/JS/C/C++ and fallback for other languages).
 * Handles relative imports, tsconfig path aliases, and suffix matching.
 */
function resolveStandard(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
  language: SupportedLanguages,
): ImportResult {
  const resolvedPath = resolveImportPath(
    filePath,
    rawImportPath,
    ctx.allFilePaths,
    ctx.allFileList,
    ctx.normalizedFileList,
    ctx.resolveCache,
    language,
    ctx.configs.tsconfigPaths,
    ctx.index,
  );
  return resolvedPath ? { kind: 'files', files: [resolvedPath] } : null;
}

/** Java: JVM wildcard -> member import -> standard fallthrough */
function resolveJavaImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    const memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    if (memberResolved) return { kind: 'files', files: [memberResolved] };
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Java);
}

/**
 * Kotlin: JVM wildcard/member with Java-interop fallback -> top-level function imports -> standard.
 * Kotlin can import from .kt/.kts files OR from .java files (Java interop).
 */
function resolveKotlinImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
    if (matchedFiles.length === 0) {
      const javaMatches = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
      if (javaMatches.length > 0) return { kind: 'files', files: javaMatches };
    }
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    let memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
    if (!memberResolved) {
      memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    }
    if (memberResolved) return { kind: 'files', files: [memberResolved] };

    // Kotlin: top-level function imports (e.g. import models.getUser) have only 2 segments,
    // which resolveJvmMemberImport skips (requires >=3). Fall back to package-directory scan
    // for lowercase last segments (function/property imports). Uppercase last segments
    // (class imports like models.User) fall through to standard suffix resolution.
    const segments = rawImportPath.split('.');
    const lastSeg = segments[segments.length - 1];
    if (segments.length >= 2 && lastSeg[0] && lastSeg[0] === lastSeg[0].toLowerCase()) {
      const pkgWildcard = segments.slice(0, -1).join('.') + '.*';
      let dirFiles = resolveJvmWildcard(pkgWildcard, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
      if (dirFiles.length === 0) {
        dirFiles = resolveJvmWildcard(pkgWildcard, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
      }
      if (dirFiles.length > 0) return { kind: 'files', files: dirFiles };
    }
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Kotlin);
}

/** Go: package-level imports via go.mod module path. */
function resolveGoImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const goModule = ctx.configs.goModule;
  if (goModule && rawImportPath.startsWith(goModule.modulePath)) {
    const pkgSuffix = resolveGoPackageDir(rawImportPath, goModule);
    if (pkgSuffix) {
      const pkgFiles = resolveGoPackage(rawImportPath, goModule, ctx.normalizedFileList, ctx.allFileList);
      if (pkgFiles.length > 0) {
        return { kind: 'package', files: pkgFiles, dirSuffix: pkgSuffix };
      }
    }
    // Fall through if no files found (package might be external)
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Go);
}

/** C#: namespace-based resolution via .csproj configs, with suffix-match fallback. */
function resolveCSharpImportDispatch(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const csharpConfigs = ctx.configs.csharpConfigs;
  if (csharpConfigs.length > 0) {
    const resolvedFiles = resolveCSharpImportHelper(rawImportPath, csharpConfigs, ctx.normalizedFileList, ctx.allFileList, ctx.index);
    if (resolvedFiles.length > 1) {
      const dirSuffix = resolveCSharpNamespaceDir(rawImportPath, csharpConfigs);
      if (dirSuffix) {
        return { kind: 'package', files: resolvedFiles, dirSuffix };
      }
    }
    if (resolvedFiles.length > 0) return { kind: 'files', files: resolvedFiles };
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.CSharp);
}

/** PHP: namespace-based resolution via composer.json PSR-4. */
function resolvePhpImportDispatch(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolvePhpImportHelper(rawImportPath, ctx.configs.composerConfig, ctx.allFilePaths, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
}

/** Swift: module imports via Package.swift target map. */
function resolveSwiftImportDispatch(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const swiftPackageConfig = ctx.configs.swiftPackageConfig;
  if (swiftPackageConfig) {
    const targetDir = swiftPackageConfig.targets.get(rawImportPath);
    if (targetDir) {
      const dirPrefix = targetDir + '/';
      const files: string[] = [];
      for (let i = 0; i < ctx.normalizedFileList.length; i++) {
        if (ctx.normalizedFileList[i].startsWith(dirPrefix) && ctx.normalizedFileList[i].endsWith('.swift')) {
          files.push(ctx.allFileList[i]);
        }
      }
      if (files.length > 0) return { kind: 'files', files };
    }
  }
  return null; // External framework (Foundation, UIKit, etc.)
}

/**
 * Python: relative imports (PEP 328) + proximity-based bare imports.
 * Falls through to standard suffix resolution when proximity finds no match.
 */
function resolvePythonImportDispatch(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolvePythonImportHelper(filePath, rawImportPath, ctx.allFilePaths);
  if (resolved) return { kind: 'files', files: [resolved] };
  if (rawImportPath.startsWith('.')) return null; // relative but unresolved -- don't suffix-match
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Python);
}

/** Ruby: require / require_relative. */
function resolveRubyImportDispatch(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolveRubyImportHelper(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
}

/** Rust: expand grouped imports: use {crate::a, crate::b} and use crate::models::{User, Repo}. */
function resolveRustImportDispatch(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  // Top-level grouped: use {crate::a, crate::b}
  if (rawImportPath.startsWith('{') && rawImportPath.endsWith('}')) {
    const inner = rawImportPath.slice(1, -1);
    const parts = inner.split(',').map(p => p.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveRustImportHelper(filePath, part, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    return resolved.length > 0 ? { kind: 'files', files: resolved } : null;
  }

  // Scoped grouped: use crate::models::{User, Repo}
  const braceIdx = rawImportPath.indexOf('::{');
  if (braceIdx !== -1 && rawImportPath.endsWith('}')) {
    const pathPrefix = rawImportPath.substring(0, braceIdx);
    const braceContent = rawImportPath.substring(braceIdx + 3, rawImportPath.length - 1);
    const items = braceContent.split(',').map(s => s.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const item of items) {
      // Handle `use crate::models::{User, Repo as R}` — strip alias for resolution
      const itemName = item.includes(' as ') ? item.split(' as ')[0].trim() : item;
      const r = resolveRustImportHelper(filePath, `${pathPrefix}::${itemName}`, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    if (resolved.length > 0) return { kind: 'files', files: resolved };
    // Fallback: resolve the prefix path itself (e.g. crate::models -> models.rs)
    const prefixResult = resolveRustImportHelper(filePath, pathPrefix, ctx.allFilePaths);
    if (prefixResult) return { kind: 'files', files: [prefixResult] };
  }

  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Rust);
}

// ============================================================================
// Dispatch tables
// ============================================================================

/**
 * Per-language import resolver dispatch table.
 * Configs are accessed via ctx.configs at call time — no factory closure needed.
 * Each resolver encapsulates the full resolution flow for its language, including
 * fallthrough to standard resolution where appropriate.
 */
export const importResolvers = {
  [SupportedLanguages.JavaScript]: (raw, fp, ctx) => resolveStandard(raw, fp, ctx, SupportedLanguages.JavaScript),
  [SupportedLanguages.TypeScript]: (raw, fp, ctx) => resolveStandard(raw, fp, ctx, SupportedLanguages.TypeScript),
  [SupportedLanguages.Python]: (raw, fp, ctx) => resolvePythonImportDispatch(raw, fp, ctx),
  [SupportedLanguages.Java]: (raw, fp, ctx) => resolveJavaImport(raw, fp, ctx),
  [SupportedLanguages.C]: (raw, fp, ctx) => resolveStandard(raw, fp, ctx, SupportedLanguages.C),
  [SupportedLanguages.CPlusPlus]: (raw, fp, ctx) => resolveStandard(raw, fp, ctx, SupportedLanguages.CPlusPlus),
  [SupportedLanguages.CSharp]: (raw, fp, ctx) => resolveCSharpImportDispatch(raw, fp, ctx),
  [SupportedLanguages.Go]: (raw, fp, ctx) => resolveGoImport(raw, fp, ctx),
  [SupportedLanguages.Ruby]: (raw, fp, ctx) => resolveRubyImportDispatch(raw, fp, ctx),
  [SupportedLanguages.Rust]: (raw, fp, ctx) => resolveRustImportDispatch(raw, fp, ctx),
  [SupportedLanguages.PHP]: (raw, fp, ctx) => resolvePhpImportDispatch(raw, fp, ctx),
  [SupportedLanguages.Kotlin]: (raw, fp, ctx) => resolveKotlinImport(raw, fp, ctx),
  [SupportedLanguages.Swift]: (raw, fp, ctx) => resolveSwiftImportDispatch(raw, fp, ctx),
} satisfies Record<SupportedLanguages, ImportResolverFn>;

/**
 * Per-language named binding extractor dispatch table.
 * Languages with whole-module import semantics (Go, Ruby, C/C++, Swift) return undefined --
 * their bindings are synthesized post-parse by synthesizeWildcardImportBindings() in pipeline.ts.
 */
export const namedBindingExtractors = {
  [SupportedLanguages.JavaScript]: extractTsNamedBindings,
  [SupportedLanguages.TypeScript]: extractTsNamedBindings,
  [SupportedLanguages.Python]: extractPythonNamedBindings,
  [SupportedLanguages.Java]: extractJavaNamedBindings,
  [SupportedLanguages.C]: undefined,
  [SupportedLanguages.CPlusPlus]: undefined,
  [SupportedLanguages.CSharp]: extractCsharpNamedBindings,
  [SupportedLanguages.Go]: undefined,
  [SupportedLanguages.Ruby]: undefined,
  [SupportedLanguages.Rust]: extractRustNamedBindings,
  [SupportedLanguages.PHP]: extractPhpNamedBindings,
  [SupportedLanguages.Kotlin]: extractKotlinNamedBindings,
  [SupportedLanguages.Swift]: undefined,
} satisfies Record<SupportedLanguages, NamedBindingExtractorFn | undefined>;
