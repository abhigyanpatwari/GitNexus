import { describe, expect, it, vi } from 'vitest';
import { startPendingRerun } from '../../src/server/reindex-follow-up.js';

const parentOperation = {
  id: 'parent',
  repoKey: 'deepwiki-open:key',
  repoName: 'deepwiki-open',
  repoPath: '/workspace/deepwiki-open',
  status: 'complete' as const,
  trigger: 'direct' as const,
  coalescedRequestCount: 1,
  requestedAt: 1000,
  startedAt: 1000,
  completedAt: 1200,
};

describe('reindex pending rerun helper', () => {
  it('links parent and child when follow-up startup succeeds', () => {
    const linkFollowUp = vi.fn(() => ({
      ...parentOperation,
      followUpJobId: 'child',
    }));
    const getOperation = vi.fn(() => ({
      ...parentOperation,
      id: 'child',
      trigger: 'pending-rerun' as const,
      parentJobId: 'parent',
      status: 'analyzing' as const,
      requestedAt: 1300,
    }));

    const result = startPendingRerun({
      parentJobId: 'parent',
      repoKey: 'deepwiki-open:key',
      startFollowUp: () => ({ id: 'child' }),
      linkFollowUp,
      getOperation,
      recordFollowUpStartFailure: vi.fn(),
      queueFail: vi.fn(),
    });

    expect(result).toEqual({
      kind: 'started',
      followUpJobId: 'child',
      parentOperation: {
        ...parentOperation,
        followUpJobId: 'child',
      },
      followUpOperation: {
        ...parentOperation,
        id: 'child',
        trigger: 'pending-rerun',
        parentJobId: 'parent',
        status: 'analyzing',
        requestedAt: 1300,
      },
    });
    expect(linkFollowUp).toHaveBeenCalledWith('parent', 'child');
    expect(getOperation).toHaveBeenCalledWith('child');
  });

  it('records parent-visible failure without fabricating a child when startup throws', () => {
    const recordFollowUpStartFailure = vi.fn(() => ({
      ...parentOperation,
      error: 'Failed to start pending reindex rerun',
    }));
    const queueFail = vi.fn();
    const linkFollowUp = vi.fn();
    const getOperation = vi.fn();

    const result = startPendingRerun({
      parentJobId: 'parent',
      repoKey: 'deepwiki-open:key',
      startFollowUp: () => {
        throw new Error('Failed to start pending reindex rerun');
      },
      linkFollowUp,
      getOperation,
      recordFollowUpStartFailure,
      queueFail,
    });

    expect(result).toEqual({
      kind: 'failed',
      error: 'Failed to start pending reindex rerun',
      cause: expect.any(Error),
      parentOperation: {
        ...parentOperation,
        error: 'Failed to start pending reindex rerun',
      },
    });
    expect(recordFollowUpStartFailure).toHaveBeenCalledWith(
      'parent',
      'Failed to start pending reindex rerun',
    );
    expect(queueFail).toHaveBeenCalledWith(
      'deepwiki-open:key',
      'Failed to start pending reindex rerun',
    );
    expect(linkFollowUp).not.toHaveBeenCalled();
    expect(getOperation).not.toHaveBeenCalled();
  });
});
