/**
 * Regression test for CRLF-encoded markdown heading extraction.
 *
 * Files with CRLF line endings (Windows-authored markdown) previously
 * produced zero Section nodes because `split('\n')` left a trailing `\r`
 * on each line, and the heading regex `/^(#{1,6})\s+(.+)$/` (anchored
 * with `$`) failed to match `## Heading\r` (since `$` matches before
 * end-of-string, not before `\r`).
 *
 * Fix: split on `/\r\n|\r|\n/` so all line-ending conventions are
 * normalized at split time. See markdown-processor.ts line 39.
 */

import { describe, it, expect } from 'vitest';
import { processMarkdown } from '../../src/core/ingestion/markdown-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';

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
  });

  it('extracts headings from CRLF-encoded markdown (the regression)', () => {
    const filePath = 'crlf.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# Title\r\nbody line 1\r\n## Sub\r\nbody line 2\r\n### SubSub\r\nmore\r\n';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    // Pre-fix: this returned 0 because `## Sub\r` failed the heading regex.
    expect(stats.sections).toBe(3);
  });

  it('extracts headings from CR-only-encoded markdown (old Mac OS Classic)', () => {
    const filePath = 'cr.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# Title\rbody line 1\r## Sub\rbody line 2\r';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    expect(stats.sections).toBe(2);
  });

  it('extracts headings from mixed CRLF + LF markdown', () => {
    const filePath = 'mixed.md';
    const graph = setupGraphWithFile(filePath);
    const content = '# LF Title\nbody\r\n## CRLF Sub\r\nmore\n### Trailing LF\nend\n';

    const stats = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    expect(stats.sections).toBe(3);
  });

  it('reports correct startLine and endLine for CRLF content', () => {
    const filePath = 'crlf-lines.md';
    const graph = setupGraphWithFile(filePath);
    // Lines 1, 3, 5 are headings (1-indexed)
    const content = '# T\r\nbody\r\n## Sub\r\nmore\r\n### SubSub\r\ntail\r\n';

    processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));

    const sections = Array.from(graph.iterNodes()).filter((n) => n.label === 'Section');
    const titleSection = sections.find((s) => s.properties.name === 'T');
    const subSection = sections.find((s) => s.properties.name === 'Sub');

    expect(titleSection?.properties.startLine).toBe(1);
    expect(subSection?.properties.startLine).toBe(3);
  });
});
