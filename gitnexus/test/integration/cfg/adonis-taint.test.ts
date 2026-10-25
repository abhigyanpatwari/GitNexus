import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';
import { loadParseCache, saveParseCache } from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';
import { runtimeParseIdentity } from '../../helpers/runtime-parse-identity.js';

const directories = createTempDirPool('gn-adonis-taint-');
const parseIdentity = await runtimeParseIdentity();
const workerOptions = {
  workerPoolSize: 1,
  workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
} as const;

const controller = `import sqlClient from '@adonisjs/lucid/services/db';
import { runQuery } from './sink';

export default class UsersController {
  async sqlFromInput({ request }) {
    const name = request.input('name');
    return sqlClient.rawQuery('select * from users where name = ' + name);
  }

  async sqlFromContext(ctx) {
    const params = ctx.request.qs();
    return sqlClient.rawQuery('select * from users where name = ' + params.name);
  }

  async sqlFromValidated({ request }) {
    const payload = await request.validateUsing(searchValidator);
    return sqlClient.rawQuery('select * from users where name = ' + payload.name);
  }

  async boundValue({ request }) {
    const name = request.input('name');
    return sqlClient.rawQuery('select * from users where name = ?', [name]);
  }

  async queryBuilder({ request }) {
    const name = request.input('name');
    return User.query().where('name', name);
  }

  async forward({ request }) {
    const name = request.header('x-name');
    return runQuery(name);
  }
}
`;

const sink = `import db from '@adonisjs/lucid/services/db';
export function runQuery(sql) {
  return db.rawQuery(sql);
}
`;

function findingOwners(result: PipelineResult) {
  const ownerName = (id: string) => {
    const node = result.graph.getNode(id);
    assert(node !== undefined, `Expected taint endpoint ${id}`);
    if (node.label !== 'BasicBlock') return node.properties.name;
    // CFG line numbers are 1-based; Function/Method startLine is 0-based.
    const functionStartLine = Number(node.id.split(':').at(-3));
    const owner = [...result.graph.iterNodes()].find(
      (candidate) =>
        (candidate.label === 'Function' || candidate.label === 'Method') &&
        candidate.properties.filePath === node.properties.filePath &&
        candidate.properties.startLine === functionStartLine - 1,
    );
    assert(owner !== undefined, `Expected function owning ${id}`);
    return owner.properties.name;
  };
  return [...result.graph.iterRelationships()]
    .filter((edge) => edge.type === 'TAINTED' || edge.type === 'TAINT_PATH')
    .map((edge) => {
      const decoded = decodeTaintPath(edge.reason);
      expect(decoded.ok).toBe(true);
      return {
        type: edge.type,
        source: ownerName(edge.sourceId),
        target: ownerName(edge.targetId),
        kind: decoded.ok ? decoded.kind : undefined,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('AdonisJS taint through real workers (#2982)', () => {
  it.each(['ts', 'js'])(
    'preserves %s findings and safe SQL controls through cold and warm parsing',
    async (extension) => {
      const repo = directories.dir();
      const storage = directories.dir();
      fs.writeFileSync(path.join(repo, `controller.${extension}`), controller);
      fs.writeFileSync(path.join(repo, `sink.${extension}`), sink);
      const cache = await loadParseCache(storage, parseIdentity, storage);
      const cold = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: true,
        parseCache: cache,
      });
      expect(cold.usedWorkerPool).toBe(true);
      expect(cold.reparsedFileCount).toBe(2);
      expect(cold.scopeExtractionFailures).toEqual([]);
      expect(findingOwners(cold)).toEqual([
        { type: 'TAINT_PATH', source: 'forward', target: 'runQuery', kind: 'sql-injection' },
        {
          type: 'TAINTED',
          source: 'sqlFromContext',
          target: 'sqlFromContext',
          kind: 'sql-injection',
        },
        { type: 'TAINTED', source: 'sqlFromInput', target: 'sqlFromInput', kind: 'sql-injection' },
        {
          type: 'TAINTED',
          source: 'sqlFromValidated',
          target: 'sqlFromValidated',
          kind: 'sql-injection',
        },
      ]);

      const savedKeys = await saveParseCache(storage, cache);
      expect(savedKeys.length).toBeGreaterThan(0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        parseIdentity.base,
        new Set(savedKeys),
      );
      const warm = await runPipelineFromRepo(repo, () => {}, {
        ...workerOptions,
        pdg: true,
        parseCache: await loadParseCache(storage, parseIdentity, storage),
      });
      expect(warm.usedWorkerPool).toBe(false);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(2);
      expect(findingOwners(warm)).toEqual(findingOwners(cold));

      const off = await runPipelineFromRepo(repo, () => {}, { ...workerOptions });
      expect(findingOwners(off)).toEqual([]);
    },
  );
});
