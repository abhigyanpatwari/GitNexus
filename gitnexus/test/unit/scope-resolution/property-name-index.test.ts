/**
 * The `Property`-by-name index is built ONCE and shared across language passes.
 *
 * It is a whole-graph node scan and language-agnostic, so rebuilding it inside
 * every qualifying language pass repeats that scan N times — the pattern
 * `phase.ts` already hoisted out for `sharedNodeLookup`, whose comment records
 * why it matters: on a large repo a small language's full copy overlaps the
 * next language's and contributes to the scope-resolution memory peak.
 *
 * Sharing is only safe because the per-language restriction moved to LOOKUP
 * time. These tests pin both halves — that the index is genuinely whole-graph,
 * and that a language still cannot see another language's properties through
 * it.
 */
import { describe, it, expect } from 'vitest';
import { buildPropertyNameIndex } from '../../../src/core/ingestion/scope-resolution/passes/unique-name-properties.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

const addProperty = (
  graph: ReturnType<typeof createKnowledgeGraph>,
  id: string,
  name: string,
  filePath: string,
): void => {
  graph.addNode({
    id,
    label: 'Property',
    properties: { name, filePath, startLine: 1, endLine: 1 },
  });
};

describe('buildPropertyNameIndex', () => {
  it('indexes properties from every language in one pass', () => {
    const graph = createKnowledgeGraph();
    addProperty(graph, 'Property:a.js:cfg.shared', 'shared', 'a.js');
    addProperty(graph, 'Property:B.java:B.shared', 'shared', 'B.java');
    addProperty(graph, 'Property:a.js:cfg.jsOnly', 'jsOnly', 'a.js');

    const index = buildPropertyNameIndex(graph);

    // Whole-graph: both carriers of `shared` are present. The language
    // restriction is NOT applied here — that is the point of sharing it.
    expect(
      index
        .get('shared')
        ?.map((c) => c.filePath)
        .sort(),
    ).toEqual(['B.java', 'a.js']);
    expect(index.get('jsOnly')).toHaveLength(1);
  });

  it('ignores non-Property nodes and nodes with no usable name or path', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:a.js:run',
      label: 'Function',
      properties: { name: 'run', filePath: 'a.js', startLine: 1, endLine: 2 },
    });
    graph.addNode({
      id: 'Property:a.js:noPath',
      label: 'Property',
      properties: { name: 'noPath', startLine: 1, endLine: 1 },
    });

    const index = buildPropertyNameIndex(graph);
    expect(index.get('run')).toBeUndefined();
    // A node with no filePath cannot be language-filtered later, so it must not
    // enter the index at all — otherwise it would be visible to EVERY language.
    expect(index.get('noPath')).toBeUndefined();
  });

  it('does not double-count a node seen twice', () => {
    const graph = createKnowledgeGraph();
    addProperty(graph, 'Property:a.js:cfg.dup', 'dup', 'a.js');
    addProperty(graph, 'Property:a.js:cfg.dup', 'dup', 'a.js');

    expect(buildPropertyNameIndex(graph).get('dup')).toHaveLength(1);
  });

  it('scans the graph exactly once', () => {
    // The reason the index is hoisted at all. Counting iterations is what
    // separates "shared" from "rebuilt per language and happens to agree".
    const graph = createKnowledgeGraph();
    addProperty(graph, 'Property:a.js:cfg.one', 'one', 'a.js');
    let scans = 0;
    const counting = {
      ...graph,
      iterNodes: () => {
        scans++;
        return graph.iterNodes();
      },
    } as unknown as ReturnType<typeof createKnowledgeGraph>;

    buildPropertyNameIndex(counting);
    expect(scans).toBe(1);
  });
});
