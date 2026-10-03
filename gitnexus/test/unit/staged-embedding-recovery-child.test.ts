import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dbCtor: vi.fn(),
  connCtor: vi.fn(),
  dbClose: vi.fn<() => Promise<void>>(),
  connClose: vi.fn<() => Promise<void>>(),
  query: vi.fn(),
  abortBuilder: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => {
  class Database {
    constructor(...args: unknown[]) {
      h.dbCtor(...args);
    }
    close = h.dbClose;
  }
  class Connection {
    constructor(db: unknown) {
      h.connCtor(db);
    }
    query = h.query;
    close = h.connClose;
  }
  return { default: { Database, Connection } };
});

vi.mock('../../src/core/embeddings/embedding-restore-spill.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/embeddings/embedding-restore-spill.js')>();
  return {
    ...actual,
    abortCachedEmbeddingsBuilder: (
      ...args: Parameters<typeof actual.abortCachedEmbeddingsBuilder>
    ) => {
      h.abortBuilder(...args);
      return actual.abortCachedEmbeddingsBuilder(...args);
    },
  };
});

describe('staged embedding recovery child native lifecycle', () => {
  let tmp: string;
  let dbPath: string;
  let exportDir: string;
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    h.dbCtor.mockReset();
    h.connCtor.mockReset();
    h.dbClose.mockReset().mockResolvedValue(undefined);
    h.connClose.mockReset().mockResolvedValue(undefined);
    h.query.mockReset().mockResolvedValue({
      hasNext: vi.fn().mockResolvedValue(false),
      getNext: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-recovery-child-'));
    dbPath = path.join(tmp, 'lbug.stage-test');
    exportDir = path.join(tmp, 'export');
    fs.writeFileSync(dbPath, 'mock native database');
    fs.writeFileSync(`${dbPath}.wal`, 'retained WAL');
    fs.mkdirSync(exportDir);
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.argv = [process.execPath, 'staged-embedding-recovery-child', dbPath, exportDir, '2'];
    process.exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function runRejectedChild(message: string): Promise<void> {
    await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1);
      expect(process.stderr.write).toHaveBeenCalledWith(`${message}\n`);
    });
    expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
    expect(fs.readFileSync(`${dbPath}.wal`, 'utf8')).toBe('retained WAL');
  }

  it('closes the opened database and aborts the builder when Connection construction fails', async () => {
    h.connCtor.mockImplementation(() => {
      throw new Error('connection constructor failed');
    });

    await runRejectedChild('connection constructor failed');

    expect(h.dbClose).toHaveBeenCalledOnce();
    expect(h.connClose).not.toHaveBeenCalled();
    expect(h.abortBuilder).toHaveBeenCalledOnce();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.dbCtor.mock.calls[0][7]).toBe(true);
  });

  it('aborts the builder when Database construction fails', async () => {
    h.dbCtor.mockImplementation(() => {
      throw new Error('database constructor failed');
    });

    await runRejectedChild('database constructor failed');

    expect(h.abortBuilder).toHaveBeenCalledOnce();
    expect(h.dbClose).not.toHaveBeenCalled();
    expect(h.connCtor).not.toHaveBeenCalled();
  });

  it('rejects output and closes the database when Connection close fails', async () => {
    h.connClose.mockRejectedValue(new Error('connection close failed'));

    await runRejectedChild('connection close failed');

    expect(h.dbClose).toHaveBeenCalled();
    expect(h.abortBuilder).toHaveBeenCalledOnce();
  });

  it('rejects output when Database close fails', async () => {
    h.dbClose.mockRejectedValue(new Error('database close failed'));

    await runRejectedChild('database close failed');

    expect(h.connClose).toHaveBeenCalled();
    expect(h.abortBuilder).toHaveBeenCalledOnce();
  });

  it('writes the manifest only after both native closes succeed', async () => {
    const closed: string[] = [];
    h.connClose.mockImplementation(async () => {
      expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
      closed.push('connection');
    });
    h.dbClose.mockImplementation(async () => {
      expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
      closed.push('database');
    });

    await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
    await vi.waitFor(() => expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(true));

    expect(closed).toEqual(['connection', 'database']);
    expect(h.abortBuilder).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(`${dbPath}.wal`, 'utf8')).toBe('retained WAL');
  });
});
