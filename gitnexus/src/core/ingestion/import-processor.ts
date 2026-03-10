import fs from 'fs/promises';
import path from 'path';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, isVerboseIngestionEnabled, yieldToEventLoop } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import type { ExtractedImport } from './workers/parse-worker.js';

const isDev = process.env.NODE_ENV === 'development';

// Type: Map<FilePath, Set<ResolvedFilePath>>
// Stores all files that a given file imports from
export type ImportMap = Map<string, Set<string>>;

export const createImportMap = (): ImportMap => new Map();

/** Pre-built lookup structures for import resolution. Build once, reuse across chunks. */
export interface ImportResolutionContext {
  allFilePaths: Set<string>;
  allFileList: string[];
  normalizedFileList: string[];
  suffixIndex: SuffixIndex;
  resolveCache: Map<string, string | null>;
}

/** Max entries in the resolve cache. Beyond this, the cache is cleared to bound memory.
 *  100K entries ≈ 15MB — covers the most common import patterns. */
const RESOLVE_CACHE_CAP = 100_000;

export function buildImportResolutionContext(allPaths: string[]): ImportResolutionContext {
  const allFileList = allPaths;
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));
  const allFilePaths = new Set(allFileList);
  const suffixIndex = buildSuffixIndex(normalizedFileList, allFileList);
  return { allFilePaths, allFileList, normalizedFileList, suffixIndex, resolveCache: new Map() };
}

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG
// ============================================================================

/** TypeScript path alias config parsed from tsconfig.json */
interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Go module config parsed from go.mod */
interface GoModuleConfig {
  /** Module path (e.g., "github.com/user/repo") */
  modulePath: string;
}

/**
 * Parse tsconfig.json to extract path aliases.
 * Tries tsconfig.json, tsconfig.app.json, tsconfig.base.json in order.
 */
async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    try {
      const tsconfigPath = path.join(repoRoot, filename);
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      // Strip JSON comments (// and /* */ style) for robustness
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped);
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl || '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0] as string;

        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;

        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        if (isDev) {
          console.log(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
        }
        return { aliases, baseUrl };
      }
    } catch {
      // File doesn't exist or isn't valid JSON - try next
    }
  }

  return null;
}

/**
 * Parse go.mod to extract module path.
 */
async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  try {
    const goModPath = path.join(repoRoot, 'go.mod');
    const content = await fs.readFile(goModPath, 'utf-8');
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      if (isDev) {
        console.log(`📦 Loaded Go module path: ${match[1]}`);
      }
      return { modulePath: match[1] };
    }
  } catch {
    // No go.mod
  }
  return null;
}

/** PHP Composer PSR-4 autoload config */
interface ComposerConfig {
  /** Map of namespace prefix -> directory (e.g., "App\\" -> "app/") */
  psr4: Map<string, string>;
}

async function loadComposerConfig(repoRoot: string): Promise<ComposerConfig | null> {
  try {
    const composerPath = path.join(repoRoot, 'composer.json');
    const raw = await fs.readFile(composerPath, 'utf-8');
    const composer = JSON.parse(raw);
    const psr4Raw = composer.autoload?.['psr-4'] ?? {};
    const psr4Dev = composer['autoload-dev']?.['psr-4'] ?? {};
    const merged = { ...psr4Raw, ...psr4Dev };

    const psr4 = new Map<string, string>();
    for (const [ns, dir] of Object.entries(merged)) {
      const nsNorm = (ns as string).replace(/\\+$/, '');
      const dirNorm = (dir as string).replace(/\\/g, '/').replace(/\/+$/, '');
      psr4.set(nsNorm, dirNorm);
    }

    if (isDev) {
      console.log(`📦 Loaded ${psr4.size} PSR-4 mappings from composer.json`);
    }
    return { psr4 };
  } catch {
    return null;
  }
}

/** Swift Package Manager module config */
interface SwiftPackageConfig {
  /** Map of target name -> source directory path (e.g., "SiuperModel" -> "Package/Sources/SiuperModel") */
  targets: Map<string, string>;
}

async function loadSwiftPackageConfig(repoRoot: string): Promise<SwiftPackageConfig | null> {
  // Swift imports are module-name based (e.g., `import SiuperModel`)
  // SPM convention: Sources/<TargetName>/ or Package/Sources/<TargetName>/
  // We scan for these directories to build a target map
  const targets = new Map<string, string>();

  const sourceDirs = ['Sources', 'Package/Sources', 'src'];
  for (const sourceDir of sourceDirs) {
    try {
      const fullPath = path.join(repoRoot, sourceDir);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.set(entry.name, sourceDir + '/' + entry.name);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  if (targets.size > 0) {
    if (isDev) {
      console.log(`📦 Loaded ${targets.size} Swift package targets`);
    }
    return { targets };
  }
  return null;
}

// ============================================================================
// IMPORT PATH RESOLUTION
// ============================================================================

/** All file extensions to try during resolution */
const EXTENSIONS = [
  '',
  // TypeScript/JavaScript
  '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
  // Python
  '.py', '/__init__.py',
  // Java
  '.java',
  // Kotlin
  '.kt', '.kts',
  // C/C++
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs', '/mod.rs',
  // PHP
  '.php', '.phtml',
  // Swift
  '.swift',
];

/**
 * Try to match a path (with extensions) against the known file set.
 * Returns the matched file path or null.
 */
function tryResolveWithExtensions(
  basePath: string,
  allFiles: Set<string>,
): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a suffix index for O(1) endsWith lookups.
 * Maps every possible path suffix to its original file path.
 * e.g. for "src/com/example/Foo.java":
 *   "Foo.java" -> "src/com/example/Foo.java"
 *   "example/Foo.java" -> "src/com/example/Foo.java"
 *   "com/example/Foo.java" -> "src/com/example/Foo.java"
 *   etc.
 */
export interface SuffixIndex {
  /** Exact suffix lookup (case-sensitive) */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup */
  getInsensitive(suffix: string): string | undefined;
  /** Get all files in a directory suffix */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // Map: normalized suffix -> original file path
  const exactMap = new Map<string, string>();
  // Map: lowercase suffix -> original file path
  const lowerMap = new Map<string, string>();
  // Map: directory suffix -> list of file paths in that directory
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    // Index all suffixes: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      // Only store first match (longest path wins for ambiguous suffixes)
      if (!exactMap.has(suffix)) {
        exactMap.set(suffix, original);
      }
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) {
        lowerMap.set(lower, original);
      }
    }

    // Index directory membership
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      // Build all directory suffixes
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf('.'));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
    getFilesInDir: (dirSuffix: string, extension: string) => {
      return dirMap.get(`${dirSuffix}:${extension}`) || [];
    },
  };
}

/**
 * Suffix-based resolution using index. O(1) per lookup instead of O(files).
 */
function suffixResolve(
  pathParts: string[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join('/');
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) || index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (for backward compatibility)
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(filePath =>
        filePath.endsWith(suffixPattern) || filePath.toLowerCase().endsWith(suffixPattern.toLowerCase())
      );
      if (matchIdx !== -1) {
        return allFileList[matchIdx];
      }
    }
  }
  return null;
}

/**
 * Resolve an import path to a file path in the repository.
 *
 * Language-specific preprocessing is applied before the generic resolution:
 * - TypeScript/JavaScript: rewrites tsconfig path aliases
 * - Rust: converts crate::/super::/self:: to relative paths
 *
 * Java wildcards and Go package imports are handled separately in processImports
 * because they resolve to multiple files.
 */
const resolveImportPath = (
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  language: SupportedLanguages,
  tsconfigPaths: TsconfigPaths | null,
  index?: SuffixIndex,
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    // Evict oldest 20% when cap is reached instead of clearing all
    if (resolveCache.size >= RESOLVE_CACHE_CAP) {
      const evictCount = Math.floor(RESOLVE_CACHE_CAP * 0.2);
      const iter = resolveCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) resolveCache.delete(key);
      }
    }
    resolveCache.set(cacheKey, result);
    return result;
  };

  // ---- TypeScript/JavaScript: rewrite path aliases ----
  if (
    (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) &&
    tsconfigPaths &&
    !importPath.startsWith('.')
  ) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        // Build the rewritten path relative to baseUrl
        const rewritten = tsconfigPaths.baseUrl === '.'
          ? targetPrefix + remainder
          : tsconfigPaths.baseUrl + '/' + targetPrefix + remainder;

        // Try direct resolution from repo root
        const resolved = tryResolveWithExtensions(rewritten, allFiles);
        if (resolved) return cache(resolved);

        // Try suffix matching as fallback
        const parts = rewritten.split('/').filter(Boolean);
        const suffixResult = suffixResolve(parts, normalizedFileList, allFileList, index);
        if (suffixResult) return cache(suffixResult);
      }
    }
  }

  // ---- Rust: convert module path syntax to file paths ----
  if (language === SupportedLanguages.Rust) {
    const rustResult = resolveRustImport(currentFile, importPath, allFiles);
    if (rustResult) return cache(rustResult);
    // Fall through to generic resolution if Rust-specific didn't match
  }

  // ---- Generic relative import resolution (./ and ../) ----
  const currentDir = currentFile.split('/').slice(0, -1);
  const parts = importPath.split('/');

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      currentDir.pop();
    } else {
      currentDir.push(part);
    }
  }

  const basePath = currentDir.join('/');

  if (importPath.startsWith('.')) {
    const resolved = tryResolveWithExtensions(basePath, allFiles);
    return cache(resolved);
  }

  // ---- Generic package/absolute import resolution (suffix matching) ----
  // Java wildcards are handled in processImports, not here
  if (importPath.endsWith('.*')) {
    return cache(null);
  }

  const pathLike = importPath.includes('/')
    ? importPath
    : importPath.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return cache(resolved);
};

// ============================================================================
// RUST MODULE RESOLUTION
// ============================================================================

/**
 * Resolve Rust use-path to a file.
 * Handles crate::, super::, self:: prefixes and :: path separators.
 */
function resolveRustImport(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  let rustPath: string;

  if (importPath.startsWith('crate::')) {
    // crate:: resolves from src/ directory (standard Rust layout)
    rustPath = importPath.slice(7).replace(/::/g, '/');

    // Try from src/ (standard layout)
    const fromSrc = tryRustModulePath('src/' + rustPath, allFiles);
    if (fromSrc) return fromSrc;

    // Try from repo root (non-standard)
    const fromRoot = tryRustModulePath(rustPath, allFiles);
    if (fromRoot) return fromRoot;

    return null;
  }

  if (importPath.startsWith('super::')) {
    // super:: = parent directory of current file's module
    const currentDir = currentFile.split('/').slice(0, -1);
    currentDir.pop(); // Go up one level for super::
    rustPath = importPath.slice(7).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  if (importPath.startsWith('self::')) {
    // self:: = current module's directory
    const currentDir = currentFile.split('/').slice(0, -1);
    rustPath = importPath.slice(6).replace(/::/g, '/');
    const fullPath = [...currentDir, rustPath].join('/');
    return tryRustModulePath(fullPath, allFiles);
  }

  // Bare path without prefix (e.g., from a use in a nested module)
  // Convert :: to / and try suffix matching
  if (importPath.includes('::')) {
    rustPath = importPath.replace(/::/g, '/');
    return tryRustModulePath(rustPath, allFiles);
  }

  return null;
}

/**
 * Try to resolve a Rust module path to a file.
 * Tries: path.rs, path/mod.rs, and with the last segment stripped
 * (last segment might be a symbol name, not a module).
 */
function tryRustModulePath(modulePath: string, allFiles: Set<string>): string | null {
  // Try direct: path.rs
  if (allFiles.has(modulePath + '.rs')) return modulePath + '.rs';
  // Try directory: path/mod.rs
  if (allFiles.has(modulePath + '/mod.rs')) return modulePath + '/mod.rs';
  // Try path/lib.rs (for crate root)
  if (allFiles.has(modulePath + '/lib.rs')) return modulePath + '/lib.rs';

  // The last segment might be a symbol (function, struct, etc.), not a module.
  // Strip it and try again.
  const lastSlash = modulePath.lastIndexOf('/');
  if (lastSlash > 0) {
    const parentPath = modulePath.substring(0, lastSlash);
    if (allFiles.has(parentPath + '.rs')) return parentPath + '.rs';
    if (allFiles.has(parentPath + '/mod.rs')) return parentPath + '/mod.rs';
  }

  return null;
}

/**
 * Append .* to a Kotlin import path if the AST has a wildcard_import sibling node.
 * Pure function — returns a new string without mutating the input.
 */
const appendKotlinWildcard = (importPath: string, importNode: any): string => {
  for (let i = 0; i < importNode.childCount; i++) {
    if (importNode.child(i)?.type === 'wildcard_import') {
      return importPath.endsWith('.*') ? importPath : `${importPath}.*`;
    }
  }
  return importPath;
};

// ============================================================================
// JVM MULTI-FILE RESOLUTION (Java + Kotlin)
// ============================================================================

/** Kotlin file extensions for JVM resolver reuse */
const KOTLIN_EXTENSIONS: readonly string[] = ['.kt', '.kts'];

/**
 * Resolve a JVM wildcard import (com.example.*) to all matching files.
 * Works for both Java (.java) and Kotlin (.kt, .kts).
 */
function resolveJvmWildcard(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  extensions: readonly string[],
  index?: SuffixIndex,
): string[] {
  // "com.example.util.*" -> "com/example/util"
  const packagePath = importPath.slice(0, -2).replace(/\./g, '/');

  if (index) {
    const candidates = extensions.flatMap(ext => index.getFilesInDir(packagePath, ext));
    // Filter to only direct children (no subdirectories)
    const packageSuffix = '/' + packagePath + '/';
    return candidates.filter(f => {
      const normalized = f.replace(/\\/g, '/');
      const idx = normalized.indexOf(packageSuffix);
      if (idx < 0) return false;
      const afterPkg = normalized.substring(idx + packageSuffix.length);
      return !afterPkg.includes('/');
    });
  }

  // Fallback: linear scan
  const packageSuffix = '/' + packagePath + '/';
  const matches: string[] = [];
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (normalized.includes(packageSuffix) &&
        extensions.some(ext => normalized.endsWith(ext))) {
      const afterPackage = normalized.substring(normalized.indexOf(packageSuffix) + packageSuffix.length);
      if (!afterPackage.includes('/')) {
        matches.push(allFileList[i]);
      }
    }
  }
  return matches;
}

/**
 * Try to resolve a JVM member/static import by stripping the member name.
 * Java: "com.example.Constants.VALUE" -> resolve "com.example.Constants"
 * Kotlin: "com.example.Constants.VALUE" -> resolve "com.example.Constants"
 */
function resolveJvmMemberImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  extensions: readonly string[],
  index?: SuffixIndex,
): string | null {
  // Member imports: com.example.Constants.VALUE or com.example.Constants.*
  // The last segment is a member name if it starts with lowercase, is ALL_CAPS, or is a wildcard
  const segments = importPath.split('.');
  if (segments.length < 3) return null;

  const lastSeg = segments[segments.length - 1];
  if (lastSeg === '*' || /^[a-z]/.test(lastSeg) || /^[A-Z_]+$/.test(lastSeg)) {
    const classPath = segments.slice(0, -1).join('/');

    for (const ext of extensions) {
      const classSuffix = classPath + ext;
      if (index) {
        const result = index.get(classSuffix) || index.getInsensitive(classSuffix);
        if (result) return result;
      } else {
        const fullSuffix = '/' + classSuffix;
        for (let i = 0; i < normalizedFileList.length; i++) {
          if (normalizedFileList[i].endsWith(fullSuffix) ||
              normalizedFileList[i].toLowerCase().endsWith(fullSuffix.toLowerCase())) {
            return allFileList[i];
          }
        }
      }
    }
  }

  return null;
}

// ============================================================================
// GO PACKAGE RESOLUTION
// ============================================================================

/**
 * Resolve a Go internal package import to all .go files in the package directory.
 * Returns an array of file paths.
 */
function resolveGoPackage(
  importPath: string,
  goModule: GoModuleConfig,
  normalizedFileList: string[],
  allFileList: string[],
): string[] {
  if (!importPath.startsWith(goModule.modulePath)) return [];

  // Strip module path to get relative package path
  const relativePkg = importPath.slice(goModule.modulePath.length + 1); // e.g., "internal/auth"
  if (!relativePkg) return [];

  const pkgSuffix = '/' + relativePkg + '/';
  const matches: string[] = [];

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    // File must be directly in the package directory (not a subdirectory)
    if (normalized.includes(pkgSuffix) && normalized.endsWith('.go') && !normalized.endsWith('_test.go')) {
      const afterPkg = normalized.substring(normalized.indexOf(pkgSuffix) + pkgSuffix.length);
      if (!afterPkg.includes('/')) {
        matches.push(allFileList[i]);
      }
    }
  }

  return matches;
}

// ============================================================================
// PHP PSR-4 IMPORT RESOLUTION
// ============================================================================

/**
 * Resolve a PHP use-statement import path using PSR-4 mappings.
 * e.g. "App\Http\Controllers\UserController" -> "app/Http/Controllers/UserController.php"
 */
function resolvePhpImport(
  importPath: string,
  composerConfig: ComposerConfig | null,
  allFiles: Set<string>,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Normalize: replace backslashes with forward slashes
  const normalized = importPath.replace(/\\/g, '/');

  // Try PSR-4 resolution if composer.json was found
  if (composerConfig) {
    // Sort namespaces by length descending (longest match wins)
    const sorted = [...composerConfig.psr4.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\/g, '/');
      if (normalized.startsWith(nsPrefixSlash + '/') || normalized === nsPrefixSlash) {
        const remainder = normalized.slice(nsPrefixSlash.length).replace(/^\//, '');
        const filePath = dirPrefix + (remainder ? '/' + remainder : '') + '.php';
        if (allFiles.has(filePath)) return filePath;
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return result;
        }
      }
    }
  }

  // Fallback: suffix matching (works without composer.json)
  const pathParts = normalized.split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}

// ============================================================================
// MAIN IMPORT PROCESSOR
// ============================================================================

export const processImports = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  importMap: ImportMap,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  allPaths?: string[],
) => {
  // Use allPaths (full repo) when available for cross-chunk resolution, else fall back to chunk files
  const allFileList = allPaths ?? files.map(f => f.path);
  const allFilePaths = new Set(allFileList);
  const parser = await loadParser();
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;
  const resolveCache = new Map<string, string | null>();
  // Pre-compute normalized file list once (forward slashes)
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));
  // Build suffix index for O(1) lookups
  const index = buildSuffixIndex(normalizedFileList, allFileList);

  // Track import statistics
  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  // Load language-specific configs once before the file loop
  const effectiveRoot = repoRoot || '';
  const tsconfigPaths = await loadTsconfigPaths(effectiveRoot);
  const goModule = await loadGoModulePath(effectiveRoot);
  const composerConfig = await loadComposerConfig(effectiveRoot);
  const swiftPackageConfig = await loadSwiftPackageConfig(effectiveRoot);

  // Helper: add an IMPORTS edge + update import map
  const addImportEdge = (filePath: string, resolvedPath: string) => {
    const sourceId = generateId('File', filePath);
    const targetId = generateId('File', resolvedPath);
    const relId = generateId('IMPORTS', `${filePath}->${resolvedPath}`);

    totalImportsResolved++;

    graph.addRelationship({
      id: relId,
      sourceId,
      targetId,
      type: 'IMPORTS',
      confidence: 1.0,
      reason: '',
    });

    if (!importMap.has(filePath)) {
      importMap.set(filePath, new Set());
    }
    importMap.get(filePath)!.add(resolvedPath);
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support first
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) {
      if (skippedByLang) {
        skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
      }
      continue;
    }

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);
    let wasReparsed = false;

    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
      } catch (parseError) {
        continue;
      }
      wasReparsed = true;
      // Cache re-parsed tree so call/heritage phases get hits
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const lang = parser.getLanguage();
      query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError: any) {
      if (isDev) {
        console.group(`🔴 Query Error: ${file.path}`);
        console.log('Language:', language);
        console.log('Query (first 200 chars):', queryStr.substring(0, 200) + '...');
        console.log('Error:', queryError?.message || queryError);
        console.log('File content (first 300 chars):', file.content.substring(0, 300));
        console.log('AST root type:', tree.rootNode?.type);
        console.log('AST has errors:', tree.rootNode?.hasError);
        console.groupEnd();
      }

      if (wasReparsed) (tree as any).delete?.();
      continue;
    }

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (captureMap['import']) {
        const sourceNode = captureMap['import.source'];
        if (!sourceNode) {
          if (isDev) {
            console.log(`⚠️ Import captured but no source node in ${file.path}`);
          }
          return;
        }

        // Clean path (remove quotes and angle brackets for C/C++ includes)
        const rawImportPath = language === SupportedLanguages.Kotlin
          ? appendKotlinWildcard(sourceNode.text.replace(/['"<>]/g, ''), captureMap['import'])
          : sourceNode.text.replace(/['"<>]/g, '');
        totalImportsFound++;

        // ---- JVM languages (Java + Kotlin): handle wildcards and member imports ----
        if (language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin) {
          const exts = language === SupportedLanguages.Java ? ['.java'] : KOTLIN_EXTENSIONS;

          if (rawImportPath.endsWith('.*')) {
            const matchedFiles = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, exts, index);
            // Kotlin can import Java files in mixed codebases — try .java as fallback
            if (matchedFiles.length === 0 && language === SupportedLanguages.Kotlin) {
              const javaMatches = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
              for (const matchedFile of javaMatches) {
                addImportEdge(file.path, matchedFile);
              }
              if (javaMatches.length > 0) return;
            }
            for (const matchedFile of matchedFiles) {
              addImportEdge(file.path, matchedFile);
            }
            return; // skip single-file resolution
          }

          // Try member/static import resolution (strip member name)
          let memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, exts, index);
          // Kotlin can import Java files in mixed codebases — try .java as fallback
          if (!memberResolved && language === SupportedLanguages.Kotlin) {
            memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
          }
          if (memberResolved) {
            addImportEdge(file.path, memberResolved);
            return;
          }
          // Fall through to normal resolution for regular imports
        }

        // ---- Go: handle package-level imports ----
        if (language === SupportedLanguages.Go && goModule && rawImportPath.startsWith(goModule.modulePath)) {
          const pkgFiles = resolveGoPackage(rawImportPath, goModule, normalizedFileList, allFileList);
          if (pkgFiles.length > 0) {
            for (const pkgFile of pkgFiles) {
              addImportEdge(file.path, pkgFile);
            }
            return; // skip single-file resolution
          }
          // Fall through if no files found (package might be external)
        }

        // ---- PHP: handle namespace-based imports (use statements) ----
        if (language === SupportedLanguages.PHP) {
          const resolved = resolvePhpImport(rawImportPath, composerConfig, allFilePaths, normalizedFileList, allFileList, index);
          if (resolved) {
            addImportEdge(file.path, resolved);
          }
          return;
        }

        // ---- Swift: handle module imports ----
        if (language === SupportedLanguages.Swift && swiftPackageConfig) {
          // Swift imports are module names: `import SiuperModel`
          // Resolve to the module's source directory → all .swift files in it
          const targetDir = swiftPackageConfig.targets.get(rawImportPath);
          if (targetDir) {
            // Find all .swift files in this target directory
            const dirPrefix = targetDir + '/';
            for (const filePath2 of allFileList) {
              if (filePath2.startsWith(dirPrefix) && filePath2.endsWith('.swift')) {
                addImportEdge(file.path, filePath2);
              }
            }
            return;
          }
          // External framework (Foundation, UIKit, etc.) — skip
          return;
        }

        // ---- Standard single-file resolution ----
        const resolvedPath = resolveImportPath(
          file.path,
          rawImportPath,
          allFilePaths,
          allFileList,
          normalizedFileList,
          resolveCache,
          language,
          tsconfigPaths,
          index,
        );

        if (resolvedPath) {
          addImportEdge(file.path, resolvedPath);
        }
      }
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in import processing — ${lang} parser not available.`
      );
    }
  }

  if (isDev) {
    console.log(`📊 Import processing complete: ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};

// ============================================================================
// FAST PATH: Resolve pre-extracted imports (no parsing needed)
// ============================================================================

export const processImportsFromExtracted = async (
  graph: KnowledgeGraph,
  files: { path: string }[],
  extractedImports: ExtractedImport[],
  importMap: ImportMap,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  prebuiltCtx?: ImportResolutionContext,
) => {
  const ctx = prebuiltCtx ?? buildImportResolutionContext(files.map(f => f.path));
  const { allFilePaths, allFileList, normalizedFileList, suffixIndex: index, resolveCache } = ctx;

  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  const effectiveRoot = repoRoot || '';
  const tsconfigPaths = await loadTsconfigPaths(effectiveRoot);
  const goModule = await loadGoModulePath(effectiveRoot);
  const composerConfig = await loadComposerConfig(effectiveRoot);
  const swiftPackageConfig = await loadSwiftPackageConfig(effectiveRoot);

  const addImportEdge = (filePath: string, resolvedPath: string) => {
    const sourceId = generateId('File', filePath);
    const targetId = generateId('File', resolvedPath);
    const relId = generateId('IMPORTS', `${filePath}->${resolvedPath}`);

    totalImportsResolved++;

    graph.addRelationship({
      id: relId,
      sourceId,
      targetId,
      type: 'IMPORTS',
      confidence: 1.0,
      reason: '',
    });

    if (!importMap.has(filePath)) {
      importMap.set(filePath, new Set());
    }
    importMap.get(filePath)!.add(resolvedPath);
  };

  // Group by file for progress reporting (users see file count, not import count)
  const importsByFile = new Map<string, ExtractedImport[]>();
  for (const imp of extractedImports) {
    let list = importsByFile.get(imp.filePath);
    if (!list) {
      list = [];
      importsByFile.set(imp.filePath, list);
    }
    list.push(imp);
  }

  const totalFiles = importsByFile.size;
  let filesProcessed = 0;

  // Pre-build a suffix index for O(1) suffix lookups instead of O(n) linear scans
  const suffixIndex = new Map<string, string[]>();
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    // Index by last path segment (filename) for fast suffix matching
    const lastSlash = normalized.lastIndexOf('/');
    const filename = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
    let list = suffixIndex.get(filename);
    if (!list) {
      list = [];
      suffixIndex.set(filename, list);
    }
    list.push(allFileList[i]);
  }

  for (const [filePath, fileImports] of importsByFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    for (const { rawImportPath, language } of fileImports) {
      totalImportsFound++;

      // Check resolve cache first
      const cacheKey = `${filePath}::${rawImportPath}`;
      if (resolveCache.has(cacheKey)) {
        const cached = resolveCache.get(cacheKey);
        if (cached) addImportEdge(filePath, cached);
        continue;
      }

      // JVM languages (Java + Kotlin): handle wildcards and member imports
      if (language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin) {
        const exts = language === SupportedLanguages.Java ? ['.java'] : KOTLIN_EXTENSIONS;

        if (rawImportPath.endsWith('.*')) {
          const matchedFiles = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, exts, index);
          // Kotlin can import Java files in mixed codebases — try .java as fallback
          if (matchedFiles.length === 0 && language === SupportedLanguages.Kotlin) {
            const javaMatches = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
            for (const matchedFile of javaMatches) {
              addImportEdge(filePath, matchedFile);
            }
            if (javaMatches.length > 0) continue;
          }
          for (const matchedFile of matchedFiles) {
            addImportEdge(filePath, matchedFile);
          }
          continue;
        }

        let memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, exts, index);
        // Kotlin can import Java files in mixed codebases — try .java as fallback
        if (!memberResolved && language === SupportedLanguages.Kotlin) {
          memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
        }
        if (memberResolved) {
          resolveCache.set(cacheKey, memberResolved);
          addImportEdge(filePath, memberResolved);
          continue;
        }
      }

      // Go: handle package-level imports
      if (language === SupportedLanguages.Go && goModule && rawImportPath.startsWith(goModule.modulePath)) {
        const pkgFiles = resolveGoPackage(rawImportPath, goModule, normalizedFileList, allFileList);
        if (pkgFiles.length > 0) {
          for (const pkgFile of pkgFiles) {
            addImportEdge(filePath, pkgFile);
          }
          continue;
        }
      }

      // PHP: handle namespace-based imports (use statements)
      if (language === SupportedLanguages.PHP) {
        const resolved = resolvePhpImport(rawImportPath, composerConfig, allFilePaths, normalizedFileList, allFileList, index);
        if (resolved) {
          resolveCache.set(cacheKey, resolved);
          addImportEdge(filePath, resolved);
        }
        continue;
      }

      // Swift: handle module imports
      if (language === SupportedLanguages.Swift && swiftPackageConfig) {
        const targetDir = swiftPackageConfig.targets.get(rawImportPath);
        if (targetDir) {
          const dirPrefix = targetDir + '/';
          for (const fp of allFileList) {
            if (fp.startsWith(dirPrefix) && fp.endsWith('.swift')) {
              addImportEdge(filePath, fp);
            }
          }
        }
        continue;
      }

      // Standard resolution (has its own internal cache)
      const resolvedPath = resolveImportPath(
        filePath,
        rawImportPath,
        allFilePaths,
        allFileList,
        normalizedFileList,
        resolveCache,
        language as SupportedLanguages,
        tsconfigPaths,
        index,
      );

      if (resolvedPath) {
        addImportEdge(filePath, resolvedPath);
      }
    }
  }

  onProgress?.(totalFiles, totalFiles);

  if (isDev) {
    console.log(`📊 Import processing (fast path): ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};
