import { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader';
import { LANGUAGE_QUERIES } from './tree-sitter-queries';
import { generateId } from '../../lib/utils';
import { SymbolTable } from './symbol-table';
import { ASTCache } from './ast-cache';
import { getLanguageFromFilename } from './utils';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

// ============================================================================
// EXPORT DETECTION - Language-specific visibility detection
// ============================================================================

/**
 * Check if a symbol (function, class, etc.) is exported/public
 * Handles all 11 supported languages with explicit logic
 * 
 * @param node - The AST node for the symbol name
 * @param name - The symbol name
 * @param language - The programming language
 * @returns true if the symbol is exported/public
 */
const isNodeExported = (node: any, name: string, language: string): boolean => {
  let current = node;
  
  switch (language) {
    // JavaScript/TypeScript: Check for export keyword in ancestors
    case 'javascript':
    case 'typescript':
      while (current) {
        const type = current.type;
        if (type === 'export_statement' || 
            type === 'export_specifier' ||
            type === 'lexical_declaration' && current.parent?.type === 'export_statement') {
          return true;
        }
        // Also check if text starts with 'export '
        if (current.text?.startsWith('export ')) {
          return true;
        }
        current = current.parent;
      }
      return false;
    
    // Python: Public if no leading underscore (convention)
    case 'python':
      return !name.startsWith('_');
    
    // Java: Check for 'public' modifier
    // In tree-sitter Java, modifiers are siblings of the name node, not parents
    case 'java':
      while (current) {
        // Check if this node or any sibling is a 'modifiers' node containing 'public'
        if (current.parent) {
          const parent = current.parent;
          // Check all children of the parent for modifiers
          for (let i = 0; i < parent.childCount; i++) {
            const child = parent.child(i);
            if (child?.type === 'modifiers' && child.text?.includes('public')) {
              return true;
            }
          }
          // Also check if the parent's text starts with 'public' (fallback)
          if (parent.type === 'method_declaration' || parent.type === 'constructor_declaration') {
            if (parent.text?.trimStart().startsWith('public')) {
              return true;
            }
          }
        }
        current = current.parent;
      }
      return false;
    
    // C#: Check for 'public' modifier in ancestors
    case 'csharp':
      while (current) {
        if (current.type === 'modifier' || current.type === 'modifiers') {
          if (current.text?.includes('public')) return true;
        }
        current = current.parent;
      }
      return false;
    
    // Go: Uppercase first letter = exported
    case 'go':
      if (name.length === 0) return false;
      const first = name[0];
      // Must be uppercase letter (not a number or symbol)
      return first === first.toUpperCase() && first !== first.toLowerCase();
    
    // Rust: Check for 'pub' visibility modifier
    case 'rust':
      while (current) {
        if (current.type === 'visibility_modifier') {
          if (current.text?.includes('pub')) return true;
        }
        current = current.parent;
      }
      return false;
    
    // C/C++: No native export concept at language level
    // Entry points will be detected via name patterns (main, etc.)
    case 'c':
    case 'cpp':
      return false;

    // Ruby: All top-level definitions are public by default
    case 'ruby':
      return true;

    // Dart: Public if no leading underscore (same convention as Python)
    case 'dart':
      return !name.startsWith('_');

    default:
      return false;
  }
};

export const processParsing = async (
  graph: KnowledgeGraph, 
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback
) => {
 
  const parser = await loadParser();
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    
    // Report progress for each file
    onFileProgress?.(i + 1, total, file.path);
    
    const language = getLanguageFromFilename(file.path);

    if (!language) continue;

    await loadLanguage(language, file.path);
    
    // 3. Parse the text content into an AST
    const tree = parser.parse(file.content);
    
    // Store in cache immediately (this might evict an old one)
    astCache.set(file.path, tree);
    
    // 4. Get the specific query string for this language
    const queryString = LANGUAGE_QUERIES[language];
    if (!queryString) {
      continue;
    }

    // 5. Run the query against the AST root node
    // This looks for patterns like (function_declaration)
    let query;
    let matches;
    try {
      query = parser.getLanguage().query(queryString);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    // 6. Process every match found
    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      
      match.captures.forEach(c => {
        captureMap[c.name] = c.node;
      });

      // Skip imports here - they are handled by import-processor.ts
      // which creates proper File -> IMPORTS -> File relationships
      if (captureMap['import']) {
        return;
      }

      // Skip call expressions - they are handled by call-processor.ts
      if (captureMap['call']) {
        return;
      }

      const nameNode = captureMap['name'];
      if (!nameNode) return;

      const nodeName = nameNode.text;
      
      let nodeLabel = 'CodeElement';
      
      // Core types
      if (captureMap['definition.function']) nodeLabel = 'Function';
      else if (captureMap['definition.class']) nodeLabel = 'Class';
      else if (captureMap['definition.interface']) nodeLabel = 'Interface';
      else if (captureMap['definition.method']) nodeLabel = 'Method';
      // Struct types (C, C++, Go, Rust, C#)
      else if (captureMap['definition.struct']) nodeLabel = 'Struct';
      // Enum types
      else if (captureMap['definition.enum']) nodeLabel = 'Enum';
      // Namespace/Module (C++, C#, Rust)
      else if (captureMap['definition.namespace']) nodeLabel = 'Namespace';
      else if (captureMap['definition.module']) nodeLabel = 'Module';
      // Rust-specific
      else if (captureMap['definition.trait']) nodeLabel = 'Trait';
      else if (captureMap['definition.impl']) nodeLabel = 'Impl';
      else if (captureMap['definition.type']) nodeLabel = 'TypeAlias';
      else if (captureMap['definition.const']) nodeLabel = 'Const';
      else if (captureMap['definition.static']) nodeLabel = 'Static';
      // C-specific
      else if (captureMap['definition.typedef']) nodeLabel = 'Typedef';
      else if (captureMap['definition.macro']) nodeLabel = 'Macro';
      else if (captureMap['definition.union']) nodeLabel = 'Union';
      // C#-specific
      else if (captureMap['definition.property']) nodeLabel = 'Property';
      else if (captureMap['definition.record']) nodeLabel = 'Record';
      else if (captureMap['definition.delegate']) nodeLabel = 'Delegate';
      // Java-specific
      else if (captureMap['definition.annotation']) nodeLabel = 'Annotation';
      else if (captureMap['definition.constructor']) nodeLabel = 'Constructor';
      // C++ template
      else if (captureMap['definition.template']) nodeLabel = 'Template';

      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);
      
      const node: GraphNode = {
        id: nodeId,
        label: nodeLabel as any,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: nameNode.startPosition.row,
          endLine: nameNode.endPosition.row,
          language: language,
          isExported: isNodeExported(nameNode, nodeName, language),
        }
      };

      graph.addNode(node);

      // Register in Symbol Table (only definitions, not imports)
      symbolTable.add(file.path, nodeName, nodeId, nodeLabel);

      const fileId = generateId('File', file.path);
      
      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
      
      const relationship: GraphRelationship = {
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      };

      graph.addRelationship(relationship);
    });
    
    // Don't delete tree here - LRU cache handles cleanup when evicted
  }
};
