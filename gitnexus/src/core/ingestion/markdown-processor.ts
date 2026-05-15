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
// Obsidian / Basic Memory style wikilink:
//   [[id]]              — bare target
//   [[id.md]]           — explicit extension
//   [[folder/id]]       — relative path
//   [[id#heading]]      — heading anchor (stripped before path resolution)
//   [[id|alias]]        — alias (alias text ignored for path resolution)
//
// The leading `(?<!!)` excludes image-style embeds `![[image.png]]`.
// The target is captured up to the first `#`, `|`, or `]`, so trailing
// fragments and aliases never bleed into the resolved path.
const WIKILINK_RE = /(?<!!)\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|[^\]\r\n]*)?\]\]/g;
// Strip fenced code blocks (``` ... ``` and ~~~ ... ~~~) and inline code spans
// before scanning for wikilinks so that snippets like `[[fake]]` inside a
// code block don't produce spurious IMPORTS edges.
const FENCED_CODE_RE = /(^|\n)([ \t]*)(```|~~~)[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`\r\n]*`/g;
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

    // Normalize CRLF/CR to LF before splitting so that line-end agnostic
    // markdown files (Windows-authored, mixed) yield correct headings.
    // Without this, splitting on `\n` alone leaves `## Heading\r` on each line;
    // `$` in HEADING_RE only matches at end-of-string, while `.+` stops before
    // the trailing `\r`, so the line never matches as a heading.
    const lines = file.content.split(/\r\n|\r|\n/);

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

    // --- Extract Obsidian / Basic Memory wikilinks ---
    // Strip code (fenced + inline) before scanning so `[[x]]` inside code
    // doesn't produce edges. Replace with same-length whitespace-equivalent
    // content (newlines preserved) is unnecessary because we no longer use
    // offsets here; we just need a sanitized scan target.
    const sanitized = file.content
      .replace(FENCED_CODE_RE, (m) => m.replace(/[^\n]/g, ' '))
      .replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length));

    let wm: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((wm = WIKILINK_RE.exec(sanitized)) !== null) {
      const rawTarget = wm[1].trim();
      if (!rawTarget) continue;

      // Defense in depth: the regex already drops `#heading` and `|alias`,
      // but normalize again in case the target itself contained one.
      const cleanTarget = rawTarget.split('#')[0].split('|')[0].trim();
      if (!cleanTarget) continue;

      const hasMdExt = cleanTarget.endsWith('.md') || cleanTarget.endsWith('.mdx');

      // Resolution order: original path, sibling .md/.mdx, then repo-root .md/.mdx.
      // path.posix.normalize collapses any `..`/redundant separators.
      const candidates: string[] = [];
      const push = (p: string) => {
        if (!p) return;
        const norm = path.posix.normalize(p);
        if (!candidates.includes(norm)) candidates.push(norm);
      };

      // Sibling-first (relative to current file's directory)
      push(path.posix.join(fileDir, cleanTarget));
      if (!hasMdExt) {
        push(path.posix.join(fileDir, `${cleanTarget}.md`));
        push(path.posix.join(fileDir, `${cleanTarget}.mdx`));
      }
      // Repo-root fallback (treats target as a path from repo root)
      push(cleanTarget);
      if (!hasMdExt) {
        push(`${cleanTarget}.md`);
        push(`${cleanTarget}.mdx`);
      }

      const resolvedWiki = candidates.find((c) => allPathSet.has(c));
      if (!resolvedWiki) continue;

      const targetFileId = generateId('File', resolvedWiki);
      if (!graph.getNode(targetFileId)) continue;

      // Don't create self-loops
      if (targetFileId === fileNodeId) continue;

      const linkKey = `${fileNodeId}->${targetFileId}`;
      if (seenLinks.has(linkKey)) continue;
      seenLinks.add(linkKey);

      graph.addRelationship({
        id: generateId('IMPORTS', linkKey),
        type: 'IMPORTS',
        sourceId: fileNodeId,
        targetId: targetFileId,
        confidence: 0.8,
        reason: 'markdown-wikilink',
      });
      totalLinks++;
    }
  }

  return { sections: totalSections, links: totalLinks };
};
