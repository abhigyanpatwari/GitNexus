/**
 * Markdown Processor (AST-Based)
 * 
 * V3 Architecture compliant parser. Extracts markdown structures using mdast.
 * Identifies headings as documentation Sections, code blocks as Pseudocode CodeElements.
 * Maintains chronological process flow via stepCounter in CALLS edges.
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root, Heading, Code, Link } from 'mdast';

const MD_EXTENSIONS = new Set(['.md', '.mdx']);

interface MdFile {
  path: string;
  content: string;
}

export interface PendingResolution {
  source: string;
  name: string;
  step: number;
  sourceContext: string;
}

export const processMarkdown = (
  graph: KnowledgeGraph,
  files: MdFile[],
  allPathSet: Set<string>,
): { sections: number; links: number; pendingResolutions: PendingResolution[] } => {
  let totalSections = 0;
  let totalLinks = 0;
  const pendingResolutions: PendingResolution[] = [];

  const processor = unified().use(remarkParse);

  // Cross-file Symbol Table: Mapping funcName -> CodeElement ID
  const docSymbolTable = new Map<string, string>();
  
  // Store code blocks globally for Step 3 pass
  const allDesignCodeBlocks: { id: string, calledSymbols: string[], filePath: string }[] = [];

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!MD_EXTENSIONS.has(ext)) continue;

    const fileNodeId = generateId('File', file.path);
    if (!graph.getNode(fileNodeId)) continue;
    
    // Update File node metadata for documentation recognition
    const fileNode = graph.getNode(fileNodeId);
    if (fileNode) {
      fileNode.properties.nodeCategory = 'documentation';
    }

    const ast = processor.parse(file.content) as Root;
    
    // Extract Headings
    const headings: { id: string, level: number, lineNum: number, endLine: number, slug: string }[] = [];
    visit(ast, 'heading', (node: Heading) => {
      if (!node.position) return;
      const textNode = node.children.find(c => c.type === 'text');
      const text = textNode && 'value' in textNode ? textNode.value : `Heading ${node.depth}`;
      const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      headings.push({
        id: generateId('Section', `${file.path}:L${node.position.start.line}:${text}`),
        level: node.depth,
        lineNum: node.position.start.line,
        endLine: file.content.split('\n').length, // Will be refined below
        slug: slug
      });
    });

    // Refine heading endlines based on hierarchy
    for (let h = 0; h < headings.length; h++) {
      for (let j = h + 1; j < headings.length; j++) {
        if (headings[j].level <= headings[h].level) {
          headings[h].endLine = headings[j].lineNum - 1;
          break;
        }
      }
    }

    // Register Heading Nodes and CONTAINS hierarchy
    const sectionStack: { level: number; id: string }[] = [];
    for (const h of headings) {
      const sectionNode: GraphNode = {
        id: h.id,
        label: 'Section',
        properties: {
          name: h.slug,
          filePath: file.path,
          startLine: h.lineNum,
          endLine: h.endLine,
          level: h.level,
          description: `h${h.level}`,
          nodeCategory: 'documentation',
          isPseudocode: false,
          docType: 'design'
        }
      };
      graph.addNode(sectionNode);
      totalSections++;

      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= h.level) {
        sectionStack.pop();
      }
      const parentId = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].id : fileNodeId;
      
      graph.addRelationship({
        id: generateId('CONTAINS', `${parentId}->${h.id}`),
        type: 'CONTAINS',
        sourceId: parentId,
        targetId: h.id,
        confidence: 1.0,
        reason: 'markdown-heading'
      });
      sectionStack.push({ level: h.level, id: h.id });
    }

    // Helper: Find enclosing heading
    const findEnclosingHeading = (line: number) => {
      let closest = null;
      for (const h of headings) {
        if (line >= h.lineNum && line <= h.endLine) {
          if (!closest || h.level > closest.level) closest = h;
        }
      }
      return closest;
    };

    // Extract Code Blocks
    visit(ast, 'code', (node: Code) => {
      if (!node.position) return;
      const startLine = node.position.start.line;
      const endLine = node.position.end.line;
      const id = generateId('CodeElement', `${file.path}:${startLine}-${endLine}`);

      const defPattern = /(?:async\s+)?(?:function|procedure|def|method)\s+(\w+)\s*\(/g;
      const callPattern = /\b(\w+)\s*\(/g;
      
      const extractAll = (text: string, regex: RegExp) => {
        const results = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (match[1]) results.push(match[1]);
        }
        return results;
      };

      const definedSymbols = extractAll(node.value, defPattern);
      let calledSymbols = extractAll(node.value, callPattern);
      
      const EXCLUDE_CALLS = new Set([
        "console", "log", "warn", "error", "parseInt", "parseFloat",
        "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Array", "Object", "Map", "Set", "Promise", "JSON",
        "Math", "Date", "String", "Number", "Boolean",
        "require", "import", "export", "typeof", "instanceof",
        "if", "else", "for", "while", "switch", "case", "return", "throw"
      ]);
      calledSymbols = calledSymbols.filter(s => !EXCLUDE_CALLS.has(s) && !definedSymbols.includes(s));

      const codeNode: GraphNode = {
        id,
        label: 'CodeElement',
        properties: {
          name: definedSymbols.length > 0 ? definedSymbols[0] : 'anonymous_block',
          filePath: file.path,
          startLine,
          endLine,
          isExported: false,
          content: '',
          description: node.lang ? `lang:${node.lang}` : 'pseudocode block',
          nodeCategory: 'documentation',
          isPseudocode: true,
          rawContent: node.value,
          definedSymbols,
          calledSymbols,
          docType: 'design'
        }
      };
      graph.addNode(codeNode);

      // §1.2.1 CONTAINS Rule (Design -> Pseudocode)
      const parentHeading = findEnclosingHeading(startLine);
      const parentId = parentHeading ? parentHeading.id : fileNodeId;
      
      graph.addRelationship({
        id: generateId('CONTAINS', `${parentId}->${id}`),
        type: 'CONTAINS',
        sourceId: parentId,
        targetId: id,
        confidence: 0.98,
        reason: 'structural-containment'
      });

      // Build Document Symbol Table Map
      for (const funcName of definedSymbols) {
        docSymbolTable.set(funcName, id);
      }
      
      allDesignCodeBlocks.push({ id, calledSymbols, filePath: file.path });
    });

    // §1.2.2 IMPORTS Rule (Design -> Design)
    visit(ast, 'link', (node: Link) => {
      // Find what section contains this link
      if (!node.position) return;
      const enclosingHeading = findEnclosingHeading(node.position.start.line);
      const sourceId = enclosingHeading ? enclosingHeading.id : fileNodeId;

      if (node.url.endsWith('.md') || node.url.includes('.md#')) {
        const cleanHref = node.url.split('#')[0];
        const targetAnchor = node.url.split('#')[1];
        
        if (cleanHref) {
           const fileDir = path.dirname(file.path);
           const resolved = path.posix.normalize(path.posix.join(fileDir, cleanHref));
           if (allPathSet.has(resolved)) {
             const targetFileId = generateId('File', resolved);
             // Cannot resolve perfect sibling section now because other file may not be parsed yet.
             // Standard implementation points IMPORTS to target file ID as a baseline.
             graph.addRelationship({
                id: generateId('IMPORTS', `${sourceId}->${targetFileId}`),
                type: 'IMPORTS',
                sourceId,
                targetId: targetFileId,
                confidence: targetAnchor ? 0.95 : 0.85,
                reason: 'markdown-link'
             });
             totalLinks++;
           }
        }
      }
    });
  }

  // §1.2.3 CALLS Edge Rule (Pseudocode -> Pseudocode Chronology Tracking)
  for (const B of allDesignCodeBlocks) {
    let stepCounter = 1; // Required for GitNexus Native Process Tracing
    for (const callName of B.calledSymbols) {
      if (docSymbolTable.has(callName)) {
        const target = docSymbolTable.get(callName)!;
        if (target !== B.id) { // No self-loops
          graph.addRelationship({
            id: generateId('CALLS', `${B.id}->${target}`),
            type: 'CALLS',
            sourceId: B.id,
            targetId: target,
            confidence: 0.90,
            reason: 'pseudocode-call',
            step: stepCounter++
          });
        }
      } else {
        // Unresolved -> Schedule for §1.2.4 IMPLEMENTS mapping
        pendingResolutions.push({
          source: B.id,
          name: callName,
          step: stepCounter++,
          sourceContext: B.filePath
        });
      }
    }
  }

  return { sections: totalSections, links: totalLinks, pendingResolutions };
};
