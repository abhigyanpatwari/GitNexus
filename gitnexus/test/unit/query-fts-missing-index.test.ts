import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const native = vi.hoisted(() => ({
  error: undefined as string | undefined,
  params: [] as unknown[],
}));

// Control the native statement result, while exercising the real adapter's
// connection lock, prepared-query path and missing-index error handling.
vi.mock('@ladybugdb/core', () => {
  const emptyResult = {
    getAll: async () => [],
    close: async () => {},
    isSuccess: () => true,
    getErrorMessage: async () => '',
  };
  class Database {
    async init() {}
    async close() {}
  }
  class Connection {
    async query() {
      return emptyResult;
    }
    async prepare() {
      return {
        isSuccess: () => native.error === undefined,
        getErrorMessage: async () => native.error ?? '',
      };
    }
    async execute(_statement: unknown, params: unknown) {
      native.params.push(params);
      return emptyResult;
    }
    async close() {}
  }
  const mod = { Database, Connection };
  return { ...mod, default: mod, lbug: mod };
});

import { closeLbug, queryFTS, withLbugDb } from '../../src/core/lbug/lbug-adapter.js';

const MISSING = "Binder exception: Table Function doesn't have an index with name function_fts.";

describe('queryFTS missing-index diagnostics', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(async () => {
    native.error = undefined;
    native.params = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-'));
    dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, '');
  });
  afterEach(async () => {
    await closeLbug();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('retains the existing empty-result default for a missing index', async () => {
    await withLbugDb(
      dbPath,
      async () => {
        native.error = MISSING;
        expect(await queryFTS('Function', 'function_fts', 'auth')).toEqual([]);
      },
      { readOnly: true, skipFts: true },
    );
  });

  it('can propagate a missing index so search does not count it as a successful zero-match query', async () => {
    await withLbugDb(
      dbPath,
      async () => {
        native.error = MISSING;
        await expect(
          queryFTS('Function', 'function_fts', 'auth', 5, false, 'throw'),
        ).rejects.toThrow(MISSING);
      },
      { readOnly: true, skipFts: true },
    );
  });

  it('preserves prepared query binding and successful empty results in diagnostic mode', async () => {
    await withLbugDb(
      dbPath,
      async () => {
        const query = "auth' DELETE n";
        expect(await queryFTS('Function', 'function_fts', query, 5, false, 'throw')).toEqual([]);
        expect(native.params).toEqual([{ query }]);
      },
      { readOnly: true, skipFts: true },
    );
  });

  it('still propagates real failures in either missing-index mode', async () => {
    await withLbugDb(
      dbPath,
      async () => {
        native.error = 'Runtime exception: connection reset';
        await expect(queryFTS('Function', 'function_fts', 'auth')).rejects.toThrow(
          'connection reset',
        );
        await expect(
          queryFTS('Function', 'function_fts', 'auth', 5, false, 'throw'),
        ).rejects.toThrow('connection reset');
      },
      { readOnly: true, skipFts: true },
    );
  });
});
