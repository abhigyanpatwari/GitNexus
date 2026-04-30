import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkerPoolOptions } from '../../src/core/ingestion/workers/worker-pool.js';

const ORIGINAL_TIMEOUT = process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS;
const ORIGINAL_MAX_BYTES = process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES;

describe('resolveWorkerPoolOptions', () => {
  afterEach(() => {
    if (ORIGINAL_TIMEOUT === undefined) {
      delete process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS;
    } else {
      process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    }

    if (ORIGINAL_MAX_BYTES === undefined) {
      delete process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES;
    } else {
      process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES = ORIGINAL_MAX_BYTES;
    }
  });

  it('reads worker timeout and byte budget from environment variables', () => {
    process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = '5000';
    process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES = '4096';

    const options = resolveWorkerPoolOptions();

    expect(options.subBatchIdleTimeoutMs).toBe(5000);
    expect(options.subBatchMaxBytes).toBe(4096);
  });

  it('prefers explicit options over environment variables', () => {
    process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = '5000';
    process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES = '4096';

    const options = resolveWorkerPoolOptions({
      subBatchIdleTimeoutMs: 7000,
      subBatchMaxBytes: 8192,
    });

    expect(options.subBatchIdleTimeoutMs).toBe(7000);
    expect(options.subBatchMaxBytes).toBe(8192);
  });
});
