/**
 * Behavioural cover for `writeFileAtomic` — the single home of the tmp+rename
 * publish shape (#2888, #1318 U6). The properties asserted here are what the
 * source-text guards in test/unit/group/insecure-tempfile.test.ts used to
 * approximate by regex, for three separate copies of the sequence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, writeFileAtomicBytes, writeFileAtomicBytesSync } from '../../../src/storage/fs-atomic.js';
import { createTempDir } from '../../helpers/test-db.js';

describe('writeFileAtomic', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;
  let target: string;

  beforeEach(async () => {
    tmp = await createTempDir('gitnexus-fs-atomic-');
    target = path.join(tmp.dbPath, 'thing.json');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const leftovers = async (): Promise<string[]> =>
    (await fs.readdir(tmp.dbPath)).filter((f) => f !== path.basename(target));

  it('publishes the data and leaves no tmp file behind', async () => {
    await writeFileAtomic(target, '{"a":1}');

    expect(await fs.readFile(target, 'utf-8')).toBe('{"a":1}');
    expect(await leftovers()).toEqual([]);
  });

  it('creates the file user-only, whatever the umask is', async () => {
    await writeFileAtomic(target, 'secret');

    const mode = (await fs.stat(target)).mode & 0o777;
    // Windows does not carry POSIX permission bits; the mode argument is the
    // part CodeQL's js/insecure-temporary-file query credits either way.
    expect(process.platform === 'win32' ? 0o600 : mode).toBe(0o600);
  });

  it('lets concurrent publishers to one target all succeed', async () => {
    // The #2888 shape: with a shared tmp path the loser's rename finds nothing
    // at the source and rejects with ENOENT.
    await expect(
      Promise.all([
        writeFileAtomic(target, '"a"'),
        writeFileAtomic(target, '"b"'),
        writeFileAtomic(target, '"c"'),
      ]),
    ).resolves.toHaveLength(3);

    expect(['"a"', '"b"', '"c"']).toContain(await fs.readFile(target, 'utf-8'));
    expect(await leftovers()).toEqual([]);
  });

  it('removes the tmp file and keeps the previous content when the publish fails', async () => {
    await writeFileAtomic(target, 'first');
    // A directory at the target makes the rename fail (EISDIR/EPERM/ENOTEMPTY,
    // by platform) without mocking anything.
    const blocked = path.join(tmp.dbPath, 'blocked');
    await fs.mkdir(path.join(blocked, 'child'), { recursive: true });

    await expect(writeFileAtomic(blocked, 'second')).rejects.toThrow();

    expect(await fs.readFile(target, 'utf-8')).toBe('first');
    // readdir order is unspecified — sort so the assertion is deterministic.
    expect((await fs.readdir(tmp.dbPath)).sort()).toEqual(['blocked', 'thing.json']);
  });
});

describe('writeFileAtomicBytes', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;
  let target: string;

  beforeEach(async () => {
    tmp = await createTempDir('gitnexus-fs-atomic-bin-');
    target = path.join(tmp.dbPath, 'thing.bin');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('publishes binary data and leaves no tmp file behind', async () => {
    const bytes = Buffer.from([0, 1, 255, 10]);
    await writeFileAtomicBytes(target, bytes);
    expect(Buffer.from(await fs.readFile(target))).toEqual(bytes);
    expect((await fs.readdir(tmp.dbPath)).filter((f) => f !== 'thing.bin')).toEqual([]);
  });

  it('writeFileAtomicBytesSync publishes the same bytes', async () => {
    const bytes = Buffer.from('hello');
    writeFileAtomicBytesSync(target, bytes);
    expect(Buffer.from(await fs.readFile(target))).toEqual(bytes);
  });
});
