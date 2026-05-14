/**
 * Regression test for CRLF-encoded markdown heading extraction.
 *
 * Files with CRLF line endings (Windows-authored markdown) previously
 * produced zero Section nodes because `split('\n')` left a trailing `\r`
 * on each line, and the heading regex `/^(#{1,6})\s+(.+)$/` (anchored
 * with `$`) failed to match `## Heading\r` because `$` only matches at
 * end-of-string while `.+` does not consume the trailing `\r`.
 *
 * Fix: split on `/\r\n|\r|\n/` so all line-ending conventions are
 * normalized at split time. See markdown-processor.ts line 39.
 */

import { describe, it, expect } from 'vitest';
import { processMarkdown } from '../../src/core/ingestion/markdown-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

function getMarkdownSections(graph: KnowledgeGraph, filePath: string): GraphNode[] {
  return [...graph.iterNodes()]
    .filter((n) => n.label === 'Section' && n.properties.filePath === filePath)
    .sort(
      (a, b) =>
        ((a.properties.startLine as number | undefined) ?? 0) -
        ((b.properties.startLine as number | undefined) ?? 0),
    );
}

function expectContainsEdge(graph: KnowledgeGraph, sourceId: string, targetId: string) {
  const found = [...graph.iterRelationshipsByType('CONTAINS')].some(
    (r) => r.sourceId === sourceId && r.targetId === targetId,
  );
  expect(found).toBe(true);
}

function setupGraphWithFile(filePath: string) {
  const graph = createKnowledgeGraph();
  const fileNode: GraphNode = {
    id: generateId('File', filePath),
    label: 'File',
    properties: { name: filePath, filePath },
  };
  graph.addNode(fileNode);
  return graph;
}

describe('markdown-processor CRLF tolerance', () => {
  it('extracts headings from LF-encoded markdown (baseline)', () => {
    const filePath = 'lf.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# Title\nbody line 1\n## Sub\nbody line 2\n### SubSub\nmore\n';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    expect(stats.sections).toBe(3);
    const sections = getMarkdownSections(graph, filePath);
    expect(sections.map((s) => s.properties.name)).toEqual(['Title', 'Sub', 'SubSub']);
    expect(sections.map((s) => s.properties.level)).toEqual([1, 2, 3]);
    expect(sections.map((s) => s.properties.startLine)).toEqual([1, 3, 5]);
    expect(sections.map((s) => s.properties.endLine)).toEqual([7, 7, 7]);
    for (const s of sections) {
      expect(String(s.properties.name)).not.toMatch(/\r/);
    }
    const fileId = generateId('File', filePath);
    expectContainsEdge(graph, fileId, sections[0]!.id);
    expectContainsEdge(graph, sections[0]!.id, sections[1]!.id);
    expectContainsEdge(graph, sections[1]!.id, sections[2]!.id);
  });

  it('extracts headings from CRLF-encoded markdown (the regression)', () => {
    const filePath = 'crlf.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# Title\r\nbody line 1\r\n## Sub\r\nbody line 2\r\n### SubSub\r\nmore\r\n';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    // Pre-fix: this returned 0 because `## Sub\r` failed the heading regex.
    expect(stats.sections).toBe(3);
    const sections = getMarkdownSections(graph, filePath);
    expect(sections.map((s) => s.properties.name)).toEqual(['Title', 'Sub', 'SubSub']);
    expect(sections.map((s) => s.properties.level)).toEqual([1, 2, 3]);
    expect(sections.map((s) => s.properties.startLine)).toEqual([1, 3, 5]);
    expect(sections.map((s) => s.properties.endLine)).toEqual([7, 7, 7]);
    for (const s of sections) {
      expect(String(s.properties.name)).not.toMatch(/\r/);
    }
    const fileId = generateId('File', filePath);
    expectContainsEdge(graph, fileId, sections[0]!.id);
    expectContainsEdge(graph, sections[0]!.id, sections[1]!.id);
    expectContainsEdge(graph, sections[1]!.id, sections[2]!.id);
  });

  it('extracts headings from CR-only-encoded markdown (old Mac OS Classic)', () => {
    const filePath = 'cr.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# Title\rbody line 1\r## Sub\rbody line 2\r';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    expect(stats.sections).toBe(2);
    const sections = getMarkdownSections(graph, filePath);
    expect(sections.map((s) => s.properties.name)).toEqual(['Title', 'Sub']);
    expect(sections.map((s) => s.properties.level)).toEqual([1, 2]);
    expect(sections.map((s) => s.properties.startLine)).toEqual([1, 3]);
    expect(sections.map((s) => s.properties.endLine)).toEqual([5, 5]);
    for (const s of sections) {
      expect(String(s.properties.name)).not.toMatch(/\r/);
    }
    const fileId = generateId('File', filePath);
    expectContainsEdge(graph, fileId, sections[0]!.id);
    expectContainsEdge(graph, sections[0]!.id, sections[1]!.id);
  });

  it('extracts headings from mixed CRLF + LF markdown', () => {
    const filePath = 'mixed.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# LF Title\nbody\r\n## CRLF Sub\r\nmore\n### Trailing LF\nend\n';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    expect(stats.sections).toBe(3);
    const sections = getMarkdownSections(graph, filePath);
    expect(sections.map((s) => s.properties.name)).toEqual(['LF Title', 'CRLF Sub', 'Trailing LF']);
    expect(sections.map((s) => s.properties.level)).toEqual([1, 2, 3]);
    expect(sections.map((s) => s.properties.startLine)).toEqual([1, 3, 5]);
    expect(sections.map((s) => s.properties.endLine)).toEqual([7, 7, 7]);
    for (const s of sections) {
      expect(String(s.properties.name)).not.toMatch(/\r/);
    }
    const fileId = generateId('File', filePath);
    expectContainsEdge(graph, fileId, sections[0]!.id);
    expectContainsEdge(graph, sections[0]!.id, sections[1]!.id);
    expectContainsEdge(graph, sections[1]!.id, sections[2]!.id);
  });

  it('reports correct startLine and endLine for CRLF content', () => {
    const filePath = 'crlf-lines.md';
    const graph = setupGraphWithFile(filePath);
    // Lines 1, 3, 5 are headings (1-indexed)
    const content = '# T\r\nbody\r\n## Sub\r\nmore\r\n### SubSub\r\ntail\r\n';

    processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    const sections = getMarkdownSections(graph, filePath);
    const titleSection = sections.find((s) => s.properties.name === 'T');
    const subSection = sections.find((s) => s.properties.name === 'Sub');
    const subSubSection = sections.find((s) => s.properties.name === 'SubSub');

    expect(titleSection?.properties.startLine).toBe(1);
    expect(titleSection?.properties.endLine).toBe(7);
    expect(subSection?.properties.startLine).toBe(3);
    expect(subSection?.properties.endLine).toBe(7);
    expect(subSubSection?.properties.startLine).toBe(5);
    expect(subSubSection?.properties.endLine).toBe(7);
  });
});
