import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { TransitionalScopeTree } from '../../src/storage/scope-index-store.js';

describe('producer return facts after the disk scope seal', () => {
  it.each([
    ['cold unannotated factory', 'def make():\n    pass\n\ndef caller():\n    make().m()\n'],
    [
      'annotated factory with a competing method',
      'class Product:\n    def save(self): pass\nclass OtherProduct:\n    def save(self): pass\ndef make() -> Product:\n    return Product()\ndef caller():\n    make().save()\n',
    ],
  ])(
    '%s matches resident resolution',
    async (name, source) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-return-repo-'));
      const store = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-return-store-'));
      const previous = process.env.GITNEXUS_DISK_SCOPE_INDEX;
      const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
      const outcomes: string[][] = [];
      try {
        await fs.writeFile(path.join(root, 'factory.py'), source);
        for (const disk of [false, true]) {
          process.env.GITNEXUS_DISK_SCOPE_INDEX = disk ? '1' : '0';
          seal.mockClear();
          const result = await runPipelineFromRepo(root, () => {}, {
            parsedFileStorePath: path.join(store, disk ? 'disk' : 'resident'),
          });
          expect(seal).toHaveBeenCalledTimes(disk ? 1 : 0);
          const edges = [...result.graph.iterRelationships()];
          outcomes.push(
            edges
              .filter((edge) => ['CALLS', 'ACCESSES', 'IMPORTS'].includes(edge.type))
              .map((edge) => `${edge.type}:${edge.sourceId}->${edge.targetId}:${edge.reason ?? ''}`)
              .sort(),
          );
          if (name.startsWith('annotated')) {
            const product = [...result.graph.iterNodes()].find(
              (node) => node.label === 'Class' && node.properties.name === 'Product',
            );
            const methods = new Set(
              edges
                .filter((edge) => edge.type === 'HAS_METHOD' && edge.sourceId === product?.id)
                .map((edge) => edge.targetId),
            );
            const targets = edges
              .filter(
                (edge) =>
                  edge.type === 'CALLS' &&
                  result.graph.getNode(edge.sourceId)?.properties.name === 'caller' &&
                  result.graph.getNode(edge.targetId)?.properties.name === 'save',
              )
              .map((edge) => edge.targetId);
            expect(targets).toHaveLength(1);
            expect(methods.has(targets[0]!)).toBe(true);
          }
        }
        expect(outcomes[1]).toEqual(outcomes[0]);
      } finally {
        seal.mockRestore();
        if (previous === undefined) delete process.env.GITNEXUS_DISK_SCOPE_INDEX;
        else process.env.GITNEXUS_DISK_SCOPE_INDEX = previous;
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(store, { recursive: true, force: true });
      }
    },
    120000,
  );
});
