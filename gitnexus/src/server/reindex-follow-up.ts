import type { ReindexOperationRecord } from './reindex-operations.js';

export interface FollowUpJobLike {
  id: string;
}

export interface StartPendingRerunParams {
  parentJobId: string;
  repoKey: string;
  startFollowUp: () => FollowUpJobLike;
  linkFollowUp: (parentJobId: string, followUpJobId: string) => ReindexOperationRecord | undefined;
  getOperation: (jobId: string) => ReindexOperationRecord | undefined;
  recordFollowUpStartFailure: (
    parentJobId: string,
    error: string,
  ) => ReindexOperationRecord | undefined;
  queueFail: (repoKey: string, error: string) => void;
}

export type StartPendingRerunResult =
  | {
      kind: 'started';
      followUpJobId: string;
      parentOperation?: ReindexOperationRecord;
      followUpOperation?: ReindexOperationRecord;
    }
  | {
      kind: 'failed';
      error: string;
      cause: unknown;
      parentOperation?: ReindexOperationRecord;
    };

export const startPendingRerun = (
  params: StartPendingRerunParams,
): StartPendingRerunResult => {
  try {
    const followUpJob = params.startFollowUp();
    const parentOperation = params.linkFollowUp(params.parentJobId, followUpJob.id);
    const followUpOperation = params.getOperation(followUpJob.id);
    return {
      kind: 'started',
      followUpJobId: followUpJob.id,
      parentOperation,
      followUpOperation,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to start pending reindex rerun';
    const parentOperation = params.recordFollowUpStartFailure(params.parentJobId, message);
    params.queueFail(params.repoKey, message);
    return {
      kind: 'failed',
      error: message,
      cause: err,
      parentOperation,
    };
  }
};
