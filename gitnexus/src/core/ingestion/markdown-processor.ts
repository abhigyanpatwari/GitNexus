/**
 * Markdown Processor
 *
 * Extracts structure from .md files using regex (no tree-sitter dependency).
 * Creates Section nodes for headings with hierarchy, and IMPORTS edges for
 * cross-file links.
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

interface MdFile {
  path: string;
  content: string;
}

export const processMarkdown = (
  graph: KnowledgeGraph,
  files: MdFile[],
  allPathSet: Set<string>,
): { sections: number; links: number } => {
  let totalSections = 0;
  let totalLinks = 0;

  for (const file of files) {
    if (!file.path.endsWith('.md')) continue;

    const fileNodeId = generateId('File', file.path);
    // Skip if file node doesn't exist (shouldn't happen, structure-processor creates it)
    if (!graph.getNode(fileNodeId)) continue;

    const lines = file.content.split('\n');

    // --- Extract headings and build hierarchy ---
    const sectionStack: { level: number; id: string }[] = [];
    let prevSectionLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (!match) continue;

      const level = match[1].length;
      const heading = match[2].trim();
      const lineNum = i + 1; // 1-indexed

      const sectionId = generateId('Section', `${file.path}:L${lineNum}:${heading}`);

      const node: GraphNode = {
        id: sectionId,
        label: 'Section',
        properties: {
          name: heading,
          filePath: file.path,
          startLine: lineNum,
          endLine: lineNum,
          description: `h${level}`,
        },
      };
      graph.addNode(node);
      totalSections++;

      // Find parent: pop stack until we find a level strictly less than current
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }

      const parentId = sectionStack.length > 0
        ? sectionStack[sectionStack.length - 1].id
        : fileNodeId;

      graph.addRelationship({
        id: generateId('CONTAINS', `${parentId}->${sectionId}`),
        type: 'CONTAINS',
        sourceId: parentId,
        targetId: sectionId,
        confidence: 1.0,
        reason: 'markdown-heading',
      });

      sectionStack.push({ level, id: sectionId });
    }

    // --- Extract links to other files in the repo ---
    const fileDir = path.dirname(file.path);
    let linkMatch: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;

    while ((linkMatch = LINK_RE.exec(file.content)) !== null) {
      const href = linkMatch[2];

      // Skip external URLs, anchors, and mailto
      if (href.startsWith('http://') || href.startsWith('https://') ||
          href.startsWith('#') || href.startsWith('mailto:')) {
        continue;
      }

      // Strip anchor fragments from local links
      const cleanHref = href.split('#')[0];
      if (!cleanHref) continue;

      // Resolve relative to the file's directory, then normalize
      const resolved = path.posix.normalize(path.posix.join(fileDir, cleanHref));

      if (allPathSet.has(resolved)) {
        const targetFileId = generateId('File', resolved);
        const relId = generateId('IMPORTS', `${fileNodeId}->${targetFileId}`);

        // Only add if not already present (multiple links to same file)
        if (!graph.getNode(targetFileId)) continue;

        graph.addRelationship({
          id: relId,
          type: 'IMPORTS',
          sourceId: fileNodeId,
          targetId: targetFileId,
          confidence: 0.8,
          reason: 'markdown-link',
        });
        totalLinks++;
      }
    }
  }

  return { sections: totalSections, links: totalLinks };
};
