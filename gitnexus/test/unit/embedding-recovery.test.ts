import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readEmbeddingRecovery,
  resolveEmbeddingRecovery,
} from '../../src/storage/embedding-recovery.js';

const stagingFile = 'lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46';
const checkpoint = () => ({
  kind: 'interrupted',
  at: '2026-10-03T12:00:00.000Z',
  nodesProcessed: 1,
  totalNodes: 3,
  chunksProcessed: 2,
  model: 'test-model',
  dimensions: 2,
  provider: 'local',
  pendingNodeIds: ['active'],
  recovery: {
    stagingFile,
    schemaFingerprint: 'test-schema',
    unsafeNodeIds: ['active', 'incomplete-restore'],
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-embedding-recovery-'));
  writeFileSync(path.join(dir, stagingFile), 'stage');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveEmbeddingRecovery', () => {
  it('resolves the exact staged generation and carries all unsafe node IDs', () => {
    expect(resolveEmbeddingRecovery(dir, checkpoint())).toEqual({
      ...checkpoint().recovery,
      dbPath: path.join(dir, stagingFile),
      familyFiles: ['', '.wal', '.shadow', '.wal.checkpoint', '.lock'].map(
        (suffix) => stagingFile + suffix,
      ),
    });
  });

  it.each([
    '../lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46',
    '/tmp/lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46',
    'branches/foreign/lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46',
    '..\\lbug.staging.6e34c761-bf58-46cc-8b54-78d11607bc46',
    'lbug',
    'lbug.new',
    'lbug.staging.orphan',
    `${stagingFile}.wal`,
    'lbug.staging.00000000-0000-4000-8000-000000000000',
  ])('rejects a foreign, unrecognized or missing generation: %s', (filename) => {
    const marker = checkpoint();
    marker.recovery.stagingFile = filename;
    expect(resolveEmbeddingRecovery(dir, marker)).toBeUndefined();
  });

  it.each([
    null,
    [],
    { recovery: checkpoint().recovery },
    { ...checkpoint(), kind: 'partial' },
    { ...checkpoint(), kind: 'unverified-count' },
    { ...checkpoint(), kind: 'unknown' },
    { ...checkpoint(), at: 'invalid-time' },
    { ...checkpoint(), nodesProcessed: -1 },
    { ...checkpoint(), nodesProcessed: 4 },
    { ...checkpoint(), totalNodes: 1.5 },
    { ...checkpoint(), chunksProcessed: Number.NaN },
    { ...checkpoint(), model: '' },
    { ...checkpoint(), provider: null },
    { ...checkpoint(), dimensions: 0 },
    { ...checkpoint(), pendingNodeIds: [42] },
    { ...checkpoint(), pendingNodeIds: ['unexcluded'] },
    { ...checkpoint(), recovery: { ...checkpoint().recovery, schemaFingerprint: '' } },
    { ...checkpoint(), recovery: { ...checkpoint().recovery, unsafeNodeIds: undefined } },
    { ...checkpoint(), recovery: { ...checkpoint().recovery, unsafeNodeIds: [''] } },
  ])('rejects malformed or incompatible checkpoint shape %#', (marker) => {
    expect(resolveEmbeddingRecovery(dir, marker)).toBeUndefined();
  });

  it('accepts a durable restored stage even before a new embedding window completes', () => {
    expect(
      resolveEmbeddingRecovery(dir, {
        ...checkpoint(),
        nodesProcessed: 0,
        chunksProcessed: 0,
        pendingNodeIds: [],
      }),
    ).toBeDefined();
  });

  it('rejects a directory in place of the staged database', () => {
    rmSync(path.join(dir, stagingFile));
    mkdirSync(path.join(dir, stagingFile));
    expect(resolveEmbeddingRecovery(dir, checkpoint())).toBeUndefined();
  });

  it.each(['', '.wal', '.shadow', '.wal.checkpoint', '.lock'])(
    'rejects a symlink in the staged family: %s',
    (suffix) => {
      const target = path.join(dir, 'external-file');
      writeFileSync(target, 'external');
      const candidate = path.join(dir, stagingFile + suffix);
      rmSync(candidate, { force: true });
      symlinkSync(target, candidate);
      expect(resolveEmbeddingRecovery(dir, checkpoint())).toBeUndefined();
    },
  );

  it('rejects a dangling staged sidecar symlink', () => {
    symlinkSync(path.join(dir, 'missing'), path.join(dir, `${stagingFile}.wal`));
    expect(resolveEmbeddingRecovery(dir, checkpoint())).toBeUndefined();
  });
});

describe('readEmbeddingRecovery', () => {
  const writeMeta = (filename: string, marker: unknown = checkpoint()): void => {
    writeFileSync(path.join(dir, filename), JSON.stringify({ embeddingCheckpoint: marker }));
  };

  it('prefers the primary metadata file over a stale legacy reference', () => {
    writeMeta('gitnexus.json');
    writeMeta('meta.json', null);
    expect(readEmbeddingRecovery(dir)?.stagingFile).toBe(stagingFile);
  });

  it('loads the legacy mirror only when the primary metadata file is absent', () => {
    writeMeta('meta.json');
    expect(readEmbeddingRecovery(dir)?.stagingFile).toBe(stagingFile);
  });

  it('does not resurrect a legacy reference when the primary file is malformed', () => {
    writeFileSync(path.join(dir, 'gitnexus.json'), '{');
    writeMeta('meta.json');
    expect(readEmbeddingRecovery(dir)).toBeUndefined();
  });

  it('does not fall back from valid primary metadata with no recovery reference', () => {
    writeMeta('gitnexus.json', null);
    writeMeta('meta.json');
    expect(readEmbeddingRecovery(dir)).toBeUndefined();
  });

  it('rejects symlinked primary metadata rather than reading a foreign receipt', () => {
    writeMeta('meta.json');
    symlinkSync(path.join(dir, 'meta.json'), path.join(dir, 'gitnexus.json'));
    expect(readEmbeddingRecovery(dir)).toBeUndefined();
  });

  it('resolves branch-slot provenance within that slot despite a flat storagePath', () => {
    const branchSlot = path.join(dir, 'branches', 'feature');
    mkdirSync(branchSlot, { recursive: true });
    writeFileSync(path.join(branchSlot, stagingFile), 'branch-stage');
    writeFileSync(
      path.join(branchSlot, 'gitnexus.json'),
      JSON.stringify({ storagePath: dir, embeddingCheckpoint: checkpoint() }),
    );
    expect(readEmbeddingRecovery(branchSlot)?.dbPath).toBe(path.join(branchSlot, stagingFile));
    expect(readEmbeddingRecovery(dir)).toBeUndefined();
  });
});
