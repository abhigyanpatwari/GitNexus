import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptEmbeddingArtifact,
  readEmbeddingArtifactSpace,
  readEmbeddingArtifactOwners,
  embeddingArtifactSpaceKey,
  type EmbeddingArtifactOwner,
  type EmbeddingArtifactRecord,
} from '../../src/storage/embedding-artifact.js';
import * as records from '../../src/storage/embedding-job.js';

const space = {
  vectorIdentity: 'a'.repeat(64),
  inputIdentity: 'b'.repeat(64),
  dimensions: 4,
  schema: 'gitnexus-vector-store-v2',
};
const owner = (digit: string): EmbeddingArtifactOwner => ({
  artifactIdentity: 'c'.repeat(64),
  jobIdentity: digit.repeat(64),
  graphGeneration: digit.repeat(32),
  sourceIdentity: digit.repeat(64),
  manifestDigest: digit.repeat(64),
  phase: 'pending',
  revalidateInputs: true,
});
let root: string;
let validate: ReturnType<typeof vi.fn<(owner: EmbeddingArtifactOwner) => Promise<void>>>;
const directory = () => path.join(root, 'embeddings', 'spaces', embeddingArtifactSpaceKey(space));
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-artifact-'));
  validate = vi.fn(async () => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('pending embedding artifact ownership', () => {
  it('does not create ownership directories for a missing space', async () => {
    expect(await readEmbeddingArtifactSpace(root, space, validate)).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  it('ignores an empty interrupted space but retains unidentified contents', async () => {
    await fs.mkdir(directory(), { recursive: true });
    expect(await readEmbeddingArtifactOwners(root)).toEqual([]);
    await fs.writeFile(path.join(directory(), 'unknown'), 'retain');
    await expect(readEmbeddingArtifactOwners(root)).rejects.toThrow('no ownership receipt');
    expect(await fs.readFile(path.join(directory(), 'unknown'), 'utf8')).toBe('retain');
  });

  it('keeps one artifact through repeated source generations without enumerating job history', async () => {
    vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('History scan'));
    vi.spyOn(fs, 'opendir').mockRejectedValue(new Error('History scan'));
    let record = await readEmbeddingArtifactSpace(root, space, validate);
    expect(record).toBeNull();
    for (const digit of ['1', '2', '3']) {
      record = await adoptEmbeddingArtifact(root, space, record, owner(digit), validate);
      expect(record.owner.artifactIdentity).toBe('c'.repeat(64));
      expect((await readEmbeddingArtifactSpace(root, space, validate))?.owner.jobIdentity).toBe(
        digit.repeat(64),
      );
    }
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(fs.opendir).not.toHaveBeenCalled();
  });

  it.each(['before-owner', 'after-owner'] as const)(
    'recovers a crash %s without losing ownership',
    async (point) => {
      const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
      if (point === 'before-owner') {
        const write = records.writeEmbeddingJobRecord;
        vi.spyOn(records, 'writeEmbeddingJobRecord').mockImplementation(
          async (dir, name, payload) => {
            if (name === 'space.json') throw new Error('Crash before owner');
            await write(dir, name, payload);
          },
        );
      } else {
        vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('Crash after owner'));
      }
      await expect(
        adoptEmbeddingArtifact(root, space, first, owner('2'), validate),
      ).rejects.toThrow('Crash');
      vi.restoreAllMocks();
      const recovered = await readEmbeddingArtifactSpace(root, space, validate);
      expect(recovered?.owner).toEqual(owner('2'));
      expect(await readEmbeddingArtifactSpace(root, space, validate)).toEqual(recovered);
      await expect(fs.stat(path.join(directory(), 'rebase.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('leaves the old owner unchanged if the new manifest cannot be verified', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    validate.mockRejectedValueOnce(new Error('Missing manifest'));
    await expect(adoptEmbeddingArtifact(root, space, first, owner('2'), validate)).rejects.toThrow(
      'Missing manifest',
    );
    expect(await readEmbeddingArtifactSpace(root, space, validate)).toEqual(first);
  });

  it('refuses a stale owner instead of overwriting a later adoption', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    const second = await adoptEmbeddingArtifact(root, space, first, owner('2'), validate);
    await expect(adoptEmbeddingArtifact(root, space, first, owner('3'), validate)).rejects.toThrow(
      'ownership changed',
    );
    expect(await readEmbeddingArtifactSpace(root, space, validate)).toEqual(second);
  });

  it('refuses an intent whose before and after owners have both been superseded', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    const second: EmbeddingArtifactRecord = { ...first, owner: owner('2') };
    await records.writeEmbeddingJobRecord(directory(), 'rebase.json', {
      version: 1,
      before: first,
      after: second,
    });
    await records.writeEmbeddingJobRecord(directory(), 'space.json', {
      ...first,
      owner: owner('3'),
    });
    await expect(readEmbeddingArtifactSpace(root, space, validate)).rejects.toThrow('superseded');
    expect(await records.readEmbeddingJobRecord(directory(), 'rebase.json')).toEqual({
      version: 1,
      before: first,
      after: second,
    });
  });

  it('requires input revalidation and keeps a pending paid artifact instead of replacing it', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    await expect(
      adoptEmbeddingArtifact(
        root,
        space,
        first,
        { ...owner('2'), revalidateInputs: false },
        validate,
      ),
    ).rejects.toThrow('current-input validation');
    await expect(
      adoptEmbeddingArtifact(
        root,
        space,
        first,
        { ...owner('2'), artifactIdentity: 'd'.repeat(64) },
        validate,
      ),
    ).rejects.toThrow('retained until sealed');
    expect(await readEmbeddingArtifactSpace(root, space, validate)).toEqual(first);
  });

  it('starts a new writer after sealing and retains the completed artifact as its sole fallback', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    const sealed = await adoptEmbeddingArtifact(
      root,
      space,
      first,
      { ...first.owner, phase: 'sealed' },
      validate,
    );
    await expect(adoptEmbeddingArtifact(root, space, sealed, owner('2'), validate)).rejects.toThrow(
      'Rebased artifact',
    );
    const next = await adoptEmbeddingArtifact(
      root,
      space,
      sealed,
      {
        ...owner('2'),
        artifactIdentity: 'd'.repeat(64),
        fallbackArtifact: first.owner.artifactIdentity,
      },
      validate,
    );
    expect(next.owner.fallbackArtifact).toBe(first.owner.artifactIdentity);
    expect(next.owner.artifactIdentity).not.toBe(first.owner.artifactIdentity);
  });

  it('keeps incompatible input spaces independently owned and directly addressable', async () => {
    const first = await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    const other = { ...space, inputIdentity: 'd'.repeat(64) };
    expect(await readEmbeddingArtifactSpace(root, other, validate)).toBeNull();
    await adoptEmbeddingArtifact(
      root,
      other,
      null,
      { ...owner('2'), artifactIdentity: 'e'.repeat(64) },
      validate,
    );
    expect(await readEmbeddingArtifactSpace(root, space, validate)).toEqual(first);
  });

  it('retains corrupt receipts and rejects a symlinked space directory', async () => {
    await adoptEmbeddingArtifact(root, space, null, owner('1'), validate);
    const file = path.join(directory(), 'space.json');
    await fs.writeFile(file, '{"checksum":"bad","payload":{}}');
    await expect(readEmbeddingArtifactSpace(root, space, validate)).rejects.toThrow(
      'checksum mismatch',
    );
    expect(await fs.readFile(file, 'utf8')).toContain('"bad"');
    const other = { ...space, inputIdentity: 'e'.repeat(64) };
    await fs.symlink(
      directory(),
      path.join(root, 'embeddings', 'spaces', embeddingArtifactSpaceKey(other)),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(readEmbeddingArtifactSpace(root, other, validate)).rejects.toThrow(
      'owned directory',
    );
  });
});
