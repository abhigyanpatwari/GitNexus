/**
 * Heritage Processor
 *
 * Extracts class inheritance relationships:
 * - EXTENDS: Class extends another Class (TS, JS, Python, C#, C++)
 * - IMPLEMENTS: Class implements an Interface (TS, C#, Java, Kotlin, PHP)
 *
 * Languages like C# use a single `base_list` for both class and interface parents.
 * We resolve the correct edge type by checking the symbol table: if the parent is
 * registered as an Interface, we emit IMPLEMENTS; otherwise EXTENDS. For unresolved
 * external symbols, the fallback heuristic is language-gated:
 *   - C# / Java: apply the `I[A-Z]` naming convention (e.g. IDisposable → IMPLEMENTS)
 *   - Swift: default to IMPLEMENTS (protocol conformance is more common than class inheritance)
 *   - All other languages: default to EXTENDS
 */

import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, type NodeLabel, type SupportedLanguages } from 'gitnexus-shared';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { getProvider } from './languages/index.js';
import { getTreeSitterBufferSize } from './constants.js';
import type {
  ExtractedHeritage,
  HeritageResolutionStrategy,
  HeritageStrategyLookup,
} from './model/heritage-map.js';
import { resolveExtendsType } from './model/heritage-map.js';
import type { ResolutionContext } from './model/resolution-context.js';
import { TIER_CONFIDENCE } from './model/resolution-context.js';
import type { HeritageInfo } from './heritage-types.js';

/**
 * Derive the heritage-resolution strategy for a language from its
 * `LanguageProvider`. This is the production wiring that `buildHeritageMap`
 * and the standalone `resolveExtendsType` call site use — the model layer
 * itself stays unaware of the provider registry.
 */
export const getHeritageStrategyForLanguage: HeritageStrategyLookup = (
  lang: SupportedLanguages,
): HeritageResolutionStrategy => {
  const provider = getProvider(lang);
  return {
    interfaceNamePattern: provider.interfaceNamePattern,
    defaultEdge: provider.heritageDefaultEdge ?? 'EXTENDS',
  };
};

/**
 * Resolve a symbol ID for heritage, with fallback to generated ID.
 * Uses ctx.resolve() → pick first candidate's nodeId → generate synthetic ID.
 */
interface ResolvedHeritage {
  readonly id: string;
  readonly confidence: number;
}

const resolveHeritageId = (
  name: string,
  filePath: string,
  ctx: ResolutionContext,
  fallbackLabel: string,
  fallbackKey?: string,
): ResolvedHeritage => {
  const resolved = ctx.resolve(name, filePath);
  if (resolved && resolved.candidates.length > 0) {
    // For global with multiple candidates, refuse (a wrong edge is worse than no edge)
    if (resolved.tier === 'global' && resolved.candidates.length > 1) {
      return {
        id: generateId(fallbackLabel, fallbackKey ?? name),
        confidence: TIER_CONFIDENCE['global'],
      };
    }
    return { id: resolved.candidates[0].nodeId, confidence: TIER_CONFIDENCE[resolved.tier] };
  }
  // Unresolved: use global-tier confidence as fallback
  return {
    id: generateId(fallbackLabel, fallbackKey ?? name),
    confidence: TIER_CONFIDENCE['global'],
  };
};

/**
 * Resolve a single HeritageInfo to a graph edge, using the same resolution
 * logic as processHeritageFromExtracted.  This bridges the heritage extractor
 * output format to the graph-resolution side.
 */
const resolveAndAddHeritageEdge = (
  graph: KnowledgeGraph,
  item: HeritageInfo,
  filePath: string,
  language: SupportedLanguages,
  ctx: ResolutionContext,
): void => {
  if (item.kind === 'extends') {
    const { type: relType, idPrefix } = resolveExtendsType(
      item.parentName,
      filePath,
      ctx,
      getHeritageStrategyForLanguage(language),
    );

    const child = resolveHeritageId(
      item.className,
      filePath,
      ctx,
      'Class',
      `${filePath}:${item.className}`,
    );
    const parent = resolveHeritageId(item.parentName, filePath, ctx, idPrefix);

    if (child.id && parent.id && child.id !== parent.id) {
      graph.addRelationship({
        id: generateId(relType, `${child.id}->${parent.id}`),
        sourceId: child.id,
        targetId: parent.id,
        type: relType,
        confidence: Math.sqrt(child.confidence * parent.confidence),
        reason: '',
      });
    }
  } else if (item.kind === 'implements') {
    const cls = resolveHeritageId(
      item.className,
      filePath,
      ctx,
      'Class',
      `${filePath}:${item.className}`,
    );
    const iface = resolveHeritageId(item.parentName, filePath, ctx, 'Interface');

    if (cls.id && iface.id) {
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${cls.id}->${iface.id}`),
        sourceId: cls.id,
        targetId: iface.id,
        type: 'IMPLEMENTS',
        confidence: Math.sqrt(cls.confidence * iface.confidence),
        reason: '',
      });
    }
  } else if (
    item.kind === 'trait-impl' ||
    item.kind === 'include' ||
    item.kind === 'extend' ||
    item.kind === 'prepend'
  ) {
    // Fallback label for an unresolved child name. Rust `trait-impl` children
    // are structs; Ruby mixin children are classes or modules (Trait). For
    // Ruby mixin kinds the common case resolves through the type registry
    // post-plan-001, so the fallback only fires for true-unresolved references
    // (e.g. mixin inside a singleton_class). `Class` is strictly better than
    // `Struct` there because it matches the label the structure phase would
    // emit for a Ruby `class` — the dominant shape. Ruby modules that fail
    // to resolve still lose their `Trait` label in the synthesized id, but
    // they fail to resolve rarely and the tradeoff is documented.
    const childFallbackLabel: NodeLabel = item.kind === 'trait-impl' ? 'Struct' : 'Class';
    const strct = resolveHeritageId(
      item.className,
      filePath,
      ctx,
      childFallbackLabel,
      `${filePath}:${item.className}`,
    );
    const trait = resolveHeritageId(item.parentName, filePath, ctx, 'Trait');

    if (strct.id && trait.id) {
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${strct.id}->${trait.id}:${item.kind}`),
        sourceId: strct.id,
        targetId: trait.id,
        type: 'IMPLEMENTS',
        confidence: Math.sqrt(strct.confidence * trait.confidence),
        reason: item.kind,
      });
    }
  }
};

export const processHeritage = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
) => {
  const parser = await loadParser();
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support
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

    // 2. Load the language
    await loadLanguage(language, file.path);

    // 3. Get AST
    let tree = astCache.get(file.path);
    if (!tree) {
      // Use larger bufferSize for files > 32KB
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      // Cache re-parsed tree for potential future use
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const treeSitterLang = parser.getLanguage();
      query = new Parser.Query(treeSitterLang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Heritage query error for ${file.path}:`, queryError);
      continue;
    }

    // 4. Process heritage matches via provider heritage extractor
    const heritageExtractor = provider.heritageExtractor;
    matches.forEach((match) => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      if (!captureMap['heritage.class']) return;
      if (!heritageExtractor) return;

      const heritageItems = heritageExtractor.extract(captureMap, {
        filePath: file.path,
        language,
      });

      for (const item of heritageItems) {
        resolveAndAddHeritageEdge(graph, item, file.path, language, ctx);
      }
    });

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in heritage processing — ${lang} parser not available.`,
      );
    }
  }
};

/**
 * Fast path: resolve pre-extracted heritage from workers.
 * No AST parsing — workers already extracted className + parentName + kind.
 */
export const processHeritageFromExtracted = async (
  graph: KnowledgeGraph,
  extractedHeritage: ExtractedHeritage[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
) => {
  const total = extractedHeritage.length;

  for (let i = 0; i < extractedHeritage.length; i++) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await yieldToEventLoop();
    }

    const h = extractedHeritage[i];

    if (h.kind === 'extends') {
      const fileLanguage = getLanguageFromFilename(h.filePath);
      if (!fileLanguage) continue;
      const { type: relType, idPrefix } = resolveExtendsType(
        h.parentName,
        h.filePath,
        ctx,
        getHeritageStrategyForLanguage(fileLanguage),
      );

      const child = resolveHeritageId(
        h.className,
        h.filePath,
        ctx,
        'Class',
        `${h.filePath}:${h.className}`,
      );
      const parent = resolveHeritageId(h.parentName, h.filePath, ctx, idPrefix);

      if (child.id && parent.id && child.id !== parent.id) {
        graph.addRelationship({
          id: generateId(relType, `${child.id}->${parent.id}`),
          sourceId: child.id,
          targetId: parent.id,
          type: relType,
          confidence: Math.sqrt(child.confidence * parent.confidence),
          reason: '',
        });
      }
    } else if (h.kind === 'implements') {
      const cls = resolveHeritageId(
        h.className,
        h.filePath,
        ctx,
        'Class',
        `${h.filePath}:${h.className}`,
      );
      const iface = resolveHeritageId(h.parentName, h.filePath, ctx, 'Interface');

      if (cls.id && iface.id) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${cls.id}->${iface.id}`),
          sourceId: cls.id,
          targetId: iface.id,
          type: 'IMPLEMENTS',
          confidence: Math.sqrt(cls.confidence * iface.confidence),
          reason: '',
        });
      }
    } else if (
      h.kind === 'trait-impl' ||
      h.kind === 'include' ||
      h.kind === 'extend' ||
      h.kind === 'prepend'
    ) {
      // See the per-item call above (processHeritageFromExtractedItem) for
      // rationale: `Class` is the correct fallback for Ruby mixin kinds,
      // `Struct` stays the Rust `trait-impl` default.
      const childFallbackLabel: NodeLabel = h.kind === 'trait-impl' ? 'Struct' : 'Class';
      const strct = resolveHeritageId(
        h.className,
        h.filePath,
        ctx,
        childFallbackLabel,
        `${h.filePath}:${h.className}`,
      );
      const trait = resolveHeritageId(h.parentName, h.filePath, ctx, 'Trait');

      if (strct.id && trait.id) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${strct.id}->${trait.id}:${h.kind}`),
          sourceId: strct.id,
          targetId: trait.id,
          type: 'IMPLEMENTS',
          confidence: Math.sqrt(strct.confidence * trait.confidence),
          reason: h.kind,
        });
      }
    }
  }

  onProgress?.(total, total);
};

/**
 * Walk source files with the same heritage captures as parse-worker, producing
 * {@link ExtractedHeritage} rows without mutating the graph. Used on the
 * sequential pipeline path so `buildHeritageMap(..., ctx)` can run before
 * `processCalls` (worker path defers calls until heritage from all chunks exists).
 *
 * This prepass extracts BOTH capture-based heritage (`@heritage.*` — extends /
 * implements / trait-impl) AND call-based heritage (`@call.name` routed through
 * `heritageExtractor.extractFromCall` — Ruby `include` / `extend` / `prepend`).
 * Without the second pass, sequential-mode `sequentialHeritageMap` would not
 * know about Ruby mixin ancestry before `processCalls` resolves calls against
 * it, silently dropping mixed-in methods from the graph. This function stays
 * read-only — `processCalls` still owns emission of heritage graph edges via
 * its `rubyHeritage` return path.
 */
export async function extractExtractedHeritageFromFiles(
  files: { path: string; content: string }[],
  astCache: ASTCache,
): Promise<ExtractedHeritage[]> {
  const parser = await loadParser();
  const out: ExtractedHeritage[] = [];

  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (!language || !isLanguageAvailable(language)) continue;

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
      } catch {
        continue;
      }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    const callBasedEnabled = !!provider.heritageExtractor?.extractFromCall;

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      if (captureMap['heritage.class']) {
        if (provider.heritageExtractor) {
          const heritageItems = provider.heritageExtractor.extract(captureMap, {
            filePath: file.path,
            language,
          });
          for (const item of heritageItems) {
            out.push({
              filePath: file.path,
              className: item.className,
              parentName: item.parentName,
              kind: item.kind,
            });
          }
        }
        continue;
      }

      // Call-based heritage (e.g. Ruby include/extend/prepend). Matches the
      // routing the worker path performs inline in parse-worker.ts — see the
      // `provider.heritageExtractor?.extractFromCall` branch there. We only
      // need call-based records here; other @call captures are consumed by
      // processCalls later in the sequential loop.
      if (callBasedEnabled && captureMap['call'] && captureMap['call.name']) {
        const calledName: string = captureMap['call.name'].text;
        const heritageItems = provider.heritageExtractor!.extractFromCall!(
          calledName,
          captureMap['call'],
          { filePath: file.path, language },
        );
        if (heritageItems) {
          for (const item of heritageItems) {
            out.push({
              filePath: file.path,
              className: item.className,
              parentName: item.parentName,
              kind: item.kind,
            });
          }
        }
      }
    }
  }

  return out;
}
