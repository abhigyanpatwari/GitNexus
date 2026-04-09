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
import { getLanguageFromFilename } from 'gitnexus-shared';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from './languages/index.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedHeritage } from './workers/parse-worker.js';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';

/**
 * Determine whether a heritage.extends capture is actually an IMPLEMENTS relationship.
 * Uses the symbol table first (authoritative — Tier 1); falls back to provider-defined
 * heuristics for external symbols not present in the graph:
 *   - interfaceNamePattern: matched against parent name (e.g., /^I[A-Z]/ for C#/Java)
 *   - heritageDefaultEdge: 'IMPLEMENTS' causes all unresolved parents to map to IMPLEMENTS
 *   - All others: default EXTENDS
 */
/** Exported for implementor-map construction (C#/Java: `extends` rows in base_list may be interfaces). */
export const resolveExtendsType = (
  parentName: string,
  currentFilePath: string,
  ctx: ResolutionContext,
  language: SupportedLanguages,
): { type: 'EXTENDS' | 'IMPLEMENTS'; idPrefix: string } => {
  const resolved = ctx.resolve(parentName, currentFilePath);
  if (resolved && resolved.candidates.length > 0) {
    const isInterface = resolved.candidates[0].type === 'Interface';
    return isInterface
      ? { type: 'IMPLEMENTS', idPrefix: 'Interface' }
      : { type: 'EXTENDS', idPrefix: 'Class' };
  }
  // Unresolved symbol — fall back to provider-defined heuristics
  const provider = getProvider(language);
  if (provider.interfaceNamePattern?.test(parentName)) {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  if (provider.heritageDefaultEdge === 'IMPLEMENTS') {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  return { type: 'EXTENDS', idPrefix: 'Class' };
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
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Heritage query error for ${file.path}:`, queryError);
      continue;
    }

    // 4. Process heritage matches
    matches.forEach((match) => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      // EXTENDS or IMPLEMENTS: resolve via symbol table for languages where
      // the tree-sitter query can't distinguish classes from interfaces (C#, Java)
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        // Go struct embedding: skip named fields (only anonymous fields are embedded)
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name')) {
          return; // Named field, not struct embedding
        }

        const className = captureMap['heritage.class'].text;
        const parentClassName = captureMap['heritage.extends'].text;

        const { type: relType, idPrefix } = resolveExtendsType(
          parentClassName,
          file.path,
          ctx,
          language,
        );

        const child = resolveHeritageId(
          className,
          file.path,
          ctx,
          'Class',
          `${file.path}:${className}`,
        );
        const parent = resolveHeritageId(parentClassName, file.path, ctx, idPrefix);

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
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap['heritage.class'] && captureMap['heritage.implements']) {
        const className = captureMap['heritage.class'].text;
        const interfaceName = captureMap['heritage.implements'].text;

        const cls = resolveHeritageId(
          className,
          file.path,
          ctx,
          'Class',
          `${file.path}:${className}`,
        );
        const iface = resolveHeritageId(interfaceName, file.path, ctx, 'Interface');

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
      }

      // IMPLEMENTS (Rust): impl Trait for Struct
      if (captureMap['heritage.trait'] && captureMap['heritage.class']) {
        const structName = captureMap['heritage.class'].text;
        const traitName = captureMap['heritage.trait'].text;

        const strct = resolveHeritageId(
          structName,
          file.path,
          ctx,
          'Struct',
          `${file.path}:${structName}`,
        );
        const trait = resolveHeritageId(traitName, file.path, ctx, 'Trait');

        if (strct.id && trait.id) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${strct.id}->${trait.id}`),
            sourceId: strct.id,
            targetId: trait.id,
            type: 'IMPLEMENTS',
            confidence: Math.sqrt(strct.confidence * trait.confidence),
            reason: 'trait-impl',
          });
        }
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
        fileLanguage,
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
      const strct = resolveHeritageId(
        h.className,
        h.filePath,
        ctx,
        'Struct',
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

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      if (captureMap['heritage.class']) {
        if (captureMap['heritage.extends']) {
          const extendsNode = captureMap['heritage.extends'];
          const fieldDecl = extendsNode.parent;
          const isNamedField =
            fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name');
          if (!isNamedField) {
            out.push({
              filePath: file.path,
              className: captureMap['heritage.class'].text,
              parentName: captureMap['heritage.extends'].text,
              kind: 'extends',
            });
          }
        }
        if (captureMap['heritage.implements']) {
          out.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
        if (captureMap['heritage.trait']) {
          out.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait-impl',
          });
        }
      }
    }
  }

  return out;
}
