/**
 * Tests for Obsidian / Basic Memory style [[wikilink]] support in the
 * markdown processor. Wikilinks coexist with the existing [text](path.md)
 * markdown link syntax and produce the same kind of IMPORTS edge.
 *
 * Resolution rules (see markdown-processor.ts WIKILINK_RE block):
 *   - Strip `#heading` and `|alias` before path resolution
 *   - Try sibling path first (relative to source file's directory),
 *     then repo-root, with auto-suffix `.md` and `.mdx` if no extension
 *   - Skip image embeds `![[...]]`
 *   - Skip wikilinks inside fenced or inline code
 *   - Share dedup with markdown-link extraction so the same source/target
 *     pair never produces two IMPORTS edges
 */

import { describe, it, expect } from 'vitest';
import { processMarkdown } from '../../src/core/ingestion/markdown-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

function setupGraphWithFiles(filePaths: string[]): KnowledgeGraph {
  const graph = createKnowledgeGraph();
  for (const filePath of filePaths) {
    const fileNode: GraphNode = {
      id: generateId('File', filePath),
      label: 'File',
      properties: { name: filePath, filePath },
    };
    graph.addNode(fileNode);
  }
  return graph;
}

function getImports(graph: KnowledgeGraph): GraphRelationship[] {
  return [...graph.iterRelationshipsByType('IMPORTS')];
}

function hasImports(graph: KnowledgeGraph, fromPath: string, toPath: string): boolean {
  const fromId = generateId('File', fromPath);
  const toId = generateId('File', toPath);
  return getImports(graph).some((r) => r.sourceId === fromId && r.targetId === toId);
}

describe('markdown-processor markdown-link regression', () => {
  it('still resolves standard [text](path.md) markdown links', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [B](b.md) for details.' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
    const edges = getImports(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].reason).toBe('markdown-link');
  });
});

describe('markdown-processor wikilinks', () => {
  it('resolves [[id]] without extension', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b]] for details.' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
    expect(getImports(graph)[0].reason).toBe('markdown-wikilink');
  });

  it('resolves [[id.md]] with explicit extension', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b.md]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('resolves [[folder/id]] folder-relative path', () => {
    const fromPath = 'notes/a.md';
    const toPath = 'notes/sub/b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[sub/b]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('resolves [[id|alias]] (alias does not affect path)', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b|the B note]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('resolves [[id#heading]] (fragment does not affect path)', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b#some-heading]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('resolves [[id#heading|alias]] (both stripped)', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b#section|nice name]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('does not link [[nonexistent]] when no matching file exists', () => {
    const fromPath = 'a.md';
    const graph = setupGraphWithFiles([fromPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[nonexistent]].' }],
      new Set([fromPath]),
    );

    expect(stats.links).toBe(0);
    expect(getImports(graph)).toHaveLength(0);
  });

  it('skips ![[image.png]] image embeds', () => {
    const fromPath = 'a.md';
    const imagePath = 'image.png';
    // image.png is a real file in the repo but it's not markdown.
    // Even if there were a literal markdown twin, image embed should not link.
    const graph = setupGraphWithFiles([fromPath, imagePath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See ![[image.png]] embedded.' }],
      new Set([fromPath, imagePath]),
    );

    expect(stats.links).toBe(0);
    expect(getImports(graph)).toHaveLength(0);
  });

  it('does not link wikilink-shaped text inside fenced code blocks', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const content =
      'Real link: [[b]]\n' +
      '\n' +
      '```markdown\n' +
      'Inside code: [[b]] should NOT count as a separate edge.\n' +
      '```\n';

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content }],
      new Set([fromPath, toPath]),
    );

    // Only one IMPORTS edge from the real link; the in-code [[b]] should be
    // ignored. Even if it were not ignored, dedup would still cap us at 1.
    expect(stats.links).toBe(1);
    expect(getImports(graph)).toHaveLength(1);
  });

  it('does not link wikilink-shaped text inside inline code', () => {
    const fromPath = 'a.md';
    const graph = setupGraphWithFiles([fromPath, 'b.md']);

    const stats = processMarkdown(
      graph,
      [
        {
          path: fromPath,
          content: 'Use the syntax `[[b]]` to create a wikilink.',
        },
      ],
      new Set([fromPath, 'b.md']),
    );

    expect(stats.links).toBe(0);
    expect(getImports(graph)).toHaveLength(0);
  });

  it('dedups when the same target is reached by both link styles', () => {
    const fromPath = 'a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [
        {
          path: fromPath,
          content: 'See [B](b.md) and also [[b]].',
        },
      ],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    const edges = getImports(graph);
    expect(edges).toHaveLength(1);
    // First-wins: markdown-link runs before wikilink scanner.
    expect(edges[0].reason).toBe('markdown-link');
  });

  it('produces multiple IMPORTS edges for distinct wikilink targets', () => {
    const fromPath = 'a.md';
    const graph = setupGraphWithFiles([fromPath, 'b.md', 'c.md']);

    const stats = processMarkdown(
      graph,
      [
        {
          path: fromPath,
          content: 'See [[b]], [[c]], and [[b]] again.',
        },
      ],
      new Set([fromPath, 'b.md', 'c.md']),
    );

    expect(stats.links).toBe(2);
    expect(hasImports(graph, fromPath, 'b.md')).toBe(true);
    expect(hasImports(graph, fromPath, 'c.md')).toBe(true);
  });

  it('does not create self-loops', () => {
    const fromPath = 'a.md';
    const graph = setupGraphWithFiles([fromPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[a]] (myself).' }],
      new Set([fromPath]),
    );

    expect(stats.links).toBe(0);
    expect(getImports(graph)).toHaveLength(0);
  });

  it('falls back to repo-root when sibling path does not match', () => {
    // a.md lives in notes/, target is at repo root.
    const fromPath = 'notes/a.md';
    const toPath = 'b.md';
    const graph = setupGraphWithFiles([fromPath, toPath]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b]].' }],
      new Set([fromPath, toPath]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, toPath)).toBe(true);
  });

  it('prefers sibling over repo-root when both exist', () => {
    const fromPath = 'notes/a.md';
    const sibling = 'notes/b.md';
    const repoRoot = 'b.md';
    const graph = setupGraphWithFiles([fromPath, sibling, repoRoot]);

    const stats = processMarkdown(
      graph,
      [{ path: fromPath, content: 'See [[b]].' }],
      new Set([fromPath, sibling, repoRoot]),
    );

    expect(stats.links).toBe(1);
    expect(hasImports(graph, fromPath, sibling)).toBe(true);
    expect(hasImports(graph, fromPath, repoRoot)).toBe(false);
  });
});
