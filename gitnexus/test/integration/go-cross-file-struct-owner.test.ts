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
import { runPipelineFromRepo } from './resolvers/helpers.js';

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
