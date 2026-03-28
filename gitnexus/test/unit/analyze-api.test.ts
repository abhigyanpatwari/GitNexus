import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';

describe('analyze API logic', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('creates a job and returns 202 shape', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const response = { jobId: job.id, status: job.status };
    expect(response.jobId).toBeTruthy();
    expect(response.status).toBe('queued');
  });

  it('rejects when job already active for different repo', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(() => manager.createJob({ repoUrl: 'https://github.com/user/repo2' })).toThrow(
      /already in progress/,
    );
  });

  it('returns existing job for same repo URL', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job2.id).toBe(job1.id);
  });

  it('SSE progress listener receives all events including terminal', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/sse-test' });
    const events: any[] = [];
    const unsub = manager.onProgress(job.id, (progress) => {
      events.push(progress);
    });

    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing' },
    });
    manager.updateJob(job.id, {
      progress: { phase: 'calls', percent: 50, message: 'Tracing calls' },
    });
    manager.updateJob(job.id, { status: 'complete', repoName: 'sse-test' });

    unsub();

    expect(events.length).toBe(3);
    expect(events[0].phase).toBe('parsing');
    expect(events[1].phase).toBe('calls');
    expect(events[2].phase).toBe('complete');
    expect(events[2].percent).toBe(100);
  });
});
