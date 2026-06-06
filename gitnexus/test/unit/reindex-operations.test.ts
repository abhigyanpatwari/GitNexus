import { describe, expect, it } from 'vitest';
import {
  ReindexOperationRegistry,
  isReindexTrigger,
} from '../../src/server/reindex-operations.js';

const target = {
  repoKey: 'deepwiki-open:c:/users/steve/projects/deepwiki-open',
  repoName: 'deepwiki-open',
  repoPath: '/workspace/deepwiki-open',
};

describe('reindex operation registry', () => {
  it('creates direct operation records with locked status and timestamp semantics', () => {
    const registry = new ReindexOperationRegistry({ now: () => 1000 });

    const record = registry.create({
      id: 'job-1',
      ...target,
      trigger: 'direct',
    });

    expect(record).toMatchObject({
      id: 'job-1',
      status: 'queued',
      trigger: 'direct',
      coalescedRequestCount: 0,
      requestedAt: 1000,
    });
    expect(record).not.toHaveProperty('cancelled');
  });

  it('accepts auto-reindex as a distinct operation trigger', () => {
    const registry = new ReindexOperationRegistry({ now: () => 1000 });

    expect(isReindexTrigger('auto-reindex')).toBe(true);

    const record = registry.create({
      id: 'auto-1',
      ...target,
      trigger: 'auto-reindex',
    });

    expect(record).toMatchObject({
      id: 'auto-1',
      trigger: 'auto-reindex',
      status: 'queued',
    });
    expect(registry.list({ trigger: 'auto-reindex' }).map((op) => op.id)).toEqual(['auto-1']);
  });

  it('tracks coalesced duplicates without allocating phantom child jobs', () => {
    let now = 1000;
    const registry = new ReindexOperationRegistry({ now: () => now });
    registry.create({ id: 'parent', ...target, trigger: 'direct' });

    now = 1200;
    registry.recordCoalescedRequest('parent');

    const beforeFollowUp = registry.get('parent');
    expect(beforeFollowUp).toMatchObject({
      id: 'parent',
      coalescedRequestCount: 1,
      pendingRerunRequestedAt: 1200,
    });
    expect(beforeFollowUp?.followUpJobId).toBeUndefined();
    expect(registry.list({}).map((op) => op.id)).toEqual(['parent']);
  });

  it('links parent and follow-up records only when the follow-up worker starts', () => {
    let now = 1000;
    const registry = new ReindexOperationRegistry({ now: () => now });
    registry.create({ id: 'parent', ...target, trigger: 'direct' });
    registry.markStarted('parent');
    registry.markComplete('parent');

    now = 2000;
    registry.create({
      id: 'child',
      ...target,
      trigger: 'pending-rerun',
      parentJobId: 'parent',
    });
    registry.linkFollowUp('parent', 'child');

    expect(registry.get('parent')).toMatchObject({
      id: 'parent',
      status: 'complete',
      followUpJobId: 'child',
    });
    expect(registry.get('child')).toMatchObject({
      id: 'child',
      trigger: 'pending-rerun',
      parentJobId: 'parent',
      requestedAt: 2000,
    });
  });

  it('records follow-up startup failure on the completed parent without allocating a phantom child', () => {
    let now = 1000;
    const registry = new ReindexOperationRegistry({ now: () => now });
    registry.create({ id: 'parent', ...target, trigger: 'direct' });
    registry.markStarted('parent');
    registry.markComplete('parent');

    now = 1400;
    const updatedParent = registry.recordFollowUpStartFailure(
      'parent',
      'Failed to start pending reindex rerun',
    );

    expect(updatedParent).toMatchObject({
      id: 'parent',
      status: 'complete',
      error: 'Failed to start pending reindex rerun',
      completedAt: 1000,
    });
    expect(registry.list({ trigger: 'pending-rerun' })).toEqual([]);
  });

  it('lists newest first and applies locked exact filters', () => {
    let now = 1000;
    const registry = new ReindexOperationRegistry({ now: () => now });
    registry.create({ id: 'deep-1', ...target, trigger: 'direct' });
    registry.markStarted('deep-1');

    now = 2000;
    registry.create({
      id: 'prom-1',
      repoKey: 'prometheus:key',
      repoName: 'Prometheus',
      repoPath: '/workspace/Prometheus',
      trigger: 'pending-rerun',
    });
    registry.markStarted('prom-1');
    registry.markFailed('prom-1', 'boom');

    expect(registry.list({}).map((op) => op.id)).toEqual(['prom-1', 'deep-1']);
    expect(registry.list({ limit: 1 }).map((op) => op.id)).toEqual(['prom-1']);
    expect(registry.list({ repo: 'Prometheus' }).map((op) => op.id)).toEqual(['prom-1']);
    expect(registry.list({ repo: 'prometheus:key' }).map((op) => op.id)).toEqual(['prom-1']);
    expect(registry.list({ status: 'failed' }).map((op) => op.id)).toEqual(['prom-1']);
    expect(registry.list({ trigger: 'direct' }).map((op) => op.id)).toEqual(['deep-1']);
  });

  it('retains the latest records and prunes oldest terminal records first', () => {
    let now = 1000;
    const registry = new ReindexOperationRegistry({ now: () => now, maxRecords: 3 });

    for (const id of ['a', 'b', 'c']) {
      registry.create({ id, ...target, trigger: 'direct' });
      registry.markComplete(id);
      now += 1000;
    }

    registry.create({ id: 'd', ...target, trigger: 'direct' });

    expect(registry.list({ limit: 10 }).map((op) => op.id)).toEqual(['d', 'c', 'b']);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('d')?.status).toBe('queued');
  });
});
