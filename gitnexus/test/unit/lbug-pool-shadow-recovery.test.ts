import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalStdoutWrite = process.stdout.write;

const SHADOW_REPLAY_ERROR =
  "Runtime exception: Couldn't replay shadow pages under read-only mode. Please re-open the database with read-write mode to replay shadow pages.";
const STALE_SHADOW_ERROR =
  "Runtime exception: Database ID for temporary file 'C:\\repo\\.gitnexus\\lbug.shadow' does not match the current database.";

async function makeDbPath(): Promise<{ dbPath: string; tmpDir: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pool-shadow-'));
  const dbPath = path.join(tmpDir, 'lbug');
  await fs.writeFile(dbPath, '');
  return { dbPath, tmpDir };
}

async function loadPoolAdapter(options: {
  readOnlyOpenFailures?: number;
  readOnlyQueryFailures?: number;
  writableCheckpointFailures?: number;
}) {
  vi.resetModules();

  let readOnlyOpenFailures = options.readOnlyOpenFailures ?? 0;
  let readOnlyQueryFailures = options.readOnlyQueryFailures ?? 0;
  let writableCheckpointFailures = options.writableCheckpointFailures ?? 0;
  const databaseOpens: Array<{ path: string; readOnly: boolean }> = [];
  const queries: Array<{ sql: string; readOnly: boolean }> = [];

  class MockDatabase {
    readonly readOnly: boolean;

    constructor(dbPath: string, _bufferSize?: number, _compression?: boolean, readOnly?: boolean) {
      this.readOnly = readOnly === true;
      databaseOpens.push({ path: dbPath, readOnly: this.readOnly });
      if (this.readOnly && readOnlyOpenFailures > 0) {
        readOnlyOpenFailures--;
        throw new Error(SHADOW_REPLAY_ERROR);
      }
    }

    close = vi.fn(async () => undefined);
  }

  class MockConnection {
    constructor(private readonly db: MockDatabase) {}

    async query(sql: string) {
      queries.push({ sql, readOnly: this.db.readOnly });
      if (this.db.readOnly && readOnlyQueryFailures > 0) {
        readOnlyQueryFailures--;
        throw new Error(SHADOW_REPLAY_ERROR);
      }
      if (!this.db.readOnly && sql === 'CHECKPOINT' && writableCheckpointFailures > 0) {
        writableCheckpointFailures--;
        throw new Error(STALE_SHADOW_ERROR);
      }
      return {
        getAll: async () => [{ ok: true }],
        close: async () => undefined,
      };
    }

    async prepare(sql: string) {
      queries.push({ sql, readOnly: this.db.readOnly });
      return {
        isSuccess: () => true,
        getErrorMessage: async () => '',
      };
    }

    async execute() {
      if (this.db.readOnly && readOnlyQueryFailures > 0) {
        readOnlyQueryFailures--;
        throw new Error(SHADOW_REPLAY_ERROR);
      }
      return {
        getAll: async () => [{ ok: true }],
        close: async () => undefined,
      };
    }

    close = vi.fn(async () => undefined);
  }

  vi.doMock('@ladybugdb/core', () => ({
    default: {
      Database: MockDatabase,
      Connection: MockConnection,
    },
  }));
  vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
    loadFTSExtension: vi.fn(async () => true),
  }));

  const adapter = await import('../../src/core/lbug/pool-adapter.js');
  return { adapter, databaseOpens, queries };
}

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('LadybugDB pool shadow-page recovery', () => {
  it('opens writable to replay shadow pages when read-only init fails', async () => {
    const { dbPath, tmpDir } = await makeDbPath();
    try {
      const { adapter, databaseOpens, queries } = await loadPoolAdapter({
        readOnlyOpenFailures: 1,
      });

      await adapter.initLbug('repo', dbPath);

      expect(databaseOpens.map((open) => open.readOnly)).toEqual([true, false, true]);
      expect(queries).toContainEqual({ sql: 'CHECKPOINT', readOnly: false });

      await adapter.closeLbug();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays shadow pages and retries when a read-only query hits recovery state', async () => {
    const { dbPath, tmpDir } = await makeDbPath();
    try {
      const { adapter, databaseOpens, queries } = await loadPoolAdapter({
        readOnlyQueryFailures: 1,
      });

      await adapter.initLbug('repo', dbPath);
      const rows = await adapter.executeQuery('repo', 'MATCH (n) RETURN n');

      expect(rows).toEqual([{ ok: true }]);
      expect(databaseOpens.map((open) => open.readOnly)).toEqual([true, false, true]);
      expect(queries).toContainEqual({ sql: 'CHECKPOINT', readOnly: false });
      expect(queries.filter((query) => query.sql === 'MATCH (n) RETURN n')).toHaveLength(2);

      await adapter.closeLbug();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes stale shadow sidecars when writable replay detects database id mismatch', async () => {
    const { dbPath, tmpDir } = await makeDbPath();
    const shadowPath = `${dbPath}.shadow`;
    const walPath = `${dbPath}.wal`;
    await fs.writeFile(shadowPath, 'stale shadow');
    await fs.writeFile(walPath, 'stale wal');

    try {
      const { adapter, databaseOpens, queries } = await loadPoolAdapter({
        readOnlyQueryFailures: 1,
        writableCheckpointFailures: 1,
      });

      await adapter.initLbug('repo', dbPath);
      const rows = await adapter.executeQuery('repo', 'MATCH (n) RETURN n');

      expect(rows).toEqual([{ ok: true }]);
      expect(databaseOpens.map((open) => open.readOnly)).toEqual([true, false, false, true]);
      expect(queries.filter((query) => query.sql === 'CHECKPOINT' && !query.readOnly)).toHaveLength(
        2,
      );
      await expect(fs.access(shadowPath)).rejects.toThrow();
      await expect(fs.access(walPath)).rejects.toThrow();

      await adapter.closeLbug();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
