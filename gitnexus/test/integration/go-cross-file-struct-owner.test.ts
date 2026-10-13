/**
 * Regression test for #3558: Go methods declared in a file OTHER than the one
 * declaring their receiver struct must still get HAS_METHOD edges to the
 * struct node keyed by the DECLARING file.
 *
 * Before the fix, `findEnclosingClassInfo` minted the owner id from the
 * method's own file (`Struct:methods.go:Widget`), while the Struct node lives
 * at `Struct:decl.go:Widget` — the edge dangled and was silently dropped at
 * COPY into LadybugDB.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { runPipelineFromRepo } from './resolvers/helpers.js';
import { reconcileGoStructOwnerEdges } from '../../src/core/ingestion/languages/go/struct-owner-reconcile.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

function createGoRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-cross-file-struct-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/pkgtest\n\ngo 1.22\n');
  // Struct declared here.
  fs.writeFileSync(
    path.join(dir, 'decl.go'),
    [
      'package pkgtest',
      '',
      'type Widget struct {',
      '\tName string',
      '}',
      '',
      '// Same-file method: worked before the fix (baseline).',
      'func (w *Widget) Describe() string { return w.Name }',
      '',
    ].join('\n'),
  );
  // Methods on the same struct, DIFFERENT file, same package: dangled before.
  fs.writeFileSync(
    path.join(dir, 'methods.go'),
    [
      'package pkgtest',
      '',
      'func (w *Widget) Rename(n string) { w.Name = n }',
      '',
      'func (w *Widget) Clone() *Widget { return &Widget{Name: w.Name} }',
      '',
    ].join('\n'),
  );
  return dir;
}

function hasMethodEdgeFrom(
  graph: {
    iterRelationshipsByType(t: string): IterableIterator<{ sourceId: string; targetId: string }>;
  },
  structNodeId: string,
): string[] {
  const methods: string[] = [];
  for (const rel of graph.iterRelationshipsByType('HAS_METHOD')) {
    if (rel.sourceId === structNodeId) methods.push(rel.targetId);
  }
  return methods;
}

describe('Go cross-file struct method ownership (#3558)', () => {
  it('attaches methods from sibling files to the struct node of the declaring file', async () => {
    const repo = createGoRepo();
    try {
      const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });

      const widgetNode = [...result.graph.iterNodes()].find(
        (n) => n.label === 'Struct' && n.properties.name === 'Widget',
      );
      expect(widgetNode).toBeDefined();
      // Sanity: the struct node is keyed by the file that DECLARES it.
      expect(widgetNode!.properties.filePath).toContain('decl.go');

      const methodTargets = hasMethodEdgeFrom(result.graph, widgetNode!.id);
      // All three methods own edges: the same-file one AND the two from
      // methods.go (Rename value-receiver-less pointer receiver, Clone).
      expect(methodTargets.length).toBe(3);
      expect(methodTargets.some((id) => id.includes('Describe'))).toBe(true);
      expect(methodTargets.some((id) => id.includes('Rename'))).toBe(true);
      expect(methodTargets.some((id) => id.includes('Clone'))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Graph-level units for the #3559 review findings: the pass must be scoped to
// Go (never re-point a Rust/Swift dangling owner onto a Go struct) and must
// key candidates by (dir, package clause, name), because one directory can
// carry `package pkg` AND external-test `package pkg_test` files declaring
// the same type name.

const structNode = (id: string, filePath: string, language: string): GraphNode => ({
  id,
  label: 'Struct',
  properties: { name: id.split(':').pop()!, filePath, language },
});

const danglingHasMethod = (sourceId: string, targetId: string): GraphRelationship => ({
  id: `HAS_METHOD:${sourceId}->${targetId}`,
  type: 'HAS_METHOD',
  sourceId,
  targetId,
  confidence: 1,
  reason: 'test fixture',
});

const methodNode = (id: string): GraphNode => ({
  id,
  label: 'Method',
  properties: { name: id.split(':').pop()!, filePath: 'x.go', language: 'go' },
});

describe('Go struct-owner reconcile scoping (#3559)', () => {
  it('never re-points a dangling non-Go Struct owner edge, even with a same-name Go struct', () => {
    const graph = createKnowledgeGraph();
    // Go struct Widget in the same directory the Rust owner id points at.
    graph.addNode(structNode('Struct:src:Widget', 'src/decl.go', 'go'));
    graph.addNode(methodNode('Method:src:describe'));
    // Rust owner id — same dir, same simple name, file NOT .go.
    graph.addRelationship(danglingHasMethod('Struct:src/widget.rs:Widget', 'Method:src:describe'));

    expect(reconcileGoStructOwnerEdges(graph, '/nonexistent')).toBe(0);
    // The edge must be untouched (still dangling, not re-pointed, not dropped).
    const edges = [...graph.iterRelationshipsByType('HAS_METHOD')];
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceId).toBe('Struct:src/widget.rs:Widget');
  });

  it('re-points a dangling Go owner edge to the Go struct with the same package clause', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(structNode('Struct:src/decl.go:Widget', 'src/decl.go', 'go'));
    graph.addNode(methodNode('Method:src/methods.go:Describe'));

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-reconcile-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src', 'decl.go'),
        'package pkgtest\n\ntype Widget struct { Name string }\n',
      );
      fs.writeFileSync(path.join(repo, 'src', 'methods.go'), 'package pkgtest\n');
      graph.addRelationship(
        danglingHasMethod('Struct:src/methods.go:Widget', 'Method:src/methods.go:Describe'),
      );

      expect(reconcileGoStructOwnerEdges(graph, repo)).toBe(1);
      const edges = [...graph.iterRelationshipsByType('HAS_METHOD')];
      expect(edges.length).toBe(1);
      expect(edges[0]!.sourceId).toBe('Struct:src/decl.go:Widget');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('distinguishes `package pkg` from external-test `package pkg_test` structs in one directory', () => {
    const graph = createKnowledgeGraph();
    // Two same-name structs in ONE directory, different packages: production
    // `pkg.Widget` and external-test `pkg_test.Widget`. The old (dir, name)
    // key saw 2 candidates and dropped the edge fail-closed.
    graph.addNode(structNode('Struct:src/widget.go:Widget', 'src/widget.go', 'go'));
    graph.addNode(
      structNode('Struct:src/widget_ext_test.go:Widget', 'src/widget_ext_test.go', 'go'),
    );
    graph.addNode(methodNode('Method:src/external_methods_test.go:Describe'));

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-reconcile-pkg-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src', 'widget.go'),
        'package pkg\n\ntype Widget struct { Name string }\n',
      );
      fs.writeFileSync(
        path.join(repo, 'src', 'widget_ext_test.go'),
        'package pkg_test\n\ntype Widget struct { Name string }\n',
      );
      // Owner file declares `package pkg_test` → must resolve to the
      // pkg_test.Widget node, not drop, not pick pkg.Widget.
      fs.writeFileSync(path.join(repo, 'src', 'external_methods_test.go'), 'package pkg_test\n');
      graph.addRelationship(
        danglingHasMethod(
          'Struct:src/external_methods_test.go:Widget',
          'Method:src/external_methods_test.go:Describe',
        ),
      );

      expect(reconcileGoStructOwnerEdges(graph, repo)).toBe(1);
      const edges = [...graph.iterRelationshipsByType('HAS_METHOD')];
      expect(edges.length).toBe(1);
      expect(edges[0]!.sourceId).toBe('Struct:src/widget_ext_test.go:Widget');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops (fail-closed) when the same package declares the same name twice', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(structNode('Struct:src/a.go:Widget', 'src/a.go', 'go'));
    graph.addNode(structNode('Struct:src/b.go:Widget', 'src/b.go', 'go'));
    graph.addNode(methodNode('Method:src/methods.go:Describe'));

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-reconcile-amb-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'a.go'), 'package pkg\n');
      fs.writeFileSync(path.join(repo, 'src', 'b.go'), 'package pkg\n');
      fs.writeFileSync(path.join(repo, 'src', 'methods.go'), 'package pkg\n');
      graph.addRelationship(
        danglingHasMethod('Struct:src/methods.go:Widget', 'Method:src/methods.go:Describe'),
      );

      expect(reconcileGoStructOwnerEdges(graph, repo)).toBe(0);
      // Edge untouched — the old drop behavior for ambiguity.
      const edges = [...graph.iterRelationshipsByType('HAS_METHOD')];
      expect(edges.length).toBe(1);
      expect(edges[0]!.sourceId).toBe('Struct:src/methods.go:Widget');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Go external-test-package method ownership through the pipeline (#3559)', () => {
  it('re-points a pkg_test method edge onto the pkg_test struct, not the pkg struct and not a drop', async () => {
    // Layout: one directory, TWO packages declaring the same type name —
    // `package pkg` (widget.go) and external-test `package pkg_test`
    // (widget_ext_test.go) — plus external_methods_test.go declaring a method
    // on pkg_test.Widget in yet another file. The (dir, name) key saw two
    // candidates and dropped the edge fail-closed; the (dir, package, name)
    // key resolves it.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ext-test-owner-'));
    try {
      fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/pkgtest\n\ngo 1.22\n');
      fs.writeFileSync(
        path.join(repo, 'widget.go'),
        ['package pkg', '', 'type Widget struct {', '\tName string', '}', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(repo, 'widget_ext_test.go'),
        ['package pkg_test', '', 'type Widget struct {', '\tName string', '}', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(repo, 'external_methods_test.go'),
        ['package pkg_test', '', 'func (w *Widget) Describe() string { return w.Name }', ''].join(
          '\n',
        ),
      );

      const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });

      // BOTH structs exist.
      const widgets = [...result.graph.iterNodes()].filter(
        (n) => n.label === 'Struct' && n.properties.name === 'Widget',
      );
      expect(widgets.length).toBe(2);
      const pkgWidget = widgets.find((n) => n.properties.filePath.includes('widget.go'));
      const pkgTestWidget = widgets.find((n) =>
        n.properties.filePath.includes('widget_ext_test.go'),
      );
      expect(pkgWidget).toBeDefined();
      expect(pkgTestWidget).toBeDefined();

      // The Describe edge from external_methods_test.go must land on the
      // pkg_test.Widget node (it dangles at `Struct:external_methods_test.go:Widget`
      // before the reconcile pass).
      const describeTargets = hasMethodEdgeFrom(result.graph, pkgTestWidget!.id);
      expect(describeTargets.some((id) => id.includes('Describe'))).toBe(true);
      // And must NOT have been re-pointed onto the production pkg.Widget.
      expect(
        hasMethodEdgeFrom(result.graph, pkgWidget!.id).some((id) => id.includes('Describe')),
      ).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
