export const REINDEX_OPERATION_STATUSES = ['queued', 'analyzing', 'complete', 'failed'] as const;
export const REINDEX_OPERATION_TRIGGERS = ['direct', 'pending-rerun'] as const;

export type ReindexOperationStatus = (typeof REINDEX_OPERATION_STATUSES)[number];
export type ReindexTrigger = (typeof REINDEX_OPERATION_TRIGGERS)[number];

export interface ReindexOperationRecord {
  id: string;
  repoKey: string;
  repoName: string;
  repoPath: string;
  status: ReindexOperationStatus;
  trigger: ReindexTrigger;
  parentJobId?: string;
  followUpJobId?: string;
  coalescedRequestCount: number;
  pendingRerunRequestedAt?: number;
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface CreateReindexOperationParams {
  id: string;
  repoKey: string;
  repoName: string;
  repoPath: string;
  trigger: ReindexTrigger;
  parentJobId?: string;
}

export interface ReindexOperationListFilter {
  limit?: number;
  repo?: string;
  status?: ReindexOperationStatus;
  trigger?: ReindexTrigger;
}

export const isReindexOperationStatus = (value: string): value is ReindexOperationStatus =>
  REINDEX_OPERATION_STATUSES.includes(value as ReindexOperationStatus);

export const isReindexTrigger = (value: string): value is ReindexTrigger =>
  REINDEX_OPERATION_TRIGGERS.includes(value as ReindexTrigger);

export class ReindexOperationRegistry {
  private readonly operations = new Map<string, ReindexOperationRecord>();
  private readonly now: () => number;
  private readonly maxRecords: number;

  constructor(options: { now?: () => number; maxRecords?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxRecords = options.maxRecords ?? 100;
  }

  create(params: CreateReindexOperationParams): ReindexOperationRecord {
    const record: ReindexOperationRecord = {
      ...params,
      status: 'queued',
      coalescedRequestCount: 0,
      requestedAt: this.now(),
    };
    this.operations.set(record.id, record);
    this.prune();
    return this.clone(record);
  }

  get(id: string): ReindexOperationRecord | undefined {
    const record = this.operations.get(id);
    return record ? this.clone(record) : undefined;
  }

  list(filter: ReindexOperationListFilter = {}): ReindexOperationRecord[] {
    let records = Array.from(this.operations.values());

    if (filter.repo) {
      records = records.filter(
        (record) => record.repoName === filter.repo || record.repoKey === filter.repo,
      );
    }

    if (filter.status) {
      records = records.filter((record) => record.status === filter.status);
    }

    if (filter.trigger) {
      records = records.filter((record) => record.trigger === filter.trigger);
    }

    records.sort((a, b) => b.requestedAt - a.requestedAt);

    if (filter.limit !== undefined) {
      records = records.slice(0, filter.limit);
    }

    return records.map((record) => this.clone(record));
  }

  markStarted(id: string): ReindexOperationRecord | undefined {
    const record = this.operations.get(id);
    if (!record) return undefined;
    record.status = 'analyzing';
    record.startedAt = record.startedAt ?? this.now();
    return this.clone(record);
  }

  markComplete(id: string): ReindexOperationRecord | undefined {
    const record = this.operations.get(id);
    if (!record) return undefined;
    record.status = 'complete';
    record.completedAt = record.completedAt ?? this.now();
    delete record.error;
    this.prune();
    return this.clone(record);
  }

  markFailed(id: string, error: string): ReindexOperationRecord | undefined {
    const record = this.operations.get(id);
    if (!record) return undefined;
    record.status = 'failed';
    record.error = error;
    record.completedAt = record.completedAt ?? this.now();
    this.prune();
    return this.clone(record);
  }

  recordCoalescedRequest(id: string): ReindexOperationRecord | undefined {
    const record = this.operations.get(id);
    if (!record) return undefined;
    record.coalescedRequestCount += 1;
    record.pendingRerunRequestedAt = this.now();
    return this.clone(record);
  }

  linkFollowUp(parentJobId: string, followUpJobId: string): ReindexOperationRecord | undefined {
    const parent = this.operations.get(parentJobId);
    if (!parent) return undefined;
    parent.followUpJobId = followUpJobId;
    return this.clone(parent);
  }

  recordFollowUpStartFailure(
    parentJobId: string,
    error: string,
  ): ReindexOperationRecord | undefined {
    const parent = this.operations.get(parentJobId);
    if (!parent) return undefined;
    parent.error = error;
    return this.clone(parent);
  }

  private prune(): void {
    while (this.operations.size > this.maxRecords) {
      const terminalRecords = Array.from(this.operations.values())
        .filter((record) => record.status === 'complete' || record.status === 'failed')
        .sort((a, b) => a.requestedAt - b.requestedAt);
      const oldestTerminal = terminalRecords[0];
      if (!oldestTerminal) break;
      this.operations.delete(oldestTerminal.id);
    }
  }

  private clone(record: ReindexOperationRecord): ReindexOperationRecord {
    return { ...record };
  }
}
