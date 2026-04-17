/**
 * Markdown Processor
 *
 * Extracts structure from .md files using regex (no tree-sitter dependency).
 * Creates Section nodes for headings with hierarchy, and IMPORTS edges for
 * cross-file links.
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const MD_EXTENSIONS = new Set(['.md', '.mdx']);

interface MdFile {
  path: string;
  content: string;
}

export const processMarkdown = (
  graph: KnowledgeGraph,
  files: MdFile[],
  allPathSet: ReadonlySet<string>,
): { sections: number; links: number } => {
  let totalSections = 0;
  let totalLinks = 0;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!MD_EXTENSIONS.has(ext)) continue;

    const fileNodeId = generateId('File', file.path);
    // Skip if file node doesn't exist (shouldn't happen, structure-processor creates it)
    if (!graph.getNode(fileNodeId)) continue;

    const lines = file.content.split('\n');

    // --- Extract headings and build hierarchy ---
    // First pass: collect all heading positions so we can compute endLine spans
    const headings: { level: number; heading: string; lineNum: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(HEADING_RE);
      if (!match) continue;

      headings.push({
        level: match[1].length,
        heading: match[2].trim(),
        lineNum: i + 1, // 1-indexed
      });
    }

    // Second pass: create nodes with proper endLine spans
    const sectionStack: { level: number; id: string }[] = [];

    for (let h = 0; h < headings.length; h++) {
      const { level, heading, lineNum } = headings[h];

      // endLine = line before next heading at same or higher level, or EOF
      let endLine = lines.length;
      for (let j = h + 1; j < headings.length; j++) {
        if (headings[j].level <= level) {
          endLine = headings[j].lineNum - 1;
          break;
        }
      }

      const sectionId = generateId('Section', `${file.path}:L${lineNum}:${heading}`);

      const node: GraphNode = {
        id: sectionId,
        label: 'Section',
        properties: {
          name: heading,
          filePath: file.path,
          startLine: lineNum,
          endLine,
          level,
          description: `h${level}`,
        },
      };
      graph.addNode(node);
      totalSections++;

      // Find parent: pop stack until we find a level strictly less than current
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }

      const parentId =
        sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].id : fileNodeId;

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
    const seenLinks = new Set<string>();
    let linkMatch: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;

    while ((linkMatch = LINK_RE.exec(file.content)) !== null) {
      const href = linkMatch[2];

      // Skip external URLs, anchors, and mailto
      if (
        href.startsWith('http://') ||
        href.startsWith('https://') ||
        href.startsWith('#') ||
        href.startsWith('mailto:')
      ) {
        continue;
      }

      // Strip anchor fragments from local links
      const cleanHref = href.split('#')[0];
      if (!cleanHref) continue;

      // Resolve relative to the file's directory, then normalize
      const resolved = path.posix.normalize(path.posix.join(fileDir, cleanHref));

      if (allPathSet.has(resolved)) {
        const targetFileId = generateId('File', resolved);

        // Skip if target file node doesn't exist
        if (!graph.getNode(targetFileId)) continue;

        // Dedup: skip if we've already linked this file pair
        const linkKey = `${fileNodeId}->${targetFileId}`;
        if (seenLinks.has(linkKey)) continue;
        seenLinks.add(linkKey);

        const relId = generateId('IMPORTS', linkKey);

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
