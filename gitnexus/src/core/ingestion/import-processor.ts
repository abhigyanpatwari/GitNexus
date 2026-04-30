import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { getProvider, getProviderForFile, providersWithImplicitWiring } from './languages/index.js';
import type { LanguageProvider } from './language-provider.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename } from 'gitnexus-shared';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import type { ExtractedImport } from './workers/parse-worker.js';
import { getTreeSitterBufferSize } from './constants.js';
import { loadImportConfigs } from './language-config.js';
import { buildSuffixIndex } from './import-resolvers/utils.js';
import type {
  ResolutionContext,
  ModuleAliasMap,
  NamedImportMap,
} from './model/resolution-context.js';
import type {
  ImportResult,
  ResolveCtx,
  ImportResolutionContext,
} from './import-resolvers/types.js';
import type { NamedBinding } from './named-bindings/types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';
import { isDev } from './utils/env.js';
import { isRegistryPrimary } from './registry-primary-flag.js';

// Type: Map<FilePath, Set<ResolvedFilePath>>
// Stores all files that a given file imports from
export type ImportMap = Map<string, Set<string>>;

/** Group files by provider (only those with implicit import wiring), then call each wirer
 *  with its own language's files. O(n) over files, O(1) per provider lookup. */
function wireImplicitImports(
  files: string[],
  importMap: Map<string, Set<string>>,
  addImportEdge: (src: string, target: string) => void,
  projectConfig: unknown,
): void {
  if (providersWithImplicitWiring.length === 0) return;

  const grouped = new Map<LanguageProvider, string[]>();
  for (const file of files) {
    const provider = getProviderForFile(file);
    if (!provider?.implicitImportWirer) continue;
    let list = grouped.get(provider);
    if (!list) {
      list = [];
      grouped.set(provider, list);
    }
    list.push(file);
  }

  for (const [provider, langFiles] of grouped) {
    if (langFiles.length > 1) {
      provider.implicitImportWirer(langFiles, importMap, addImportEdge, projectConfig);
    }
  }
}

// Type: Map<FilePath, Set<PackageDirSuffix>>
// Stores Go package directory suffixes imported by a file (e.g., "/internal/auth/").
// Avoids expanding every Go package import into N individual ImportMap edges.
export type PackageMap = Map<string, Set<string>>;

// ImportResolutionContext is defined in ./import-resolvers/types.ts — re-exported here for consumers.

export function buildImportResolutionContext(allPaths: string[]): ImportResolutionContext {
  const allFileList = allPaths;
  const normalizedFileList = allFileList.map((p) => p.replace(/\\/g, '/'));
  const allFilePaths = new Set(allFileList);
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return { allFilePaths, allFileList, normalizedFileList, index, resolveCache: new Map() };
}

// Config loaders extracted to ./language-config.ts (Phase 2 refactor)
// Resolver types are in ./import-resolvers/types.ts; named binding types in ./named-bindings/types.ts

// ============================================================================
// Import path preprocessing
// ============================================================================

/**
 * Clean and preprocess a raw import source text into a resolved import path.
 * Strips quotes/angle brackets (universal) and applies provider-specific
 * transformations (currently only Kotlin wildcard import detection).
 */
export function preprocessImportPath(
  sourceText: string,
  importNode: SyntaxNode,
  provider: LanguageProvider,
): string | null {
  const cleaned = sourceText.replace(/['"<>]/g, '');
  // Defense-in-depth: reject null bytes and control characters (matches Ruby call-routing pattern)
  if (!cleaned || cleaned.length > 2048 || /[\x00-\x1f]/.test(cleaned)) return null;
  if (provider.importPathPreprocessor) {
    return provider.importPathPreprocessor(cleaned, importNode);
  }
  return cleaned;
}

/** Create IMPORTS edge helpers that share a resolved-count tracker. */
function createImportEdgeHelpers(graph: KnowledgeGraph, importMap: ImportMap) {
  let totalImportsResolved = 0;

  const addImportGraphEdge = (filePath: string, resolvedPath: string) => {
    const language = getLanguageFromFilename(filePath);
    if (language !== null && isRegistryPrimary(language)) return;
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
    if (!importMap.has(filePath)) importMap.set(filePath, new Set());
    importMap.get(filePath)!.add(resolvedPath);
  };

  return { addImportEdge, addImportGraphEdge, getResolvedCount: () => totalImportsResolved };
}

/**
 * Apply an ImportResult: emit graph edges and update ImportMap/PackageMap.
 * If namedBindings are provided and the import resolves to a single file,
 * also populate the NamedImportMap for precise Tier 2a resolution.
 * Bindings tagged with `isModuleAlias` are routed to moduleAliasMap instead.
 */
function applyImportResult(
  result: ImportResult,
  filePath: string,
  importMap: ImportMap,
  packageMap: PackageMap | undefined,
  addImportEdge: (from: string, to: string) => void,
  addImportGraphEdge: (from: string, to: string) => void,
  namedBindings?: NamedBinding[],
  namedImportMap?: NamedImportMap,
  moduleAliasMap?: ModuleAliasMap,
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

    // Route module aliases (import X as Y) directly to moduleAliasMap.
    // These are module-level aliases, not symbol bindings — they don't belong in namedImportMap.
    if (namedBindings && moduleAliasMap && files.length === 1) {
      const resolvedFile = files[0];
      for (const binding of namedBindings) {
        if (!binding.isModuleAlias) continue;
        let aliasMap = moduleAliasMap.get(filePath);
        if (!aliasMap) {
          aliasMap = new Map();
          moduleAliasMap.set(filePath, aliasMap);
        }
        aliasMap.set(binding.local, resolvedFile);
      }
    }

    // Record named bindings for precise Tier 2a resolution.
    // If the same local name is imported from multiple files (e.g., Java static imports
    // of overloaded methods), remove the entry so resolution falls through to Tier 2a
    // import-scoped which sees all candidates and can apply arity narrowing.
    if (namedBindings && namedImportMap) {
      if (!namedImportMap.has(filePath)) namedImportMap.set(filePath, new Map());
      const fileBindings = namedImportMap.get(filePath)!;

      if (files.length === 1) {
        const resolvedFile = files[0];
        for (const binding of namedBindings) {
          if (binding.isModuleAlias) continue; // already routed to moduleAliasMap
          const existing = fileBindings.get(binding.local);
          if (existing && existing.sourcePath !== resolvedFile) {
            fileBindings.delete(binding.local);
          } else {
            fileBindings.set(binding.local, {
              sourcePath: resolvedFile,
              exportedName: binding.exported,
            });
          }
        }
      } else {
        // Multi-file resolution (e.g., Rust `use crate::models::{User, Repo}`).
        // Match each binding to a resolved file by comparing the lowercase binding name
        // to the file's basename (without extension). If no match, skip the binding.
        for (const binding of namedBindings) {
          if (binding.isModuleAlias) continue;
          const lowerName = binding.exported.toLowerCase();
          const matchedFile = files.find((f) => {
            const base = f.replace(/\\/g, '/').split('/').pop() ?? '';
            const nameWithoutExt = base.substring(0, base.lastIndexOf('.')).toLowerCase();
            return nameWithoutExt === lowerName;
          });
          if (matchedFile) {
            const existing = fileBindings.get(binding.local);
            if (existing && existing.sourcePath !== matchedFile) {
              fileBindings.delete(binding.local);
            } else {
              fileBindings.set(binding.local, {
                sourcePath: matchedFile,
                exportedName: binding.exported,
              });
            }
          }
        }
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
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  allPaths?: string[],
) => {
  const importMap = ctx.importMap;
  const packageMap = ctx.packageMap;
  const namedImportMap = ctx.namedImportMap;
  const moduleAliasMap = ctx.moduleAliasMap;
  // Use allPaths (full repo) when available for cross-chunk resolution, else fall back to chunk files
  const allFileList = allPaths ?? files.map((f) => f.path);
  const allFilePaths = new Set(allFileList);
  const parser = await loadParser();
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;
  const resolveCache = new Map<string, string | null>();
  // Pre-compute normalized file list once (forward slashes)
  const normalizedFileList = allFileList.map((p) => p.replace(/\\/g, '/'));
  // Build suffix index for O(1) lookups
  const index = buildSuffixIndex(normalizedFileList, allFileList);

  // Track import statistics
  let totalImportsFound = 0;

  // Load language-specific configs once before the file loop
  const configs = await loadImportConfigs(repoRoot || '');
  const resolveCtx: ResolveCtx = {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index,
    resolveCache,
    configs,
  };
  const { addImportEdge, addImportGraphEdge, getResolvedCount } = createImportEdgeHelpers(
    graph,
    importMap,
  );

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

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);
    let wasReparsed = false;

    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content),
        });
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

      if (wasReparsed) (tree as unknown as { delete?: () => void }).delete?.();
      continue;
    }

    matches.forEach((match) => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => (captureMap[c.name] = c.node));

      if (captureMap['import']) {
        const sourceNode = captureMap['import.source'];
        if (!sourceNode) {
          if (isDev) {
            console.log(`⚠️ Import captured but no source node in ${file.path}`);
          }
          return;
        }

        const rawImportPath = preprocessImportPath(sourceNode.text, captureMap['import'], provider);
        if (!rawImportPath) return;
        totalImportsFound++;

        const result = provider.importResolver(rawImportPath, file.path, resolveCtx);
        const extractor = provider.namedBindingExtractor;
        const bindings = namedImportMap && extractor ? extractor(captureMap['import']) : undefined;
        applyImportResult(
          result,
          file.path,
          importMap,
          packageMap,
          addImportEdge,
          addImportGraphEdge,
          bindings,
          namedImportMap,
          moduleAliasMap,
        );
      }

      // ---- Language-specific call-as-import routing (Ruby require, etc.) ----
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const routed = provider.callRouter?.(callNameNode.text, captureMap['call']);
          if (routed && routed.kind === 'import') {
            totalImportsFound++;
            const result = provider.importResolver(routed.importPath, file.path, resolveCtx);
            applyImportResult(
              result,
              file.path,
              importMap,
              packageMap,
              addImportEdge,
              addImportGraphEdge,
            );
          }
        }
      }
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  wireImplicitImports(allFileList, importMap, addImportEdge, configs);

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in import processing — ${lang} parser not available.`,
      );
    }
  }

  if (isDev) {
    console.log(
      `📊 Import processing complete: ${getResolvedCount()}/${totalImportsFound} imports resolved to graph edges`,
    );
  }
};

// ============================================================================
// FAST PATH: Resolve pre-extracted imports (no parsing needed)
// ============================================================================

export const processImportsFromExtracted = async (
  graph: KnowledgeGraph,
  files: { path: string }[],
  extractedImports: ExtractedImport[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  repoRoot?: string,
  prebuiltCtx?: ImportResolutionContext,
) => {
  const importMap = ctx.importMap;
  const packageMap = ctx.packageMap;
  const namedImportMap = ctx.namedImportMap;
  const moduleAliasMap = ctx.moduleAliasMap;
  const importCtx = prebuiltCtx ?? buildImportResolutionContext(files.map((f) => f.path));
  const { allFilePaths, allFileList, normalizedFileList, index, resolveCache } = importCtx;

  let totalImportsFound = 0;

  const configs = await loadImportConfigs(repoRoot || '');
  const resolveCtx: ResolveCtx = {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index,
    resolveCache,
    configs,
  };
  const { addImportEdge, addImportGraphEdge, getResolvedCount } = createImportEdgeHelpers(
    graph,
    importMap,
  );

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

      const provider = getProvider(imp.language);
      const result = provider.importResolver(imp.rawImportPath, filePath, resolveCtx);
      applyImportResult(
        result,
        filePath,
        importMap,
        packageMap,
        addImportEdge,
        addImportGraphEdge,
        imp.namedBindings,
        namedImportMap,
        moduleAliasMap,
      );
    }
  }

  onProgress?.(totalFiles, totalFiles);

  wireImplicitImports(
    files.map((f) => f.path),
    importMap,
    addImportEdge,
    configs,
  );

  if (isDev) {
    console.log(
      `📊 Import processing (fast path): ${getResolvedCount()}/${totalImportsFound} imports resolved to graph edges`,
    );
  }
};
