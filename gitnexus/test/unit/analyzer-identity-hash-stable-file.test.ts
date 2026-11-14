import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzerIdentityArtifacts } from '../../src/core/analyzer-identity.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
  };
});

const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('hashStableFile (#3932)', () => {
  afterEach(() => {
    vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
  });

  it('succeeds when stat and fstat dev differ but ino, size, and mtime match (Windows st_dev mismatch)', () => {
    const tempDir = actual.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    const testFile = path.join(tempDir, 'sample.txt');
    try {
      actual.writeFileSync(testFile, 'hello world test content');

      // Simulate Windows behavior: statSync/lstatSync returns dev = 0,
      // while fstatSync returns NTFS volume serial number (non-zero).
      vi.mocked(fs.fstatSync).mockImplementation(((descriptor: number, options?: any) => {
        const real = actual.fstatSync(descriptor, options as any);
        if (typeof real === 'object' && real !== null && 'dev' in real) {
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === 'dev') {
                return typeof target.dev === 'bigint' ? 987654321n : 987654321;
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return real;
      }) as typeof fs.fstatSync);

      const result = analyzerIdentityArtifacts.hashStableFile(testFile);
      expect(result).toBeDefined();
      expect(result.bytes).toBe(24);
      expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      actual.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still fails when ino differs between stat and fstat (real TOCTOU race)', () => {
    const tempDir = actual.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    const testFile = path.join(tempDir, 'sample.txt');
    try {
      actual.writeFileSync(testFile, 'hello world test content');

      vi.mocked(fs.fstatSync).mockImplementation(((descriptor: number, options?: any) => {
        const real = actual.fstatSync(descriptor, options as any);
        if (typeof real === 'object' && real !== null && 'ino' in real) {
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === 'ino') {
                return typeof target.ino === 'bigint' ? target.ino + 1n : Number(target.ino) + 1;
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return real;
      }) as typeof fs.fstatSync);

      expect(() => analyzerIdentityArtifacts.hashStableFile(testFile)).toThrow(
        /Analyzer identity input changed while it was being hashed/,
      );
    } finally {
      actual.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still fails when mtime differs between stat and fstat', () => {
    const tempDir = actual.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    const testFile = path.join(tempDir, 'sample.txt');
    try {
      actual.writeFileSync(testFile, 'hello world test content');

      vi.mocked(fs.fstatSync).mockImplementation(((descriptor: number, options?: any) => {
        const real = actual.fstatSync(descriptor, options as any);
        if (typeof real === 'object' && real !== null && 'mtimeNs' in real) {
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === 'mtimeNs') {
                return typeof target.mtimeNs === 'bigint'
                  ? target.mtimeNs + 1_000_000n
                  : Number(target.mtimeNs) + 1_000_000;
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return real;
      }) as typeof fs.fstatSync);

      expect(() => analyzerIdentityArtifacts.hashStableFile(testFile)).toThrow(
        /Analyzer identity input changed while it was being hashed/,
      );
    } finally {
      actual.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
