import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describeFileEvidence, formatFileEvidence } from '../../src/core/lbug/sidecar-recovery.js';
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

  it('returns the unavailable token for a missing path instead of throwing', async () => {
    await expect(describeFileEvidence('live', path.join(dir, 'missing'))).resolves.toBe(
      'live: unavailable',
    );
  });

  it('reports the real apparent size of an existing file', async () => {
    const file = path.join(dir, 'lbug');
    await fs.writeFile(file, 'hello');
    // Allocated bytes and the filesystem type depend on the host filesystem, so
    // only the apparent size is asserted.
    await expect(describeFileEvidence('live', file)).resolves.toMatch(/^live: apparent 5 B, /);
  });
});
