import { describe, expect, it } from 'vitest';
import {
  ReindexQueue,
  buildReindexWorkerOptions,
  isGraphReadBlockedDuringReindex,
  parseReindexRequestBody,
  resolveRegisteredReindexTarget,
} from '../../src/server/reindex-control.js';
import { BadRequestError } from '../../src/server/validation.js';

const repos = [
  {
    id: 'deepwiki-open:c:/users/steve/projects/deepwiki-open',
    name: 'deepwiki-open',
    path: 'C:\\Users\\steve\\projects\\deepwiki-open',
    storagePath: 'C:\\Users\\steve\\podman\\gitnexus\\indexes\\deepwiki-open',
  },
  {
    id: 'prometheus:c:/users/steve/projects/prometheus',
    name: 'Prometheus',
    path: 'C:\\Users\\steve\\projects\\Prometheus',
    storagePath: 'C:\\Users\\steve\\podman\\gitnexus\\indexes\\Prometheus',
  },
];

describe('reindex control contract', () => {
  it('validates reindex request body shape before resolving repos', () => {
    expect(() => parseReindexRequestBody({ repo: 42 })).toThrow(/"repo" must be a string/);
    expect(() => parseReindexRequestBody({ path: 42 })).toThrow(/"path" must be a string/);
    expect(() => parseReindexRequestBody({})).toThrow(/provide a registered repo/i);
    expect(() => parseReindexRequestBody(null)).toThrow(/provide a registered repo/i);

    expect(
      parseReindexRequestBody({
        repo: 'deepwiki-open',
        force: true,
        embeddings: true,
        dropEmbeddings: false,
      }),
    ).toEqual({
      repo: 'deepwiki-open',
      path: undefined,
      force: true,
      embeddings: true,
      dropEmbeddings: false,
    });
  });

  it('rejects non-boolean reindex option flags instead of coercing them', () => {
    expect(() => parseReindexRequestBody({ repo: 'deepwiki-open', force: 'false' })).toThrow(
      /"force" must be a boolean/,
    );
    expect(() => parseReindexRequestBody({ repo: 'deepwiki-open', embeddings: 1 })).toThrow(
      /"embeddings" must be a boolean/,
    );
    expect(() => parseReindexRequestBody({ repo: 'deepwiki-open', dropEmbeddings: 0 })).toThrow(
      /"dropEmbeddings" must be a boolean/,
    );
  });

  it('classifies rejected reindex inputs as bad requests', () => {
    expect(() => parseReindexRequestBody({ repo: 42 })).toThrow(BadRequestError);
    expect(() => parseReindexRequestBody({ repo: 'deepwiki-open', force: 'false' })).toThrow(
      BadRequestError,
    );
    expect(() => resolveRegisteredReindexTarget(repos, { repo: 'unknown' })).toThrow(
      BadRequestError,
    );
    expect(() =>
      resolveRegisteredReindexTarget(repos, { path: 'C:\\Windows\\System32' }),
    ).toThrow(BadRequestError);
  });

  it('resolves registered repo names without accepting arbitrary absolute paths', () => {
    expect(resolveRegisteredReindexTarget(repos, { repo: 'deepwiki-open' })).toEqual(repos[0]);
    expect(() => resolveRegisteredReindexTarget(repos, { repo: 'unknown' })).toThrow(
      /not registered/i,
    );
    expect(() =>
      resolveRegisteredReindexTarget(repos, { path: 'C:\\Windows\\System32' }),
    ).toThrow(/not registered/i);
  });

  it('resolves registered paths case-insensitively on Windows-style paths', () => {
    expect(
      resolveRegisteredReindexTarget(repos, {
        path: 'c:\\users\\steve\\projects\\prometheus',
      }),
    ).toEqual(repos[1]);
  });

  it('always forces indexOnly for reindex worker options', () => {
    expect(buildReindexWorkerOptions({ force: false, embeddings: true })).toMatchObject({
      force: false,
      embeddings: true,
      indexOnly: true,
      skipAgentsMd: true,
      skipSkills: true,
    });
    expect(buildReindexWorkerOptions({ force: true, embeddings: false }).indexOnly).toBe(true);
  });

  it('preserves embedding flags while keeping fail-closed worker options explicit', () => {
    expect(
      buildReindexWorkerOptions({
        embeddings: true,
        dropEmbeddings: true,
      }),
    ).toMatchObject({
      embeddings: true,
      dropEmbeddings: true,
      skipAgentsMd: true,
      skipSkills: true,
      indexOnly: true,
    });
  });

  it('marks a same-repo request during an active job as a pending rerun', () => {
    const queue = new ReindexQueue();
    const first = queue.request('deepwiki-open');
    expect(first.action).toBe('start');

    const second = queue.request('deepwiki-open');
    expect(second.action).toBe('dedupe-pending-rerun');
    expect(queue.status('deepwiki-open')).toMatchObject({
      active: true,
      pendingRerun: true,
    });
  });

  it('starts exactly one follow-up run after many duplicate same-repo requests', () => {
    const queue = new ReindexQueue();
    queue.request('deepwiki-open');
    queue.request('deepwiki-open');
    queue.request('deepwiki-open');

    const completion = queue.complete('deepwiki-open');
    expect(completion).toEqual({ action: 'start-pending-rerun' });
    expect(queue.status('deepwiki-open')).toMatchObject({
      active: true,
      pendingRerun: false,
    });

    expect(queue.complete('deepwiki-open')).toEqual({ action: 'idle' });
    expect(queue.status('deepwiki-open')).toMatchObject({
      active: false,
      pendingRerun: false,
    });
  });

  it('rejects a different repo while another reindex is active', () => {
    const queue = new ReindexQueue();
    queue.request('deepwiki-open');

    expect(queue.request('Prometheus')).toEqual({
      action: 'reject-active-other-repo',
      activeRepoKey: 'deepwiki-open',
    });
  });

  it('reports last failure status without leaving stale active or pending state', () => {
    const queue = new ReindexQueue();
    queue.request('deepwiki-open');
    queue.request('deepwiki-open');

    queue.fail('deepwiki-open', 'Embedding dimension mismatch: expected 1024, got 768', 12345);

    expect(queue.status('deepwiki-open')).toEqual({
      active: false,
      pendingRerun: false,
      lastError: 'Embedding dimension mismatch: expected 1024, got 768',
      lastFailureAt: 12345,
    });
  });

  it('blocks graph-backed reads only during the overlap / pending-rerun window', () => {
    expect(
      isGraphReadBlockedDuringReindex({
        queueStatus: {
          active: true,
          pendingRerun: false,
        },
        activeTrigger: 'direct',
      }),
    ).toBe(false);

    expect(
      isGraphReadBlockedDuringReindex({
        queueStatus: {
          active: true,
          pendingRerun: true,
        },
        activeTrigger: 'direct',
      }),
    ).toBe(true);

    expect(
      isGraphReadBlockedDuringReindex({
        queueStatus: {
          active: true,
          pendingRerun: false,
        },
        activeTrigger: 'pending-rerun',
      }),
    ).toBe(true);

    expect(
      isGraphReadBlockedDuringReindex({
        queueStatus: {
          active: false,
          pendingRerun: false,
        },
        activeTrigger: 'pending-rerun',
      }),
    ).toBe(false);
  });
});
