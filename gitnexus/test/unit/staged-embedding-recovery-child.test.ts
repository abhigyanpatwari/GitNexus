import fs from 'node:fs';
import { EventEmitter } from 'node:events';
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
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));

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
  const suffixes = [
    '',
    '.wal',
    '.shadow',
    '.wal.checkpoint',
    '.lock',
    '.checkpoint.intent.lock',
    '.checkpoint.apply.lock',
  ];
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
    vi.useRealTimers();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function sourceFamily() {
    return Object.fromEntries(
      suffixes.map((suffix) => [suffix, fs.readFileSync(dbPath + suffix, 'utf8')]),
    );
  }

  function seedCompleteFamily() {
    for (const suffix of suffixes) fs.writeFileSync(dbPath + suffix, `retained ${suffix}`);
    return sourceFamily();
  }

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

  it('confines writable replay and failed checkpoint close to a separate copied family', async () => {
    const sourceBefore = seedCompleteFamily();
    h.dbCtor.mockImplementation((openedPath: string) => {
      for (const suffix of suffixes) {
        expect(fs.readFileSync(openedPath + suffix, 'utf8')).toBe(sourceBefore[suffix]);
        fs.writeFileSync(openedPath + suffix, `replayed ${suffix}`);
      }
    });
    h.dbClose.mockImplementation(async () => {
      const openedPath = h.dbCtor.mock.calls[0][0] as string;
      fs.writeFileSync(openedPath, 'partial checkpoint');
      throw new Error('checkpoint close failed');
    });

    await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(h.dbCtor.mock.calls[0][0]).not.toBe(dbPath);
    expect(path.relative(exportDir, h.dbCtor.mock.calls[0][0] as string)).not.toMatch(/^\.\./);
    expect(sourceFamily()).toEqual(sourceBefore);
    expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
    expect(process.stderr.write).toHaveBeenCalledWith('checkpoint close failed\n');
  });

  it('reclaims a timed-out writer copy without changing the retained source', async () => {
    const sourceBefore = seedCompleteFamily();
    h.query.mockReturnValue(new Promise(() => {}));
    h.dbCtor.mockImplementation((openedPath: string) => {
      for (const suffix of suffixes) fs.writeFileSync(openedPath + suffix, 'writer opened');
    });
    let childImport: Promise<unknown> | undefined;
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      }),
    });
    h.spawn.mockImplementation((_command: string, args: string[]) => {
      process.argv = [process.execPath, 'staged-embedding-recovery-child', ...args.slice(-3)];
      childImport = import('../../src/core/embeddings/staged-embedding-recovery-child.js');
      return child;
    });
    const { recoverStagedEmbeddings } =
      await import('../../src/core/embeddings/staged-embedding-recovery.js');
    vi.useFakeTimers();
    const recovering = expect(
      recoverStagedEmbeddings(dbPath, { dimensions: 2, timeoutMs: 500 }),
    ).rejects.toThrow(/timeout/);
    await childImport;
    expect(h.dbCtor).toHaveBeenCalledOnce();
    const openedPath = h.dbCtor.mock.calls[0][0] as string;

    await vi.advanceTimersByTimeAsync(500);
    await recovering;

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(openedPath).not.toBe(dbPath);
    expect(fs.existsSync(path.dirname(openedPath))).toBe(false);
    expect(sourceFamily()).toEqual(sourceBefore);
    expect(h.dbClose).not.toHaveBeenCalled();
  });

  it.each(['.wal', '.checkpoint.intent.lock', '.checkpoint.apply.lock'])(
    'refuses a dangling family symlink before native open: %s',
    async (suffix) => {
      fs.rmSync(dbPath + suffix, { force: true });
      fs.symlinkSync(path.join(tmp, 'missing-sidecar'), dbPath + suffix);

      await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));

      expect(h.dbCtor).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(
        'staged embedding family is not a regular file\n',
      );
      expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
    },
  );

  it('refuses a family entry replaced with a symlink between lstat and open', async () => {
    const foreignPath = path.join(tmp, 'foreign-file');
    fs.writeFileSync(foreignPath, 'foreign');
    const open = fs.openSync;
    const read = vi.spyOn(fs, 'readSync');
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === dbPath) {
        fs.rmSync(dbPath);
        fs.symlinkSync(foreignPath, dbPath);
      }
      return open(...args);
    });

    await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(read).not.toHaveBeenCalled();
    expect(h.dbCtor).not.toHaveBeenCalled();
    expect(fs.readFileSync(foreignPath, 'utf8')).toBe('foreign');
    expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
  });

  it('fails closed when copying the complete family runs out of space', async () => {
    const sourceBefore = seedCompleteFamily();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('copy ran out of space'), { code: 'ENOSPC' });
    });

    await import('../../src/core/embeddings/staged-embedding-recovery-child.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(h.dbCtor).not.toHaveBeenCalled();
    expect(sourceFamily()).toEqual(sourceBefore);
    expect(fs.existsSync(path.join(exportDir, 'manifest.json'))).toBe(false);
    expect(process.stderr.write).toHaveBeenCalledWith('copy ran out of space\n');
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
