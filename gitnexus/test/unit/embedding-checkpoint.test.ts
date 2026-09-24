import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_RESUME_MAX_ATTEMPTS,
  checkpointKind,
  decideEmbeddingResume,
  nextAttemptCount,
} from '../../src/core/embedding-checkpoint.js';
import type { EmbeddingCheckpoint } from '../../src/core/embedding-checkpoint.js';

/**
 * ── #2790 review: ONE owner of `RepoMeta.embeddingCheckpoint` ──────────
 *
 * The record was minted at five sites across two layers and READ by two gates
 * that disagreed: only the CLI implemented `kind`, so a `'partial'` marker
 * written by `gitnexus analyze` and resumed through `POST /api/embed` hit the
 * permanent wedge `kind` exists to remove. These pin the shared decision both
 * callers now route through.
 */

const identity = { model: 'text-embedding-3-small', dimensions: 1536, provider: 'http:abc' };
const foreign = { model: 'all-MiniLM-L6-v2', dimensions: 384, provider: 'local' };

const checkpoint = (over: Partial<EmbeddingCheckpoint> = {}): EmbeddingCheckpoint => ({
  at: '2026-08-02T00:00:00.000Z',
  nodesProcessed: 10,
  totalNodes: 12,
  chunksProcessed: 40,
  model: identity.model,
  dimensions: identity.dimensions,
  provider: identity.provider,
  pendingNodeIds: ['node-a', 'node-b'],
  ...over,
});

describe('checkpointKind', () => {
  it('defaults an absent kind to interrupted, so pre-#2790 markers keep the strict path', () => {
    expect(checkpointKind(checkpoint({ kind: undefined }))).toBe('interrupted');
  });
});

describe('decideEmbeddingResume — identity gate', () => {
  it('resumes a matching identity', () => {
    expect(decideEmbeddingResume(checkpoint({ kind: 'interrupted' }), identity)).toMatchObject({
      action: 'resume',
      pendingNodeIds: new Set(['node-a', 'node-b']),
    });
  });

  it('fails closed on a foreign identity for an interrupted marker', () => {
    expect(decideEmbeddingResume(checkpoint({ kind: 'interrupted' }), foreign)).toMatchObject({
      action: 'abort',
      error: expect.stringMatching(/provider configuration differs/i),
    });
  });

  /**
   * REGRESSION (caught by an apply agent, and by `run-analyze.test.ts`): the
   * first cut of `decideEmbeddingResume` short-circuited on `pending === 0`
   * BEFORE the identity gate, assuming an empty set meant the
   * 'unverified-count' marker. It does not — `onCheckpoint` mints an
   * 'interrupted' marker with `pendingNodeIds: []` after every post-window
   * save — so an interrupted marker under a foreign provider was silently
   * cleared instead of failing closed.
   */
  it('fails closed on a foreign identity even when the interrupted marker names no pending nodes', () => {
    expect(
      decideEmbeddingResume(checkpoint({ kind: 'interrupted', pendingNodeIds: [] }), foreign),
    ).toMatchObject({ action: 'abort' });
  });

  it('fails closed for a legacy marker that omits both kind and pendingNodeIds', () => {
    expect(
      decideEmbeddingResume(checkpoint({ kind: undefined, pendingNodeIds: undefined }), foreign),
    ).toMatchObject({ action: 'abort' });
  });

  it('still resumes an empty interrupted marker once the identity matches', () => {
    expect(
      decideEmbeddingResume(checkpoint({ kind: 'interrupted', pendingNodeIds: [] }), identity),
    ).toMatchObject({ action: 'resume', pendingNodeIds: new Set() });
  });

  it('abandons a partial marker under a foreign identity instead of wedging the repo', () => {
    expect(decideEmbeddingResume(checkpoint({ kind: 'partial' }), foreign)).toMatchObject({
      action: 'abandon',
      log: expect.stringMatching(/hold no embedding rows/i),
    });
  });
});

describe('decideEmbeddingResume — unverified-count', () => {
  it('abandons without consulting the identity, having nothing to corrupt', () => {
    expect(
      decideEmbeddingResume(
        checkpoint({ kind: 'unverified-count', pendingNodeIds: [] }),
        undefined,
      ),
    ).toMatchObject({ action: 'abandon', log: expect.stringMatching(/re-deriving/i) });
  });
});

describe('decideEmbeddingResume — flags and the retry bound', () => {
  it.each([
    ['dropEmbeddings', { dropEmbeddings: true }, /--drop-embeddings/],
    ['force', { force: true }, /--force/],
  ])('discards on %s', (_name, options, pattern) => {
    expect(decideEmbeddingResume(checkpoint(), identity, options)).toMatchObject({
      action: 'discard',
      log: expect.stringMatching(pattern),
    });
  });

  it('abandons a partial set that has spent its attempt budget', () => {
    expect(
      decideEmbeddingResume(
        checkpoint({ kind: 'partial', attempts: EMBEDDING_RESUME_MAX_ATTEMPTS }),
        identity,
      ),
    ).toMatchObject({ action: 'abandon', log: expect.stringMatching(/consecutive/i) });
  });

  it('still resumes one attempt below the budget', () => {
    expect(
      decideEmbeddingResume(
        checkpoint({ kind: 'partial', attempts: EMBEDDING_RESUME_MAX_ATTEMPTS - 1 }),
        identity,
      ),
    ).toMatchObject({ action: 'resume' });
  });
});

describe('nextAttemptCount', () => {
  it('advances only when a node it was handed fails again', () => {
    expect(nextAttemptCount(checkpoint({ kind: 'partial', attempts: 1 }), ['node-a'])).toBe(2);
  });

  it('resets when the resume cleared its set and lost different nodes', () => {
    expect(nextAttemptCount(checkpoint({ kind: 'partial', attempts: 2 }), ['node-z'])).toBe(
      undefined,
    );
  });

  it('does not advance off an interrupted marker — the bound is a partial-only rule', () => {
    expect(nextAttemptCount(checkpoint({ kind: 'interrupted' }), ['node-a'])).toBe(undefined);
  });

  it('starts a fresh chain at 1 when the prior marker carried no count', () => {
    expect(nextAttemptCount(checkpoint({ kind: 'partial', attempts: undefined }), ['node-a'])).toBe(
      1,
    );
  });
});
