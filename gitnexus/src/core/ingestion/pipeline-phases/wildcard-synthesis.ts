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
import { getLanguageFromFilename } from 'gitnexus-shared';
import type { SupportedLanguages } from 'gitnexus-shared';
import { providers, getProviderForFile } from '../languages/index.js';
import type { LanguageProvider, ImportSemantics } from '../language-provider.js';

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

/** Max files allowed in a single transitive include closure. Guards against
 *  OOM on pathological C/C++ codebases (boost, Linux kernel-style monoheaders)
 *  where a single translation unit can transitively reach many thousands of
 *  headers. When the cap is hit, BFS expansion stops early — the file still
 *  synthesizes bindings from the partial closure rather than failing. */
const MAX_TRANSITIVE_CLOSURE_SIZE = 5000;

/** Import semantics tags whose languages need synthesis of whole-module imports.
 *  `wildcard-transitive` (C/C++) and `wildcard-leaf` (Go, Ruby, Swift, Dart) are
 *  the file-based wildcard strategies. `explicit-reexport` is a scaffold tag —
 *  no provider uses it yet, but it goes through the same leaf-style synthesis
 *  path today because a re-exporter is still an importer; only the extra DAG
 *  walk to surface re-exported symbols is missing (future work). */
const WILDCARD_SEMANTICS: ReadonlySet<ImportSemantics> = new Set<ImportSemantics>([
  'wildcard-transitive',
  'wildcard-leaf',
  'explicit-reexport',
]);

/** Languages with whole-module import semantics (derived from providers at module load). */
const WILDCARD_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => WILDCARD_SEMANTICS.has(p.importSemantics))
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

// ── Strategy implementations ───────────────────────────────────────────────

/**
 * Strategy implementation for `importSemantics: 'wildcard-transitive'` (C, C++).
 *
 * Textual-include languages chain symbols through files: if `dict.c` includes
 * `server.h` and `server.h` includes `dict.h`, then `dict.c` sees symbols from
 * all three files. This helper walks the include graph (combining both the
 * ingestion-context `importMap` and the graph-level IMPORTS edges) until the
 * closure is stable.
 *
 * **Order matters.** The returned `Set` preserves iteration order (insertion
 * order). `synthesizeWildcardImportBindings` dedupes bindings by symbol name
 * on a first-seen-wins basis, so this closure's ordering determines which
 * declaration wins when multiple headers export the same name (e.g. overloaded
 * free functions like `write_audit()` vs `write_audit(const char*)` in
 * different headers). We therefore:
 *   1. Seed the closure with direct imports in declaration order (matches the
 *      order of `#include` directives in the source file).
 *   2. Use FIFO / true BFS (`queue.shift()`) for transitive expansion, so
 *      closer headers are seen before deeper ones.
 *
 * Cycle-safe: the `closure.has(file)` guard prevents infinite loops on circular
 * header includes, which are valid C/C++ when paired with `#pragma once` or
 * include guards.
 *
 * Size-bounded: the closure is capped at `MAX_TRANSITIVE_CLOSURE_SIZE` files to
 * prevent OOM on pathological codebases (e.g. boost, monoheader kernel code)
 * where one translation unit can transitively reach tens of thousands of
 * headers. Partial closures still yield useful bindings for the cluster of
 * headers closest to the importer, which is what overload resolution and
 * cross-file call resolution care about.
 *
 * Queue implementation: uses a head-index over a growing array (O(1) dequeue)
 * instead of `Array.prototype.shift()` (O(n)) so deep chains stay linear.
 */
export function expandTransitiveIncludeClosure(
  directImports: Iterable<string>,
  importMap: ReadonlyMap<string, ReadonlySet<string>>,
  graphImports: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [];
  let head = 0; // O(1) dequeue: advance the head index instead of shift()-ing.

  const tryEnqueue = (file: string): boolean => {
    if (closure.has(file)) return true;
    if (closure.size >= MAX_TRANSITIVE_CLOSURE_SIZE) return false;
    closure.add(file);
    queue.push(file);
    return true;
  };

  // Seed direct imports in declaration order (see JSDoc on order-sensitivity).
  for (const f of directImports) {
    if (!tryEnqueue(f)) break;
  }
  // True BFS for transitive reach: head-index FIFO preserves the "closer
  // headers first" ordering that overload resolution depends on.
  while (head < queue.length) {
    if (closure.size >= MAX_TRANSITIVE_CLOSURE_SIZE) break;
    const file = queue[head++]!;
    const nested = importMap.get(file);
    if (nested) {
      for (const n of nested) {
        if (!tryEnqueue(n)) break;
      }
    }
    const nestedGraph = graphImports.get(file);
    if (nestedGraph) {
      for (const n of nestedGraph) {
        if (!tryEnqueue(n)) break;
      }
    }
  }
  return closure;
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

  /**
   * Dispatch wildcard synthesis by the file's language provider strategy.
   *
   * Strategy tags (see `ImportSemantics`):
   *   - `wildcard-transitive`: expand the include closure first (C/C++ #include
   *     chains — e.g. `dict.c` → `server.h` → `dict.h` so `dictFind` resolves
   *     across header chains)
   *   - `wildcard-leaf`: synthesize from direct imports only (Go, Ruby, Swift, Dart)
   *   - `explicit-reexport`: scaffold tag; falls through to leaf behavior.
   *     TODO(#821): implement re-export DAG walk for TS `export *` / Rust
   *     `pub use`. The leaf fallthrough preserves today's TS/Rust behavior
   *     (their direct imports still synthesize correctly); only the extra
   *     re-export DAG walk for barrel-file correctness is missing.
   *   - `namespace` / `named`: no-op here (namespace handled in Loop 3 below,
   *     named needs no synthesis).
   *
   * Used by both Loop 1 (ctx.importMap) and Loop 2 (graphImports) so a future
   * transitive-import language whose edges arrive via graphImports gets closure
   * expansion consistently regardless of edge source.
   */
  const dispatchSynthesis = (
    filePath: string,
    importedFiles: ReadonlySet<string>,
    provider: LanguageProvider,
  ) => {
    switch (provider.importSemantics) {
      case 'wildcard-transitive':
        synthesizeForFile(
          filePath,
          expandTransitiveIncludeClosure(importedFiles, ctx.importMap, graphImports),
        );
        return;
      case 'wildcard-leaf':
      case 'explicit-reexport':
        synthesizeForFile(filePath, importedFiles);
        return;
      case 'namespace':
      case 'named':
        return;
      default: {
        const _exhaustive: never = provider.importSemantics;
        void _exhaustive;
      }
    }
  };

  // Loop 1: synthesize from ctx.importMap (Ruby, C/C++, Swift, Dart file-based imports).
  for (const [filePath, importedFiles] of ctx.importMap) {
    const lang = getLanguageFromFilename(filePath);
    if (!lang || !isWildcardImportLanguage(lang)) continue;
    const provider = getProviderForFile(filePath);
    if (!provider) continue;
    dispatchSynthesis(filePath, importedFiles, provider);
  }

  // Loop 2: synthesize from graph IMPORTS edges (Go and other wildcard-import
  // languages whose edges live in the graph rather than ctx.importMap).
  for (const [filePath, importedFiles] of graphImports) {
    const provider = getProviderForFile(filePath);
    if (!provider) continue;
    dispatchSynthesis(filePath, importedFiles, provider);
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
