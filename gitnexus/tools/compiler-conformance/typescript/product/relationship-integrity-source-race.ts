import { after, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import {
  type ParseCache,
  loadParseCache,
  saveParseCache,
} from '../../../../dist/storage/parse-cache.js';
import * as integrityModule from '../../../../dist/core/graph/relationship-integrity.js';
import { _captureLogger } from '../../../../dist/core/logger.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../dist/storage/parsedfile-store.js';

let injectCfgConflict = false;
const createCollector: typeof integrityModule.createRelationshipIntegrityCollector = (...args) => {
  const collector = integrityModule.createRelationshipIntegrityCollector(...args);
  if (!injectCfgConflict) return collector;
  return {
    ...collector,
    inspect: (rel, duplicate, conflict) =>
      collector.inspect(rel, duplicate, conflict || rel.type === 'CFG'),
  };
};
const integrityMock = mock.module(
  new URL('../../../../dist/core/graph/relationship-integrity.js', import.meta.url).href,
  { namedExports: { ...integrityModule, createRelationshipIntegrityCollector: createCollector } },
);
after(() => integrityMock.restore());
const { runPipelineFromRepo } = await import('../../../../dist/core/ingestion/pipeline.js');
const source =
  'export class Service { ping() { return 1; } }\nexport function caller(service: Service) { service.ping(); }\n';

for (const { streamGraphEmit, cached } of [
  { streamGraphEmit: false, cached: false },
  { streamGraphEmit: true, cached: false },
  { streamGraphEmit: false, cached: true },
  { streamGraphEmit: true, cached: true },
]) {
  describe(`concurrent source edits (streaming=${streamGraphEmit} cached=${cached})`, () => {
    for (const change of ['truncate', 'lengthen', 'rename', 'delete'] as const) {
      it(`keeps ${change} unverified on cold and cached parsing`, { timeout: 90_000 }, async () => {
        const identity = await runtimeParseIdentity();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-integrity-race-'));
        const file = path.join(root, 'sample.ts');
        const storage = path.join(root, '.gitnexus');
        let cache: ParseCache = {
          identity,
          entries: new Map(),
          usedKeys: new Set(),
          storagePath: storage,
          writeStoragePath: storage,
          onDiskKeys: new Set(),
        };
        try {
          fs.writeFileSync(file, source);
          const options = {
            skipGraphPhases: true,
            workerPoolSize: 1,
            parseCache: cache,
            streamGraphEmit,
            graphEmitCsvDir: path.join(root, 'csv'),
          };
          if (cached) {
            await runPipelineFromRepo(root, () => {}, options);
            const keys = await saveParseCache(storage, cache);
            await pruneAndSaveDurableParsedFileStore(
              getDurableParsedFileDir(storage),
              cache.identity.base,
              new Set(keys),
            );
            cache = await loadParseCache(storage, cache.identity, storage);
            options.parseCache = cache;
          }
          let mutated = false;
          const result = await runPipelineFromRepo(
            root,
            (progress) => {
              if (progress.phase !== 'scopeResolution' || mutated) return;
              mutated = true;
              const mutations = {
                truncate: () => fs.writeFileSync(file, ''),
                lengthen: () => fs.appendFileSync(file, '// edit after parsing\n'),
                rename: () => fs.renameSync(file, `${file}.old`),
                delete: () => fs.unlinkSync(file),
              };
              mutations[change]();
            },
            options,
          );
          expect(mutated).toBe(true);
          expect(result.parseCacheHitFileCount).toBe(cached ? 1 : 0);
          expect(result.relationshipIntegrity?.checkedSites).toBe(0);
          expect(result.relationshipIntegrity?.unverifiedEdges).toBeGreaterThan(0);
          const calls = streamGraphEmit
            ? fs
                .readFileSync(
                  result.graphEmitManifest!.relsByPair.get('Function|Method')!.csvPath,
                  'utf8',
                )
                .split('\n')
                .filter((line) => line.includes('CALLS'))
            : [...result.graph.iterRelationships()].filter((rel) => rel.type === 'CALLS');
          expect(calls).toHaveLength(1);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });
}

describe('latched integrity failures', () => {
  it('aborts CFG emission without per-file warning floods', { timeout: 90_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-integrity-cfg-'));
    const logs = _captureLogger('debug');
    injectCfgConflict = true;
    try {
      fs.writeFileSync(path.join(root, 'first.ts'), source);
      fs.writeFileSync(path.join(root, 'second.ts'), source);
      await expect(
        runPipelineFromRepo(root, () => {}, {
          pdg: true,
          skipGraphPhases: true,
          workerPoolSize: 1,
        }),
      ).rejects.toThrow(/identity contradicts an existing record/);
      expect(
        logs.records().filter((record) => record.event === 'graph_reference_rejected'),
      ).toHaveLength(1);
      expect(
        logs.records().filter((record) => String(record.msg).includes('CFG emission failed')),
      ).toHaveLength(0);
    } finally {
      injectCfgConflict = false;
      logs.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
