/**
 * Behavioural cover for `writeFileAtomic` — the single home of the tmp+rename
 * publish shape (#2888, #1318 U6). The properties asserted here are what the
 * source-text guards in test/unit/group/insecure-tempfile.test.ts used to
 * approximate by regex, for three separate copies of the sequence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  linkOrCopyFile,
  writeFileAtomic,
  writeFileAtomicBytes,
  writeFileAtomicBytesSync,
} from '../../../src/storage/fs-atomic.js';
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

describe('linkOrCopyFile (#3090)', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    tmp = await createTempDir('gitnexus-link-or-copy-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tmp.cleanup();
  });

  const hardlinksWork = async (): Promise<boolean> => {
    const a = path.join(tmp.dbPath, '.probe-a');
    const b = path.join(tmp.dbPath, '.probe-b');
    await fs.writeFile(a, 'x');
    try {
      await fs.link(a, b);
      return true;
    } catch {
      return false;
    }
  };

  it('hardlinks when the filesystem allows it', async () => {
    if (!(await hardlinksWork())) return;
    const src = path.join(tmp.dbPath, 'src.bin');
    const dst = path.join(tmp.dbPath, 'dst.bin');
    await fs.writeFile(src, 'payload');
    await linkOrCopyFile(src, dst);
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dst)]);
    expect(d.ino).toBe(s.ino);
    expect(s.nlink).toBe(2);
    expect(await fs.readFile(dst, 'utf-8')).toBe('payload');
  });

  it('falls back to tmp+rename when link reports EXDEV', async () => {
    const src = path.join(tmp.dbPath, 'src.bin');
    const dst = path.join(tmp.dbPath, 'dst.bin');
    await fs.writeFile(src, 'payload');
    const err = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    vi.spyOn(fs, 'link').mockRejectedValue(err);
    await linkOrCopyFile(src, dst);
    expect(await fs.readFile(dst, 'utf-8')).toBe('payload');
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dst)]);
    if (s.ino !== 0) expect(d.ino).not.toBe(s.ino);
    expect(s.nlink).toBe(1);
    expect((await fs.readdir(tmp.dbPath)).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('replaces an existing dest via rename without touching src', async () => {
    const src = path.join(tmp.dbPath, 'src.bin');
    const dst = path.join(tmp.dbPath, 'dst.bin');
    await fs.writeFile(src, 'new-bytes');
    await fs.writeFile(dst, 'old-bytes');
    await linkOrCopyFile(src, dst);
    expect(await fs.readFile(dst, 'utf-8')).toBe('new-bytes');
    expect(await fs.readFile(src, 'utf-8')).toBe('new-bytes');
  });

  it('does not write through a dest that is already a hardlink to other durable bytes', async () => {
    if (!(await hardlinksWork())) return;
    const durable = path.join(tmp.dbPath, 'durable.bin');
    const dst = path.join(tmp.dbPath, 'dst.bin');
    const src = path.join(tmp.dbPath, 'src.bin');
    await fs.writeFile(durable, 'DURABLE');
    await fs.link(durable, dst);
    await fs.writeFile(src, 'FRESH');
    const before = await fs.stat(durable);
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('exdev'), { code: 'EXDEV' }));
    await linkOrCopyFile(src, dst);
    const after = await fs.stat(durable);
    expect(await fs.readFile(durable, 'utf-8')).toBe('DURABLE');
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(1);
    expect(await fs.readFile(dst, 'utf-8')).toBe('FRESH');
    expect((await fs.stat(dst)).ino).not.toBe(before.ino);
  });
});
