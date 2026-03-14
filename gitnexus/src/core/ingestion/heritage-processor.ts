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
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, isVerboseIngestionEnabled, yieldToEventLoop } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedHeritage } from './workers/parse-worker.js';
import type { ResolutionContext } from './resolution-context.js';

/** C#/Java convention: interfaces start with I followed by an uppercase letter */
const INTERFACE_NAME_RE = /^I[A-Z]/;

/**
 * Determine whether a heritage.extends capture is actually an IMPLEMENTS relationship.
 * Uses the symbol table first (authoritative — Tier 1); falls back to a language-gated
 * heuristic for external symbols not present in the graph:
 *   - C# / Java: `I[A-Z]` naming convention
 *   - Swift: default IMPLEMENTS (protocol conformance is the norm)
 *   - All others: default EXTENDS
 */
const resolveExtendsType = (
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
  // Unresolved symbol — fall back to language-specific heuristic
  if (language === SupportedLanguages.CSharp || language === SupportedLanguages.Java) {
    if (INTERFACE_NAME_RE.test(parentName)) {
      return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
    }
  } else if (language === SupportedLanguages.Swift) {
    // Protocol conformance is far more common than class inheritance in Swift
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  return { type: 'EXTENDS', idPrefix: 'Class' };
};

/**
 * Resolve a symbol ID for heritage, with fallback to generated ID.
 * Uses ctx.resolve() → pick first candidate's nodeId → generate synthetic ID.
 */
const resolveHeritageId = (
  name: string,
  filePath: string,
  ctx: ResolutionContext,
  fallbackLabel: string,
  fallbackKey?: string,
): string => {
  const resolved = ctx.resolve(name, filePath);
  if (resolved && resolved.candidates.length > 0) {
    // For global with multiple candidates, refuse (a wrong edge is worse than no edge)
    if (resolved.tier === 'global' && resolved.candidates.length > 1) {
      return generateId(fallbackLabel, fallbackKey ?? name);
    }
    return resolved.candidates[0].nodeId;
  }
  return generateId(fallbackLabel, fallbackKey ?? name);
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

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. Load the language
    await loadLanguage(language, file.path);

    // 3. Get AST
    let tree = astCache.get(file.path);
    if (!tree) {
      // Use larger bufferSize for files > 32KB
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
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
    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => {
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

        const { type: relType, idPrefix } = resolveExtendsType(parentClassName, file.path, ctx, language);

        const childId = resolveHeritageId(className, file.path, ctx, 'Class', `${file.path}:${className}`);
        const parentId = resolveHeritageId(parentClassName, file.path, ctx, idPrefix);

        if (childId && parentId && childId !== parentId) {
          graph.addRelationship({
            id: generateId(relType, `${childId}->${parentId}`),
            sourceId: childId,
            targetId: parentId,
            type: relType,
            confidence: 1.0,
            reason: '',
          });
        }
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap['heritage.class'] && captureMap['heritage.implements']) {
        const className = captureMap['heritage.class'].text;
        const interfaceName = captureMap['heritage.implements'].text;

        const classId = resolveHeritageId(className, file.path, ctx, 'Class', `${file.path}:${className}`);
        const interfaceId = resolveHeritageId(interfaceName, file.path, ctx, 'Interface');

        if (classId && interfaceId) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${classId}->${interfaceId}`),
            sourceId: classId,
            targetId: interfaceId,
            type: 'IMPLEMENTS',
            confidence: 1.0,
            reason: '',
          });
        }
      }

      // IMPLEMENTS (Rust): impl Trait for Struct
      if (captureMap['heritage.trait'] && captureMap['heritage.class']) {
        const structName = captureMap['heritage.class'].text;
        const traitName = captureMap['heritage.trait'].text;

        const structId = resolveHeritageId(structName, file.path, ctx, 'Struct', `${file.path}:${structName}`);
        const traitId = resolveHeritageId(traitName, file.path, ctx, 'Trait');

        if (structId && traitId) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${structId}->${traitId}`),
            sourceId: structId,
            targetId: traitId,
            type: 'IMPLEMENTS',
            confidence: 1.0,
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
        `[ingestion] Skipped ${count} ${lang} file(s) in heritage processing — ${lang} parser not available.`
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
      const { type: relType, idPrefix } = resolveExtendsType(h.parentName, h.filePath, ctx, fileLanguage);

      const childId = resolveHeritageId(h.className, h.filePath, ctx, 'Class', `${h.filePath}:${h.className}`);
      const parentId = resolveHeritageId(h.parentName, h.filePath, ctx, idPrefix);

      if (childId && parentId && childId !== parentId) {
        graph.addRelationship({
          id: generateId(relType, `${childId}->${parentId}`),
          sourceId: childId,
          targetId: parentId,
          type: relType,
          confidence: 1.0,
          reason: '',
        });
      }
    } else if (h.kind === 'implements') {
      const classId = resolveHeritageId(h.className, h.filePath, ctx, 'Class', `${h.filePath}:${h.className}`);
      const interfaceId = resolveHeritageId(h.parentName, h.filePath, ctx, 'Interface');

      if (classId && interfaceId) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${classId}->${interfaceId}`),
          sourceId: classId,
          targetId: interfaceId,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: '',
        });
      }
    } else if (h.kind === 'trait-impl' || h.kind === 'include' || h.kind === 'extend' || h.kind === 'prepend') {
      const structId = resolveHeritageId(h.className, h.filePath, ctx, 'Struct', `${h.filePath}:${h.className}`);
      const traitId = resolveHeritageId(h.parentName, h.filePath, ctx, 'Trait');

      if (structId && traitId) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${structId}->${traitId}:${h.kind}`),
          sourceId: structId,
          targetId: traitId,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: h.kind,
        });
      }
    }
  }

  onProgress?.(total, total);
};
