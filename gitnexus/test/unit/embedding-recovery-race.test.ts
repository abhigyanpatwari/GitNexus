import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readEmbeddingRecovery } from '../../src/storage/embedding-recovery.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: { ...actual.constants },
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const stagingFile = 'lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46';
const receipt = {
  embeddingCheckpoint: {
    kind: 'interrupted',
    at: '2026-10-03T12:00:00.000Z',
    nodesProcessed: 1,
    totalNodes: 2,
    chunksProcessed: 1,
    model: 'test-model',
    dimensions: 2,
    provider: 'local',
    recovery: { stagingFile, schemaFingerprint: 'test-schema', unsafeNodeIds: [] },
  },
};

let dir: string;
let metadataPath: string;
beforeEach(() => {
  vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  vi.mocked(fs.openSync).mockImplementation(actual.openSync);
  vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
  vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
  Object.assign(fs.constants, actual.constants);
  vi.clearAllMocks();
  dir = actual.mkdtempSync(path.join(os.tmpdir(), 'gnx-recovery-metadata-race-'));
  metadataPath = path.join(dir, 'gitnexus.json');
  actual.writeFileSync(path.join(dir, stagingFile), 'stage');
});
afterEach(() => actual.rmSync(dir, { recursive: true, force: true }));

describe('readEmbeddingRecovery metadata races', () => {
  it('does not read replacement metadata after checking the original file', () => {
    actual.writeFileSync(metadataPath, JSON.stringify({ embeddingCheckpoint: null }));
    let replaced = false;
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      const stat = actual.lstatSync(...args);
      if (args[0] === metadataPath && !replaced) {
        replaced = true;
        actual.renameSync(metadataPath, path.join(dir, 'original-metadata.json'));
        actual.writeFileSync(metadataPath, JSON.stringify(receipt));
      }
      return stat;
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(replaced).toBe(true);
    const descriptor = vi.mocked(fs.openSync).mock.results[0]?.value;
    expect(typeof descriptor).toBe('number');
    expect(fs.readFileSync).toHaveBeenCalledWith(descriptor, 'utf8');
    expect(fs.closeSync).toHaveBeenCalledWith(descriptor);
  });

  it('rejects a file replaced between opening and checking its identity', () => {
    actual.writeFileSync(metadataPath, JSON.stringify(receipt));
    let replaced = false;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      const descriptor = actual.openSync(...args);
      if (args[0] === metadataPath && !replaced) {
        replaced = true;
        actual.renameSync(metadataPath, path.join(dir, 'original-metadata.json'));
        actual.writeFileSync(metadataPath, JSON.stringify(receipt));
      }
      return descriptor;
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(replaced).toBe(true);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('reads regular metadata when no-follow opens are unavailable', () => {
    Object.assign(fs.constants, { O_NOFOLLOW: 0, O_NONBLOCK: 0 });
    actual.writeFileSync(metadataPath, JSON.stringify(receipt));

    expect(readEmbeddingRecovery(dir)?.stagingFile).toBe(stagingFile);
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('refuses unverifiable file identity when no-follow opens are unavailable', () => {
    Object.assign(fs.constants, { O_NOFOLLOW: 0, O_NONBLOCK: 0 });
    actual.writeFileSync(metadataPath, JSON.stringify(receipt));
    vi.mocked(fs.fstatSync).mockImplementation((...args) => {
      const stat = actual.fstatSync(...args);
      Object.defineProperty(stat, 'ino', { value: 0n });
      return stat;
    });
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      const stat = actual.lstatSync(...args);
      Object.defineProperty(stat, 'ino', { value: 0n });
      return stat;
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('rejects a symlink introduced before opening without no-follow support', () => {
    Object.assign(fs.constants, { O_NOFOLLOW: 0, O_NONBLOCK: 0 });
    actual.writeFileSync(metadataPath, JSON.stringify({ embeddingCheckpoint: null }));
    const target = path.join(dir, 'foreign-metadata.json');
    actual.writeFileSync(target, JSON.stringify(receipt));
    let replaced = false;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (args[0] === metadataPath && !replaced) {
        replaced = true;
        actual.rmSync(metadataPath);
        actual.symlinkSync(target, metadataPath);
      }
      return actual.openSync(...args);
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(replaced).toBe(true);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('never falls back from a dangling primary symlink without no-follow support', () => {
    Object.assign(fs.constants, { O_NOFOLLOW: 0, O_NONBLOCK: 0 });
    actual.symlinkSync(path.join(dir, 'missing-metadata.json'), metadataPath);
    actual.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(receipt));

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects a symlinked legacy receipt when the primary is absent', () => {
    Object.assign(fs.constants, { O_NOFOLLOW: 0, O_NONBLOCK: 0 });
    const target = path.join(dir, 'foreign-metadata.json');
    actual.writeFileSync(target, JSON.stringify(receipt));
    actual.symlinkSync(target, path.join(dir, 'meta.json'));

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('closes a descriptor when fstat fails without falling back to legacy metadata', () => {
    actual.writeFileSync(metadataPath, JSON.stringify(receipt));
    actual.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(receipt));
    vi.mocked(fs.fstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('stat failed'), { code: 'EIO' });
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it('closes a descriptor when JSON parsing fails without falling back', () => {
    actual.writeFileSync(metadataPath, '{');
    actual.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(receipt));

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')('rejects a substituted FIFO without blocking', () => {
    actual.writeFileSync(metadataPath, JSON.stringify(receipt));
    let replaced = false;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (args[0] === metadataPath && !replaced) {
        replaced = true;
        actual.rmSync(metadataPath);
        execFileSync('mkfifo', [metadataPath]);
      }
      return actual.openSync(...args);
    });

    expect(readEmbeddingRecovery(dir)).toBeUndefined();
    expect(replaced).toBe(true);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });
});
