import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  isLanguageAvailable,
  listGrammarSources,
} from '../../src/core/tree-sitter/parser-loader.js';
import { TransitionalScopeTree } from '../../src/storage/scope-index-store.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { isOptionalGrammarRequired } from '../helpers/optional-grammar.js';

const dirs = createTempDirPool('gn-pdg-language-spill-');
const fixtures: Partial<Record<SupportedLanguages, [filename: string, source?: string]>> = {
  c: ['c-hazards.c'],
  cpp: ['cpp-hazards.cpp'],
  csharp: ['csharp-hazards.cs'],
  dart: ['dart-hazards.dart'],
  go: ['go-hazards.go'],
  javascript: ['sample.js', 'export function choose(x) { if (x) return 1; return 2; }'],
  kotlin: ['kotlin-hazards.kt'],
  php: ['php-hazards.php'],
  python: ['python-hazards.py'],
  ruby: ['ruby-hazards.rb'],
  rust: ['rust-hazards.rs'],
  swift: ['swift-hazards.swift'],
  vue: ['vue-hazards.vue'],
  zig: ['sample.zig', 'fn choose(x: i32) i32 { if (x > 0) { return 1; } return 2; }'],
  r: ['sample.R', 'choose <- function(x) {\n  if (x) 1 else 2\n}\n'],
  'objective-c': [
    'sample.m',
    '@interface Counter\n- (int)get:(int)x;\n@end\n@implementation Counter\n- (int)get:(int)x { if (x) return 1; return 2; }\n@end\n',
  ],
  cobol: [
    'sample.cbl',
    '       >>SOURCE FORMAT FREE\nidentification division.\nprogram-id. Counter.\ndata division.\nworking-storage section.\n01 X PIC 9.\nprocedure division.\nif x = 1\nmove 2 to x\nelse\nmove 3 to x\nend-if\ndisplay x\ngoback.\nend program Counter.\n',
  ],
};

const pdgLanguages = Object.values(SupportedLanguages).filter((language) => {
  const provider = getProvider(language);
  return provider.cfgVisitor || provider.collectSourceCfgs;
});
const compilerFixtures = [SupportedLanguages.Java, SupportedLanguages.TypeScript];
it('has a graph fixture for every language that builds a PDG', () => {
  expect([...Object.keys(fixtures), ...compilerFixtures].sort()).toEqual([...pdgLanguages].sort());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

for (const language of pdgLanguages.filter((language) => !compilerFixtures.includes(language))) {
  const optional = listGrammarSources().some(
    (source) => source.key === language && source.optional,
  );
  const skip = optional && !isOptionalGrammarRequired(language) && !isLanguageAvailable(language);
  it.skipIf(skip)(
    `${language} preserves the full graph when spilling under heap pressure`,
    async () => {
      const repo = dirs.dir();
      const [filename, source] = fixtures[language]!;
      if (source === undefined) {
        copyFileSync(
          path.join(import.meta.dirname, '../fixtures/cfg', filename),
          path.join(repo, filename),
        );
      } else {
        writeFileSync(path.join(repo, filename), source);
      }
      vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', undefined);
      vi.stubEnv('INGESTION_EMIT_SCOPES', undefined);
      vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000');
      const heap = v8.getHeapStatistics();
      const pressure = vi.spyOn(v8, 'getHeapStatistics');
      const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
      const run = async (ratio: number) => {
        pressure.mockReturnValue({ ...heap, used_heap_size: heap.heap_size_limit * ratio });
        const { graph } = await runPipelineFromRepo(repo, () => {}, {
          pdg: true,
          parsedFileStorePath: dirs.dir(),
          workerPoolSize: 1,
          skipGraphPhases: true,
        });
        const nodes = [...graph.iterNodes()].sort((a, b) => a.id.localeCompare(b.id));
        const edges = [...graph.iterRelationships()].sort((a, b) => a.id.localeCompare(b.id));
        expect(nodes.some((n) => n.label === 'BasicBlock')).toBe(true);
        expect(edges.some((e) => e.type === 'CFG')).toBe(true);
        return { nodes, edges };
      };
      const resident = await run(0.4);
      expect(seal).not.toHaveBeenCalled();
      expect(await run(0.8)).toEqual(resident);
      expect(seal).toHaveBeenCalledOnce();
      expect(seal.mock.contexts[0]).toHaveProperty('sealed', true);
    },
    120_000,
  );
}
