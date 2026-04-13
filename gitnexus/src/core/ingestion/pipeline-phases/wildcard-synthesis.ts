/**
 * Wildcard import binding synthesis.
 *
 * Languages with whole-module import semantics (Go, Ruby, C/C++, Swift)
 * import all exported symbols from a file, not specific named symbols.
 * After parsing, we know which symbols each file exports (via graph
 * `isExported`), so we can expand IMPORTS edges into per-symbol bindings
 * that the cross-file propagation phase can use for type resolution.
 *
 * Also builds Python module-alias maps for namespace-import languages
 * (`import models` → `models.User()` resolves to `models.py:User`).
 *
 * @module
 */

import type { KnowledgeGraph } from '../../graph/types.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { providers, getProviderForFile } from '../languages/index.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Node labels that represent top-level importable symbols. */
const IMPORTABLE_SYMBOL_LABELS = new Set([
  'Function',
  'Class',
  'Interface',
  'Struct',
  'Enum',
  'Trait',
  'TypeAlias',
  'Const',
  'Static',
  'Record',
  'Union',
  'Typedef',
  'Macro',
]);

/** Max synthetic bindings per importing file — prevents memory bloat
 *  for C/C++ files that include many large headers. */
const MAX_SYNTHETIC_BINDINGS_PER_FILE = 1000;

/** Languages with whole-module import semantics (derived from providers at module load). */
const WILDCARD_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics === 'wildcard')
    .map((p) => p.id),
);

/** Languages that need binding synthesis before call resolution. */
const SYNTHESIS_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics !== 'named')
    .map((p) => p.id),
);

/** Check if a language uses wildcard (whole-module) import semantics. */
export function isWildcardImportLanguage(lang: SupportedLanguages): boolean {
  return WILDCARD_LANGUAGES.has(lang);
}

/** Check if a language needs synthesis before call resolution.
 *  True for wildcard-import languages AND namespace-import languages (Python). */
export function needsSynthesis(lang: SupportedLanguages): boolean {
  return SYNTHESIS_LANGUAGES.has(lang);
}

// ── Main synthesis function ────────────────────────────────────────────────

/**
 * Synthesize namedImportMap entries for languages with whole-module imports.
 *
 * For each file that imports another file via wildcard semantics:
 * 1. Look up all exported symbols from the imported file (via graph nodes)
 * 2. Create synthetic named bindings: `{ name → { sourcePath, exportedName } }`
 * 3. Build Python module-alias maps for namespace-import languages
 *
 * @param graph  The knowledge graph with parsed symbol nodes
 * @param ctx    Resolution context with importMap and namedImportMap
 * @returns      Number of synthetic bindings created
 */
export function synthesizeWildcardImportBindings(
  graph: KnowledgeGraph,
  ctx: ReturnType<typeof createResolutionContext>,
): number {
  // Build exported symbols index from graph nodes (single pass)
  const exportedSymbolsByFile = new Map<string, { name: string; filePath: string }[]>();
  graph.forEachNode((node) => {
    if (!node.properties?.isExported) return;
    if (!IMPORTABLE_SYMBOL_LABELS.has(node.label)) return;
    const fp = node.properties.filePath;
    const name = node.properties.name;
    if (!fp || !name) return;
    let symbols = exportedSymbolsByFile.get(fp);
    if (!symbols) {
      symbols = [];
      exportedSymbolsByFile.set(fp, symbols);
    }
    symbols.push({ name, filePath: fp });
  });

  if (exportedSymbolsByFile.size === 0) return 0;

  // Collect graph-level IMPORTS edges for wildcard languages missing from ctx.importMap
  const FILE_PREFIX = 'File:';
  const graphImports = new Map<string, Set<string>>();
  graph.forEachRelationship((rel) => {
    if (rel.type !== 'IMPORTS') return;
    if (!rel.sourceId.startsWith(FILE_PREFIX) || !rel.targetId.startsWith(FILE_PREFIX)) return;
    const srcFile = rel.sourceId.slice(FILE_PREFIX.length);
    const tgtFile = rel.targetId.slice(FILE_PREFIX.length);
    const lang = getLanguageFromFilename(srcFile);
    if (!lang || !isWildcardImportLanguage(lang)) return;
    if (ctx.importMap.get(srcFile)?.has(tgtFile)) return;
    let set = graphImports.get(srcFile);
    if (!set) {
      set = new Set();
      graphImports.set(srcFile, set);
    }
    set.add(tgtFile);
  });

  let totalSynthesized = 0;

  const synthesizeForFile = (filePath: string, importedFiles: Iterable<string>) => {
    let fileBindings = ctx.namedImportMap.get(filePath);
    let fileCount = fileBindings?.size ?? 0;

    for (const importedFile of importedFiles) {
      const exportedSymbols = exportedSymbolsByFile.get(importedFile);
      if (!exportedSymbols) continue;

      for (const sym of exportedSymbols) {
        if (fileCount >= MAX_SYNTHETIC_BINDINGS_PER_FILE) return;
        if (fileBindings?.has(sym.name)) continue;

        if (!fileBindings) {
          fileBindings = new Map();
          ctx.namedImportMap.set(filePath, fileBindings);
        }
        fileBindings.set(sym.name, {
          sourcePath: importedFile,
          exportedName: sym.name,
        });
        fileCount++;
        totalSynthesized++;
      }
    }
  };

  // Synthesize from ctx.importMap (Ruby, C/C++, Swift file-based imports)
  for (const [filePath, importedFiles] of ctx.importMap) {
    const lang = getLanguageFromFilename(filePath);
    if (!lang || !isWildcardImportLanguage(lang)) continue;
    synthesizeForFile(filePath, importedFiles);
  }

  // Synthesize from graph IMPORTS edges (Go and other wildcard-import languages)
  for (const [filePath, importedFiles] of graphImports) {
    synthesizeForFile(filePath, importedFiles);
  }

  // Build Python module-alias maps for namespace-import languages.
  // `import models` in app.py → moduleAliasMap['app.py']['models'] = 'models.py'
  // Enables `models.User()` to resolve without ambiguous symbol expansion.
  for (const [filePath, importedFiles] of ctx.importMap) {
    const provider = getProviderForFile(filePath);
    if (!provider || provider.importSemantics !== 'namespace') continue;
    buildPythonModuleAliasForFile(ctx, filePath, importedFiles);
  }

  return totalSynthesized;
}

/** Build module alias entries for namespace-import files (e.g. Python). */
function buildPythonModuleAliasForFile(
  ctx: ReturnType<typeof createResolutionContext>,
  callerFile: string,
  importedFiles: Iterable<string>,
): void {
  let aliasMap = ctx.moduleAliasMap.get(callerFile);
  for (const importedFile of importedFiles) {
    const lastSlash = importedFile.lastIndexOf('/');
    const base = lastSlash >= 0 ? importedFile.slice(lastSlash + 1) : importedFile;
    const dot = base.lastIndexOf('.');
    const stem = dot >= 0 ? base.slice(0, dot) : base;
    if (!stem) continue;
    if (!aliasMap) {
      aliasMap = new Map();
      ctx.moduleAliasMap.set(callerFile, aliasMap);
    }
    aliasMap.set(stem, importedFile);
  }
}
