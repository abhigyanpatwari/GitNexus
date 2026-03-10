/**
 * Heritage Processor
 * 
 * Extracts class inheritance relationships:
 * - EXTENDS: Class extends another Class (TS, JS, Python)
 * - IMPLEMENTS: Class implements an Interface (TS only)
 */

import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable } from './symbol-table.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, isVerboseIngestionEnabled, yieldToEventLoop } from './utils.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedHeritage } from './workers/parse-worker.js';

export const processHeritage = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number) => void
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
    let wasReparsed = false;

    if (!tree) {
      // Use larger bufferSize for files > 32KB
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      wasReparsed = true;
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

      // EXTENDS: Class extends another Class
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className = captureMap['heritage.class'].text;
        const parentClassName = captureMap['heritage.extends'].text;

        // Resolve both class IDs
        const childId = symbolTable.lookupExact(file.path, className) ||
                        symbolTable.lookupFuzzy(className)[0]?.nodeId ||
                        generateId('Class', `${file.path}:${className}`);
        
        const parentId = symbolTable.lookupFuzzy(parentClassName)[0]?.nodeId ||
                         generateId('Class', `${parentClassName}`);

        if (childId && parentId && childId !== parentId) {
          const relId = generateId('EXTENDS', `${childId}->${parentId}`);
          
          graph.addRelationship({
            id: relId,
            sourceId: childId,
            targetId: parentId,
            type: 'EXTENDS',
            confidence: 1.0,
            reason: '',
          });
        }
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap['heritage.class'] && captureMap['heritage.implements']) {
        const className = captureMap['heritage.class'].text;
        const interfaceName = captureMap['heritage.implements'].text;

        // Resolve class and interface IDs
        const classId = symbolTable.lookupExact(file.path, className) ||
                        symbolTable.lookupFuzzy(className)[0]?.nodeId ||
                        generateId('Class', `${file.path}:${className}`);
        
        const interfaceId = symbolTable.lookupFuzzy(interfaceName)[0]?.nodeId ||
                            generateId('Interface', `${interfaceName}`);

        if (classId && interfaceId) {
          const relId = generateId('IMPLEMENTS', `${classId}->${interfaceId}`);
          
          graph.addRelationship({
            id: relId,
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

        // Resolve struct and trait IDs
        const structId = symbolTable.lookupExact(file.path, structName) ||
                         symbolTable.lookupFuzzy(structName)[0]?.nodeId ||
                         generateId('Struct', `${file.path}:${structName}`);
        
        const traitId = symbolTable.lookupFuzzy(traitName)[0]?.nodeId ||
                        generateId('Trait', `${traitName}`);

        if (structId && traitId) {
          const relId = generateId('IMPLEMENTS', `${structId}->${traitId}`);
          
          graph.addRelationship({
            id: relId,
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
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number) => void
) => {
  const total = extractedHeritage.length;

  for (let i = 0; i < extractedHeritage.length; i++) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await yieldToEventLoop();
    }

    const h = extractedHeritage[i];

    if (h.kind === 'extends') {
      const childId = symbolTable.lookupExact(h.filePath, h.className) ||
                      symbolTable.lookupFuzzy(h.className)[0]?.nodeId ||
                      generateId('Class', `${h.filePath}:${h.className}`);

      const parentId = symbolTable.lookupFuzzy(h.parentName)[0]?.nodeId ||
                       generateId('Class', `${h.parentName}`);

      if (childId && parentId && childId !== parentId) {
        graph.addRelationship({
          id: generateId('EXTENDS', `${childId}->${parentId}`),
          sourceId: childId,
          targetId: parentId,
          type: 'EXTENDS',
          confidence: 1.0,
          reason: '',
        });
      }
    } else if (h.kind === 'implements') {
      const classId = symbolTable.lookupExact(h.filePath, h.className) ||
                      symbolTable.lookupFuzzy(h.className)[0]?.nodeId ||
                      generateId('Class', `${h.filePath}:${h.className}`);

      const interfaceId = symbolTable.lookupFuzzy(h.parentName)[0]?.nodeId ||
                          generateId('Interface', `${h.parentName}`);

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
    } else if (h.kind === 'trait-impl') {
      const structId = symbolTable.lookupExact(h.filePath, h.className) ||
                       symbolTable.lookupFuzzy(h.className)[0]?.nodeId ||
                       generateId('Struct', `${h.filePath}:${h.className}`);

      const traitId = symbolTable.lookupFuzzy(h.parentName)[0]?.nodeId ||
                      generateId('Trait', `${h.parentName}`);

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
  }

  onProgress?.(total, total);
};
