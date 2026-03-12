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
import { extractNamedBindings } from './named-binding-extraction.js';
import type { ExtractedImport } from './workers/parse-worker.js';
import { getTreeSitterBufferSize } from './constants.js';
import {
  buildSuffixIndex,
  resolveImportPath,
  appendKotlinWildcard,
  KOTLIN_EXTENSIONS,
  resolveJvmWildcard,
  resolveJvmMemberImport,
  resolveGoPackageDir,
  resolveGoPackage,
  resolveCSharpImport,
  resolveCSharpNamespaceDir,
  resolvePhpImport,
  resolveRustImport,
} from './resolvers/index.js';
import type { 
  SuffixIndex,
  TsconfigPaths,
  GoModuleConfig,
  CSharpProjectConfig,
  ComposerConfig
} from './resolvers/index.js';

// Re-export resolver types for consumers
export type {
  SuffixIndex,
  TsconfigPaths,
  GoModuleConfig,
  CSharpProjectConfig,
  ComposerConfig
} from './resolvers/index.js';

const isDev = process.env.NODE_ENV === 'development';

// Type: Map<FilePath, Set<ResolvedFilePath>>
// Stores all files that a given file imports from
export type ImportMap = Map<string, Set<string>>;

export const createImportMap = (): ImportMap => new Map();

// Type: Map<FilePath, Set<PackageDirSuffix>>
// Stores Go package directory suffixes imported by a file (e.g., "/internal/auth/").
// Avoids expanding every Go package import into N individual ImportMap edges.
export type PackageMap = Map<string, Set<string>>;

export const createPackageMap = (): PackageMap => new Map();

// Type: Map<ImportingFilePath, Map<LocalName, {sourcePath, exportedName}>>
// Tracks which specific names a file imports from which sources (TS/Python only).
// Used to tighten Tier 2a resolution: `import { User } from './models'`
// means only `User` (not `Repo`) is visible from models.ts via this import.
// Stores both the resolved source path and the original exported name so that
// aliased imports (`import { User as U }`) can resolve U → User in the source file.
export interface NamedImportBinding { sourcePath: string; exportedName: string }
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;

export const createNamedImportMap = (): NamedImportMap => new Map();

/**
 * Check if a file path is directly inside a package directory identified by its suffix.
 * Used by the symbol resolver for Go and C# directory-level import matching.
 */
export function isFileInPackageDir(filePath: string, dirSuffix: string): boolean {
  // Prepend '/' so paths like "internal/auth/service.go" match suffix "/internal/auth/"
  const normalized = '/' + filePath.replace(/\\/g, '/');
  if (!normalized.includes(dirSuffix)) return false;
  const afterDir = normalized.substring(normalized.indexOf(dirSuffix) + dirSuffix.length);
  return !afterDir.includes('/');
}

/** Pre-built lookup structures for import resolution. Build once, reuse across chunks. */
export interface ImportResolutionContext {
  allFilePaths: Set<string>;
  allFileList: string[];
  normalizedFileList: string[];
  suffixIndex: SuffixIndex;
  resolveCache: Map<string, string | null>;
}

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


/**
 * Parse .csproj files to extract RootNamespace.
 * Scans the repo root for .csproj files and returns configs for each.
 */
async function loadCSharpProjectConfig(repoRoot: string): Promise<CSharpProjectConfig[]> {
  const configs: CSharpProjectConfig[] = [];
  // BFS scan for .csproj files up to 5 levels deep, cap at 100 dirs to avoid runaway scanning
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 5;
  const maxDirs = 100;
  let dirsScanned = 0;

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && depth < maxDepth) {
          // Skip common non-project directories
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'bin' || entry.name === 'obj') continue;
          scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        if (entry.isFile() && entry.name.endsWith('.csproj')) {
          try {
            const csprojPath = path.join(dir, entry.name);
            const content = await fs.readFile(csprojPath, 'utf-8');
            const nsMatch = content.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/);
            const rootNamespace = nsMatch
              ? nsMatch[1].trim()
              : entry.name.replace(/\.csproj$/, '');
            const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
            configs.push({ rootNamespace, projectDir });
            if (isDev) {
              console.log(`📦 Loaded C# project: ${entry.name} (namespace: ${rootNamespace}, dir: ${projectDir})`);
            }
          } catch {
            // Can't read .csproj
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }
  return configs;
}

/**
 * Resolve a C# using directive to file paths.
 * C# `using` directives import namespaces (not files), so one using can resolve
 * to multiple .cs files in a directory — similar to Go package imports.
 *
 * e.g. "MyApp.Services" -> all .cs files in "src/Services/"
 * e.g. "MyApp.Services.UserService" -> "src/Services/UserService.cs" (single file)
 *
 * Strategy:
 * 1. Strip root namespace prefix from each known .csproj project
 * 2. Convert remaining namespace to path: Dots -> /
 * 3. Try as single file first (ClassName import), then as directory (namespace import)
 *
 * Now in resolvers/csharp.ts
 */

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
// Resolver functions are in ./resolvers/ — imported above
// ============================================================================


// ============================================================================
// SHARED LANGUAGE DISPATCH
// ============================================================================

/** Bundled language-specific configs loaded once per ingestion run. */
interface LanguageConfigs {
  tsconfigPaths: TsconfigPaths | null;
  goModule: GoModuleConfig | null;
  composerConfig: ComposerConfig | null;
  swiftPackageConfig: SwiftPackageConfig | null;
  csharpConfigs: CSharpProjectConfig[];
}

/** Context for import path resolution (file lists, indexes, cache). */
interface ResolveCtx {
  allFilePaths: Set<string>;
  allFileList: string[];
  normalizedFileList: string[];
  index: SuffixIndex;
  resolveCache: Map<string, string | null>;
}

/**
 * Result of resolving an import via language-specific dispatch.
 * - 'files': resolved to one or more files → add to ImportMap
 * - 'package': resolved to a directory → add graph edges + store dirSuffix in PackageMap
 * - null: no resolution (external dependency, etc.)
 */
type ImportResult =
  | { kind: 'files'; files: string[] }
  | { kind: 'package'; files: string[]; dirSuffix: string }
  | null;

/**
 * Shared language dispatch for import resolution.
 * Used by both processImports and processImportsFromExtracted.
 */
function resolveLanguageImport(
  filePath: string,
  rawImportPath: string,
  language: SupportedLanguages,
  configs: LanguageConfigs,
  ctx: ResolveCtx,
): ImportResult {
  const { allFilePaths, allFileList, normalizedFileList, index, resolveCache } = ctx;
  const { tsconfigPaths, goModule, composerConfig, swiftPackageConfig, csharpConfigs } = configs;

  // JVM languages (Java + Kotlin): handle wildcards and member imports
  if (language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin) {
    const exts = language === SupportedLanguages.Java ? ['.java'] : KOTLIN_EXTENSIONS;

    if (rawImportPath.endsWith('.*')) {
      const matchedFiles = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, exts, index);
      if (matchedFiles.length === 0 && language === SupportedLanguages.Kotlin) {
        const javaMatches = resolveJvmWildcard(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
        if (javaMatches.length > 0) return { kind: 'files', files: javaMatches };
      }
      if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
      // Fall through to standard resolution
    } else {
      let memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, exts, index);
      if (!memberResolved && language === SupportedLanguages.Kotlin) {
        memberResolved = resolveJvmMemberImport(rawImportPath, normalizedFileList, allFileList, ['.java'], index);
      }
      if (memberResolved) return { kind: 'files', files: [memberResolved] };
      // Fall through to standard resolution
    }
  }

  // Go: handle package-level imports
  if (language === SupportedLanguages.Go && goModule && rawImportPath.startsWith(goModule.modulePath)) {
    const pkgSuffix = resolveGoPackageDir(rawImportPath, goModule);
    if (pkgSuffix) {
      const pkgFiles = resolveGoPackage(rawImportPath, goModule, normalizedFileList, allFileList);
      if (pkgFiles.length > 0) {
        return { kind: 'package', files: pkgFiles, dirSuffix: pkgSuffix };
      }
    }
    // Fall through if no files found (package might be external)
  }

  // C#: handle namespace-based imports (using directives)
  if (language === SupportedLanguages.CSharp && csharpConfigs.length > 0) {
    const resolvedFiles = resolveCSharpImport(rawImportPath, csharpConfigs, normalizedFileList, allFileList, index);
    if (resolvedFiles.length > 1) {
      const dirSuffix = resolveCSharpNamespaceDir(rawImportPath, csharpConfigs);
      if (dirSuffix) {
        return { kind: 'package', files: resolvedFiles, dirSuffix };
      }
    }
    if (resolvedFiles.length > 0) return { kind: 'files', files: resolvedFiles };
    return null;
  }

  // PHP: handle namespace-based imports (use statements)
  if (language === SupportedLanguages.PHP) {
    const resolved = resolvePhpImport(rawImportPath, composerConfig, allFilePaths, normalizedFileList, allFileList, index);
    return resolved ? { kind: 'files', files: [resolved] } : null;
  }

  // Swift: handle module imports
  if (language === SupportedLanguages.Swift && swiftPackageConfig) {
    const targetDir = swiftPackageConfig.targets.get(rawImportPath);
    if (targetDir) {
      const dirPrefix = targetDir + '/';
      const files: string[] = [];
      for (let i = 0; i < normalizedFileList.length; i++) {
        if (normalizedFileList[i].startsWith(dirPrefix) && normalizedFileList[i].endsWith('.swift')) {
          files.push(allFileList[i]);
        }
      }
      if (files.length > 0) return { kind: 'files', files };
    }
    return null; // External framework (Foundation, UIKit, etc.)
  }

  // Rust: expand top-level grouped imports: use {crate::a, crate::b}
  if (language === SupportedLanguages.Rust && rawImportPath.startsWith('{') && rawImportPath.endsWith('}')) {
    const inner = rawImportPath.slice(1, -1);
    const parts = inner.split(',').map(p => p.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveRustImport(filePath, part, allFilePaths);
      if (r) resolved.push(r);
    }
    return resolved.length > 0 ? { kind: 'files', files: resolved } : null;
  }

  // Standard single-file resolution
  const resolvedPath = resolveImportPath(
    filePath,
    rawImportPath,
    allFilePaths,
    allFileList,
    normalizedFileList,
    resolveCache,
    language,
    tsconfigPaths,
    index,
  );

  return resolvedPath ? { kind: 'files', files: [resolvedPath] } : null;
}

/**
 * Apply an ImportResult: emit graph edges and update ImportMap/PackageMap.
 * If namedBindings are provided and the import resolves to a single file,
 * also populate the NamedImportMap for precise Tier 2a resolution.
 */
function applyImportResult(
  result: ImportResult,
  filePath: string,
  importMap: ImportMap,
  packageMap: PackageMap | undefined,
  addImportEdge: (from: string, to: string) => void,
  addImportGraphEdge: (from: string, to: string) => void,
  namedBindings?: { local: string; exported: string }[],
  namedImportMap?: NamedImportMap,
): void {
  if (!result) return;

  if (result.kind === 'package' && packageMap) {
    // Store directory suffix in PackageMap (skip ImportMap expansion)
    for (const resolvedFile of result.files) {
      addImportGraphEdge(filePath, resolvedFile);
    }
    if (!packageMap.has(filePath)) packageMap.set(filePath, new Set());
    packageMap.get(filePath)!.add(result.dirSuffix);
  } else {
    // 'files' kind, or 'package' without PackageMap — use ImportMap directly
    const files = result.files;
    for (const resolvedFile of files) {
      addImportEdge(filePath, resolvedFile);
    }

    // Record named bindings for precise Tier 2a resolution
    if (namedBindings && namedImportMap && files.length === 1) {
      const resolvedFile = files[0];
      if (!namedImportMap.has(filePath)) namedImportMap.set(filePath, new Map());
      const fileBindings = namedImportMap.get(filePath)!;
      for (const binding of namedBindings) {
        fileBindings.set(binding.local, { sourcePath: resolvedFile, exportedName: binding.exported });
      }
    }
  }
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
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
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
  const configs: LanguageConfigs = {
    tsconfigPaths: await loadTsconfigPaths(effectiveRoot),
    goModule: await loadGoModulePath(effectiveRoot),
    composerConfig: await loadComposerConfig(effectiveRoot),
    swiftPackageConfig: await loadSwiftPackageConfig(effectiveRoot),
    csharpConfigs: await loadCSharpProjectConfig(effectiveRoot),
  };
  const ctx: ResolveCtx = { allFilePaths, allFileList, normalizedFileList, index, resolveCache };

  // Helper: add an IMPORTS edge to the graph only (no ImportMap update)
  const addImportGraphEdge = (filePath: string, resolvedPath: string) => {
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
  };

  // Helper: add an IMPORTS edge + update import map
  const addImportEdge = (filePath: string, resolvedPath: string) => {
    addImportGraphEdge(filePath, resolvedPath);

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
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
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

        const result = resolveLanguageImport(file.path, rawImportPath, language, configs, ctx);
        const bindings = namedImportMap ? extractNamedBindings(captureMap['import'], language) : undefined;
        applyImportResult(result, file.path, importMap, packageMap, addImportEdge, addImportGraphEdge, bindings, namedImportMap);
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
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
) => {
  const ctx = prebuiltCtx ?? buildImportResolutionContext(files.map(f => f.path));
  const { allFilePaths, allFileList, normalizedFileList, suffixIndex: index, resolveCache } = ctx;

  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  const effectiveRoot = repoRoot || '';
  const configs: LanguageConfigs = {
    tsconfigPaths: await loadTsconfigPaths(effectiveRoot),
    goModule: await loadGoModulePath(effectiveRoot),
    composerConfig: await loadComposerConfig(effectiveRoot),
    swiftPackageConfig: await loadSwiftPackageConfig(effectiveRoot),
    csharpConfigs: await loadCSharpProjectConfig(effectiveRoot),
  };
  const resolveCtx: ResolveCtx = { allFilePaths, allFileList, normalizedFileList, index, resolveCache };

  // Helper: add an IMPORTS edge to the graph only (no ImportMap update)
  const addImportGraphEdge = (filePath: string, resolvedPath: string) => {
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
  };

  const addImportEdge = (filePath: string, resolvedPath: string) => {
    addImportGraphEdge(filePath, resolvedPath);

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

  for (const [filePath, fileImports] of importsByFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    for (const imp of fileImports) {
      totalImportsFound++;

      const result = resolveLanguageImport(filePath, imp.rawImportPath, imp.language, configs, resolveCtx);
      applyImportResult(result, filePath, importMap, packageMap, addImportEdge, addImportGraphEdge, imp.namedBindings, namedImportMap);
    }
  }

  onProgress?.(totalFiles, totalFiles);

  if (isDev) {
    console.log(`📊 Import processing (fast path): ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};
