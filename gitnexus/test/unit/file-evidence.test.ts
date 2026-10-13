import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FILE_EVIDENCE_TIMEOUT_MS,
  describeFileEvidence,
  formatFileEvidence,
} from '../../src/core/lbug/sidecar-recovery.js';
import { createTempDir } from '../helpers/test-db.js';

describe('formatFileEvidence (#3530)', () => {
  it.each([
    [
      'allocated bytes below the apparent size (sparse-like)',
      { size: 1048576, blocks: 0, fsType: 0xef53 },
      'staging: apparent 1048576 B, allocated 0 B, filesystem type 0xef53',
    ],
    [
      'allocated bytes equal to the apparent size',
      { size: 8192, blocks: 16, fsType: 0x58465342 },
      'staging: apparent 8192 B, allocated 8192 B, filesystem type 0x58465342',
    ],
    [
      'blocks the platform does not report',
      { size: 100, fsType: 0x794c7630 },
      'staging: apparent 100 B, allocated unknown, filesystem type 0x794c7630',
    ],
    [
      'a filesystem type that could not be read',
      { size: 100, blocks: 1 },
      'staging: apparent 100 B, allocated 512 B, filesystem type unknown',
    ],
  ])('formats %s', (_label, input, expected) => {
    expect(formatFileEvidence('staging', input)).toBe(expected);
  });

  it('reports a file that could not be inspected as unavailable', () => {
    expect(formatFileEvidence('live', undefined)).toBe('live: unavailable');
  });

  it('reports a missing file as absent, distinct from unavailable', () => {
    expect(formatFileEvidence('live', 'absent')).toBe('live: absent');
  });

  it('reports a stalled stat as unavailable with the deadline that elapsed', () => {
    expect(formatFileEvidence('live', 'timeout')).toBe(
      `live: unavailable (timed out after ${FILE_EVIDENCE_TIMEOUT_MS} ms)`,
    );
  });
});

describe('describeFileEvidence (#3530)', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let dir: string;

  beforeEach(async () => {
    temp = await createTempDir('file-evidence-');
    dir = temp.dbPath;
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('reports a missing path as absent instead of throwing', async () => {
    await expect(describeFileEvidence('live', path.join(dir, 'missing'))).resolves.toBe(
      'live: absent',
    );
  });

  it('reports the real apparent size of an existing file', async () => {
    const file = path.join(dir, 'lbug');
    await fs.writeFile(file, 'hello');
    // Allocated bytes and the filesystem type depend on the host filesystem, so
    // only the apparent size is asserted.
    await expect(describeFileEvidence('live', file)).resolves.toMatch(/^live: apparent 5 B, /);
  });

  it('reports a path that fails for a reason other than absence as unavailable', async () => {
    // A regular file used as a directory component fails with ENOTDIR, not ENOENT.
    const file = path.join(dir, 'lbug');
    await fs.writeFile(file, 'hello');
    await expect(describeFileEvidence('live', path.join(file, 'child'))).resolves.toBe(
      'live: unavailable',
    );
  });

  it('leaves no timer behind once the stat answers', async () => {
    vi.useFakeTimers();
    try {
      const file = path.join(dir, 'lbug');
      await fs.writeFile(file, 'hello');
      await describeFileEvidence('live', file);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('against a stalled filesystem', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('gives up on a stat that never resolves once the deadline elapses', async () => {
      vi.spyOn(fs, 'stat').mockReturnValue(new Promise<never>(() => {}));
      vi.spyOn(fs, 'statfs').mockReturnValue(new Promise<never>(() => {}));

      const evidence = describeFileEvidence('live', path.join(dir, 'lbug'));
      await vi.advanceTimersByTimeAsync(FILE_EVIDENCE_TIMEOUT_MS);

      await expect(evidence).resolves.toBe(
        `live: unavailable (timed out after ${FILE_EVIDENCE_TIMEOUT_MS} ms)`,
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not resolve before the deadline', async () => {
      vi.spyOn(fs, 'stat').mockReturnValue(new Promise<never>(() => {}));
      vi.spyOn(fs, 'statfs').mockReturnValue(new Promise<never>(() => {}));
      const settled = vi.fn();

      void describeFileEvidence('live', path.join(dir, 'lbug')).then(settled);
      await vi.advanceTimersByTimeAsync(FILE_EVIDENCE_TIMEOUT_MS - 1);

      expect(settled).not.toHaveBeenCalled();
    });

    it('keeps the size evidence when only statfs stalls', async () => {
      const file = path.join(dir, 'lbug');
      await fs.writeFile(file, 'hello');
      // Resolve stat from a captured value: a real stat would still be in flight
      // when the fake clock jumps past the deadline.
      vi.spyOn(fs, 'stat').mockResolvedValue(await fs.stat(file));
      vi.spyOn(fs, 'statfs').mockReturnValue(new Promise<never>(() => {}));

      const evidence = describeFileEvidence('live', file);
      await vi.advanceTimersByTimeAsync(FILE_EVIDENCE_TIMEOUT_MS);

      await expect(evidence).resolves.toMatch(/^live: apparent 5 B, .*filesystem type unknown$/);
    });
  });
});
