/**
 * Heritage Processor
 *
 * Extracts class inheritance relationships:
 * - EXTENDS: Class extends another Class (TS, JS, Python)
 * - IMPLEMENTS: Class implements an Interface (TS only)
 */

import { KnowledgeGraph } from "../graph/types";
import { ASTCache } from "./ast-cache";
import { SymbolTable } from "./symbol-table";
import { loadParser, loadLanguage } from "../tree-sitter/parser-loader";
import { LANGUAGE_QUERIES } from "./tree-sitter-queries";
import { generateId } from "../../lib/utils";
import { getLanguageFromFilename } from "./utils";

export const processHeritage = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number) => void,
) => {
  const parser = await loadParser();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);

    // 1. Check language support
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. Load the language
    await loadLanguage(language, file.path);

    // 3. Get AST
    let tree = astCache.get(file.path);
    let wasReparsed = false;

    if (!tree) {
      tree = parser.parse(file.content);
      wasReparsed = true;
    }

    let query;
    let matches;
    try {
      query = parser.getLanguage().query(queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Heritage query error for ${file.path}:`, queryError);
      if (wasReparsed) tree.delete();
      continue;
    }

    // 4. Process heritage matches
    matches.forEach((match) => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      // EXTENDS: Class extends another Class
      if (captureMap["heritage.class"] && captureMap["heritage.extends"]) {
        const className = captureMap["heritage.class"].text;
        const parentClassName = captureMap["heritage.extends"].text;

        // Resolve both class IDs
        const childId =
          symbolTable.lookupExact(file.path, className) ||
          symbolTable.lookupFuzzy(className)[0]?.nodeId ||
          generateId("Class", `${file.path}:${className}`);

        const parentId =
          symbolTable.lookupFuzzy(parentClassName)[0]?.nodeId ||
          generateId("Class", `${parentClassName}`);

        if (childId && parentId && childId !== parentId) {
          const relId = generateId("EXTENDS", `${childId}->${parentId}`);

          graph.addRelationship({
            id: relId,
            sourceId: childId,
            targetId: parentId,
            type: "EXTENDS",
            confidence: 1.0,
            reason: "",
          });
        }
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap["heritage.class"] && captureMap["heritage.implements"]) {
        const className = captureMap["heritage.class"].text;
        const interfaceName = captureMap["heritage.implements"].text;

        // Resolve class and interface IDs
        const classId =
          symbolTable.lookupExact(file.path, className) ||
          symbolTable.lookupFuzzy(className)[0]?.nodeId ||
          generateId("Class", `${file.path}:${className}`);

        const interfaceId =
          symbolTable.lookupFuzzy(interfaceName)[0]?.nodeId ||
          generateId("Interface", `${interfaceName}`);

        if (classId && interfaceId) {
          const relId = generateId("IMPLEMENTS", `${classId}->${interfaceId}`);

          graph.addRelationship({
            id: relId,
            sourceId: classId,
            targetId: interfaceId,
            type: "IMPLEMENTS",
            confidence: 1.0,
            reason: "",
          });
        }
      }

      // IMPLEMENTS (Rust): impl Trait for Struct
      if (captureMap["heritage.trait"] && captureMap["heritage.class"]) {
        const structName = captureMap["heritage.class"].text;
        const traitName = captureMap["heritage.trait"].text;

        // Resolve struct and trait IDs
        const structId =
          symbolTable.lookupExact(file.path, structName) ||
          symbolTable.lookupFuzzy(structName)[0]?.nodeId ||
          generateId("Struct", `${file.path}:${structName}`);

        const traitId =
          symbolTable.lookupFuzzy(traitName)[0]?.nodeId ||
          generateId("Trait", `${traitName}`);

        if (structId && traitId) {
          const relId = generateId("IMPLEMENTS", `${structId}->${traitId}`);

          graph.addRelationship({
            id: relId,
            sourceId: structId,
            targetId: traitId,
            type: "IMPLEMENTS",
            confidence: 1.0,
            reason: "trait-impl",
          });
        }
      }
    });

    // Cleanup
    if (wasReparsed) {
      tree.delete();
    }
  }
};
