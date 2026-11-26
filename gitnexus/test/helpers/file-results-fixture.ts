import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  emptyParseCache,
  loadParseCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';
import { TEST_PARSE_IDENTITY } from './cache-identity.js';
const worker = pathToFileURL(path.resolve('dist/core/ingestion/workers/parse-worker.js'));
export async function createFileResultsFixture(root: string, files: Record<string, string>) {
  const repo = path.join(root, 'repo'),
    live = path.join(root, 'live');
  await fs.mkdir(repo);
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await fs.writeFile(path.join(repo, name), content);
    }),
  );
  let sequence = 0;
  return {
    repo,
    live,
    run: async (cacheKind: 'cold' | 'reuse' | 'none', pdg = false, repack = false) => {
      const stage = path.join(root, `stage-${sequence++}`);
      let cache: ParseCache | undefined;
      if (cacheKind === 'cold')
        cache = emptyParseCache(TEST_PARSE_IDENTITY, {
          storagePath: live,
          writeStoragePath: stage,
        });
      if (cacheKind === 'reuse') cache = await loadParseCache(live, TEST_PARSE_IDENTITY, stage);
      const progress: number[] = [];
      const run = await runPipelineFromRepo(
        repo,
        (p) => {
          if (p.phase === 'parsing' && p.percent >= 20 && p.percent <= 70) progress.push(p.percent);
        },
        {
          parseWorkerUrl: worker,
          workerPoolSize: 2,
          parseCache: cache,
          parsedFileStorePath: stage,
          pdg,
          ...(repack ? { chunkByteBudget: 1 } : {}),
        },
      );
      if (cache) {
        const keys = await saveParseCache(live, cache);
        if (!('fileResults' in cache))
          await mergeStagedDurableParsedFileStore(
            live,
            stage,
            TEST_PARSE_IDENTITY.base,
            new Set(keys),
          );
      }
      await fs.rm(stage, { recursive: true, force: true });
      return { ...run, progress };
    },
  };
}
