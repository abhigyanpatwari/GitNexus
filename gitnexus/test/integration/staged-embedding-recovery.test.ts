import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeEmbeddingSpill,
  materializeCachedEmbeddings,
  type CachedEmbeddingsSnapshot,
} from '../../src/core/embeddings/embedding-restore-spill.js';
import { recoverStagedEmbeddings } from '../../src/core/embeddings/staged-embedding-recovery.js';

describe('isolated native staged embedding recovery', () => {
  let tmp: string | undefined;
  let recovered: CachedEmbeddingsSnapshot | undefined;
  afterEach(() => {
    disposeEmbeddingSpill(recovered?.spill);
    recovered = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  function stagePath() {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-stage-native-'));
    return path.join(tmp, `lbug.staging.${randomUUID()}`);
  }
  function seed(dbPath: string, mode = 'clean') {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../fixtures/staged-embedding-recovery/seed.mjs', import.meta.url)),
        dbPath,
        mode,
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, GITNEXUS_LBUG_BUFFER_POOL_SIZE: String(128 * 1024 * 1024) },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    if (mode === 'hard-kill') expect(result.signal, result.stderr).toBe('SIGKILL');
    else expect(result.status, result.stderr).toBe(0);
  }

  it('streams complete same-hash groups and rejects malformed whole nodes', async () => {
    const dbPath = stagePath();
    seed(dbPath);
    recovered = await recoverStagedEmbeddings(dbPath, { dimensions: 2 });
    expect([...recovered.embeddingNodeIds].sort()).toEqual(['complete', 'other']);
    expect(recovered.rows).toHaveLength(3);
    expect(recovered.embeddings).toEqual([]);
    expect(materializeCachedEmbeddings(recovered, recovered.rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'complete',
          chunkIndex: 0,
          embedding: [1, 2],
          contentHash: 'same',
        }),
        expect.objectContaining({
          nodeId: 'complete',
          chunkIndex: 1,
          embedding: [1, 2],
          contentHash: 'same',
        }),
      ]),
    );
    expect(fs.existsSync(dbPath)).toBe(true);
  }, 30_000);

  it('replays a hard-killed native writer strictly and excludes the incomplete active window', async () => {
    const dbPath = stagePath();
    seed(dbPath, 'hard-kill');
    recovered = await recoverStagedEmbeddings(dbPath, {
      dimensions: 2,
      excludedNodeIds: ['unsafe-prefix', 'other'],
    });
    expect([...recovered.embeddingNodeIds]).toEqual(['complete']);
    expect(recovered.rows).toHaveLength(2);
    expect(
      materializeCachedEmbeddings(recovered, recovered.rows)
        .map((row) => row.chunkIndex)
        .sort(),
    ).toEqual([0, 1]);
  }, 30_000);

  it('rejects vectors from a different dimension instead of coercing them', async () => {
    const dbPath = stagePath();
    seed(dbPath);
    recovered = await recoverStagedEmbeddings(dbPath, { dimensions: 3 });
    expect(recovered.rows).toEqual([]);
  }, 30_000);

  it('contains a malformed native source in a subprocess and preserves it', async () => {
    const dbPath = stagePath();
    fs.writeFileSync(dbPath, 'not a ladybug database');
    await expect(recoverStagedEmbeddings(dbPath, { dimensions: 2 })).rejects.toThrow(
      /extraction failed/,
    );
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('not a ladybug database');
  }, 30_000);

  it('rejects a malformed WAL without deleting or quarantining it to reopen the source', async () => {
    const dbPath = stagePath();
    seed(dbPath, 'hard-kill');
    const walPath = `${dbPath}.wal`;
    fs.writeFileSync(walPath, Buffer.alloc(128, 0xff));
    await expect(recoverStagedEmbeddings(dbPath, { dimensions: 2 })).rejects.toThrow(
      /extraction failed/,
    );
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(dbPath)).some((name) => /bad|quarantine/i.test(name))).toBe(
      false,
    );
  }, 30_000);

  it('does not create a missing source and refuses a symlink', async () => {
    const dbPath = stagePath();
    await expect(recoverStagedEmbeddings(dbPath, { dimensions: 2 })).rejects.toThrow(/ENOENT/);
    expect(fs.existsSync(dbPath)).toBe(false);
    const realPath = path.join(path.dirname(dbPath), 'real');
    fs.writeFileSync(realPath, 'fixture');
    fs.symlinkSync(realPath, dbPath);
    await expect(recoverStagedEmbeddings(dbPath, { dimensions: 2 })).rejects.toThrow(
      /regular file/,
    );
  });

  it('can kill a timed out native subprocess without aborting analyze', async () => {
    const dbPath = stagePath();
    seed(dbPath);
    await expect(recoverStagedEmbeddings(dbPath, { dimensions: 2, timeoutMs: 1 })).rejects.toThrow(
      /timeout/,
    );
    expect(fs.existsSync(dbPath)).toBe(true);
  }, 30_000);

  it('loads the source child when analyze runs in another repository directory', () => {
    const dbPath = stagePath();
    seed(dbPath);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        'const { recoverStagedEmbeddings } = await import(process.argv[1]); const { disposeEmbeddingSpill } = await import(process.argv[2]); const recovered = await recoverStagedEmbeddings(process.argv[3], {dimensions: 2}); process.stdout.write(String(recovered.rows.length)); disposeEmbeddingSpill(recovered.spill);',
        new URL('../../src/core/embeddings/staged-embedding-recovery.ts', import.meta.url).href,
        new URL('../../src/core/embeddings/embedding-restore-spill.ts', import.meta.url).href,
        dbPath,
      ],
      { cwd: path.dirname(dbPath), encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('3');
  }, 30_000);
});
