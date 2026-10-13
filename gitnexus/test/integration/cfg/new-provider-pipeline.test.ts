import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { isOptionalGrammarRequired } from '../../helpers/optional-grammar.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  saveParseCache,
  PARSE_CACHE_VERSION,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';
import { _captureLogger } from '../../../src/core/logger.js';

const directories = createTempDirPool('new-provider-pdg-');
const fixtures = {
  'model.m': `@interface Worker\n- (int)run:(int)input;\n@end\n@implementation Worker\n- (int)run:(int)input {\n  int value = input;\n  if (input) { value = 1; } else { value = 2; }\n  return value;\n}\n@end\n`,
  'model.zig': `fn run(input: i32) i32 {\n  var value: i32 = input;\n  if (input > 0) { value = 1; } else { value = 2; }\n  return value;\n}\n`,
  'model.cbl': `       >>SOURCE FORMAT FREE\nidentification division.\nprogram-id. Demo.\ndata division.\nworking-storage section.\n01 X PIC 9.\n01 FLAG PIC 9.\nprocedure division.\nmove 0 to x\nif flag = 1\nmove 1 to x\nelse\nmove 2 to x\nend-if\ndisplay x\ngoback.\nend program Demo.\n`,
};
const workerOptions = {
  workerPoolSize: 1,
  workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
  skipGraphPhases: true,
} as const;
const edgeTypes = new Set(['CFG', 'REACHING_DEF', 'CDG', 'POST_DOMINATE', 'TAINTED', 'SANITIZES']);

function layer(result: PipelineResult) {
  return {
    nodes: [...result.graph.iterNodes()]
      .filter((n) => n.label === 'BasicBlock')
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...result.graph.iterRelationships()]
      .filter((e) => edgeTypes.has(e.type))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('new flow providers through production ingestion', () => {
  it.skipIf(
    !isLanguageAvailable(SupportedLanguages.Zig) &&
      !isOptionalGrammarRequired(SupportedLanguages.Zig),
  )(
    'reports unsupported Zig CFGs through worker warning aggregation',
    async () => {
      const repo = directories.dir();
      await fs.writeFile(
        path.join(repo, 'assembly.zig'),
        `
        extern fn external() void;
        fn normal() void { work(); }
        fn hasAssembly() void { asm volatile ("nop"); }
      `,
      );
      const warning = _captureLogger();
      try {
        const result = await runPipelineFromRepo(repo, () => {}, { ...workerOptions, pdg: true });
        expect(result.usedWorkerPool).toBe(true);
        const blocks = layer(result).nodes;
        expect(blocks.some((node) => node.properties.text?.includes('work()'))).toBe(true);
        expect(warning.text()).toContain(
          'CFG functions skipped (zig): 0 too-deeply-nested, 1 build-error(s), 0 over line cap',
        );
      } finally {
        warning.restore();
      }
    },
    120_000,
  );

  for (const [file, content] of Object.entries(fixtures)) {
    const test =
      file === 'model.zig' &&
      !isLanguageAvailable(SupportedLanguages.Zig) &&
      !isOptionalGrammarRequired(SupportedLanguages.Zig)
        ? it.skip
        : it;
    test(`${file} preserves CFG/CDG/data flow through cache and streaming`, async () => {
      const repo = directories.dir();
      const storage = directories.dir();
      await fs.writeFile(path.join(repo, file), content);
      const cache = await loadParseCache(storage);
      const cold = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: true,
        parseCache: cache,
      });
      const expected = layer(cold);
      expect(expected.nodes.length).toBeGreaterThan(0);
      for (const type of ['CFG', 'CDG', 'REACHING_DEF']) {
        expect(
          expected.edges.some((e) => e.type === type),
          `${file}: ${type}`,
        ).toBe(true);
      }
      const ids = new Set(expected.nodes.map((n) => n.id));
      for (const edge of expected.edges) {
        expect(ids.has(edge.sourceId)).toBe(true);
        expect(ids.has(edge.targetId)).toBe(true);
      }
      if (file === 'model.cbl') {
        expect(new Set(expected.nodes.map((n) => n.properties.ownerId))).toEqual(
          new Set(['Module:model.cbl:Demo']),
        );
        expect(cold.graph.getNode('Module:model.cbl:Demo')).toBeDefined();
      } else {
        expect(cold.usedWorkerPool).toBe(true);
      }

      const savedKeys = await saveParseCache(storage, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warm = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: true,
        parseCache: await loadParseCache(storage),
      });
      expect(layer(warm)).toEqual(expected);
      if (file !== 'model.cbl') {
        expect(warm.parseCacheHitFileCount).toBe(1);
        expect(warm.usedWorkerPool).toBe(false);
      }

      const streamed = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: true,
        streamPdgEmit: true,
        parseCache: await loadParseCache(storage),
      });
      expect(layer(streamed)).toEqual({ nodes: [], edges: [] });
      const manifest = streamed.pdgEmitManifest!;
      expect(manifest.nodeFiles.get('BasicBlock')?.rows).toBe(expected.nodes.length);
      expect([...manifest.relsByPair.values()].reduce((total, item) => total + item.rows, 0)).toBe(
        expected.edges.length,
      );
      if (file === 'model.cbl') {
        const csv = await fs.readFile(manifest.nodeFiles.get('BasicBlock')!.csvPath, 'utf8');
        expect(csv).toContain('ownerId');
        expect(csv).toContain('Module:model.cbl:Demo');
      }

      const off = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: false,
        parseCache: await loadParseCache(storage),
      });
      expect(layer(off)).toEqual({ nodes: [], edges: [] });
    }, 120_000);
  }
});
