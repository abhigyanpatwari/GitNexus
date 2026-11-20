import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzerIdentityArtifacts } from '../../src/core/analyzer-identity.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    fstatSync: vi.fn(actual.fstatSync),
  };
});

const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const content = 'hello world test content';
const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
const changedInput = /Analyzer identity input changed while it was being hashed/;

describe('hashStableFile (#3932)', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    tempDir = actual.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-'));
    testFile = path.join(tempDir, 'sample.txt');
    actual.writeFileSync(testFile, content);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync);
    vi.mocked(fs.fstatSync).mockReset().mockImplementation(actual.fstatSync);
    actual.rmSync(tempDir, { recursive: true, force: true });
  });

  function mockFileStats(
    platform: NodeJS.Platform,
    pathDevice: bigint,
    descriptorState: Partial<fs.BigIntStats>,
  ): void {
    vi.stubGlobal('process', { ...process, platform });
    vi.mocked(fs.lstatSync).mockImplementation(((candidate: fs.PathLike) =>
      Object.assign(actual.lstatSync(candidate, { bigint: true }), {
        dev: pathDevice,
      })) as typeof fs.lstatSync);
    vi.mocked(fs.fstatSync).mockImplementation(((descriptor: number) =>
      Object.assign(
        actual.fstatSync(descriptor, { bigint: true }),
        descriptorState,
      )) as typeof fs.fstatSync);
  }

  it('hashes a real file on the host platform', () => {
    expect(analyzerIdentityArtifacts.hashStableFile(testFile)).toMatchObject({
      bytes: Buffer.byteLength(content),
      digest,
    });
  });

  it('hashes only the bytes read when a large file is followed by a short or empty file', () => {
    for (const payload of [Buffer.alloc(300_000, 0x5a), Buffer.from([0, 0x91]), Buffer.alloc(0)]) {
      actual.writeFileSync(testFile, payload);
      expect(analyzerIdentityArtifacts.hashStableFile(testFile)).toMatchObject({
        bytes: payload.length,
        digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      });
    }
  });

  it('accepts the Windows zero-device snapshot without changing the stored state', () => {
    mockFileStats('win32', 0n, { dev: 987654321n });

    expect(analyzerIdentityArtifacts.hashStableFile(testFile)).toMatchObject({
      bytes: Buffer.byteLength(content),
      digest,
      state: { link: { dev: '0' }, target: { dev: '0' } },
    });
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'accepts matching device IDs on %s',
    (platform) => {
      mockFileStats(platform, 123n, { dev: 123n });
      expect(analyzerIdentityArtifacts.hashStableFile(testFile).digest).toBe(digest);
    },
  );

  it.each([
    ['linux', 0n],
    ['linux', 123n],
    ['darwin', 0n],
    ['darwin', 123n],
    ['win32', 123n],
  ] as const)('rejects a different device on %s when the path reports %s', (platform, dev) => {
    mockFileStats(platform, dev, { dev: 987654321n });
    expect(() => analyzerIdentityArtifacts.hashStableFile(testFile)).toThrow(changedInput);
  });

  it.each(['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)(
    'still rejects a changed %s with the Windows workaround',
    (field) => {
      const before = actual.lstatSync(testFile, { bigint: true });
      mockFileStats('win32', 0n, { dev: 987654321n, [field]: before[field] + 1n });
      expect(() => analyzerIdentityArtifacts.hashStableFile(testFile)).toThrow(changedInput);
    },
  );

  it('still rejects descriptor device changes during hashing on Windows', () => {
    mockFileStats('win32', 0n, { dev: 123n });
    let calls = 0;
    vi.mocked(fs.fstatSync).mockImplementation(((descriptor: number) =>
      Object.assign(actual.fstatSync(descriptor, { bigint: true }), {
        dev: ++calls % 2 === 1 ? 123n : 456n,
      })) as typeof fs.fstatSync);

    expect(() => analyzerIdentityArtifacts.hashStableFile(testFile)).toThrow(changedInput);
  });
});
