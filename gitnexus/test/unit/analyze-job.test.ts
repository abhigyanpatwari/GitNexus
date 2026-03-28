import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('creates a job with queued status', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe('queued');
    expect(job.repoUrl).toBe('https://github.com/user/repo');
  });

  it('retrieves a job by id', () => {
    const created = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const retrieved = manager.getJob(created.id);
    expect(retrieved).toEqual(created);
  });

  it('returns undefined for unknown job id', () => {
    expect(manager.getJob('nonexistent')).toBeUndefined();
  });

  it('enforces single-slot concurrency', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(() => manager.createJob({ repoUrl: 'https://github.com/user/repo2' })).toThrow(
      /already in progress/,
    );
  });

  it('allows new job after previous completes', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    manager.updateJob(job1.id, { status: 'complete' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo2' });
    expect(job2.status).toBe('queued');
  });

  it('returns existing job for same repoUrl when active', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job2.id).toBe(job1.id);
  });

  it('updates job progress', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing code' },
    });
    const updated = manager.getJob(job.id)!;
    expect(updated.status).toBe('analyzing');
    expect(updated.progress.percent).toBe(30);
  });

  it('emits progress events', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, {
      progress: { phase: 'parsing', percent: 50, message: 'Parsing code' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].percent).toBe(50);
  });

  it('emits terminal event on complete', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('complete');
    expect(events[0].percent).toBe(100);
  });

  it('sets completedAt on terminal status', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'complete' });
    expect(manager.getJob(job.id)!.completedAt).toBeDefined();
  });

  it('unsubscribe stops events', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    const unsub = manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, {
      progress: { phase: 'p1', percent: 10, message: 'm1' },
    });
    unsub();
    manager.updateJob(job.id, {
      progress: { phase: 'p2', percent: 20, message: 'm2' },
    });

    expect(events).toHaveLength(1);
  });

  it('cancelJob sets status to failed with reason', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const cancelled = manager.cancelJob(job.id, 'Cancelled by user');
    expect(cancelled).toBe(true);
    expect(manager.getJob(job.id)!.status).toBe('failed');
    expect(manager.getJob(job.id)!.error).toBe('Cancelled by user');
  });

  it('cancelJob returns false for terminal jobs', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'complete' });
    expect(manager.cancelJob(job.id)).toBe(false);
  });

  it('cancelJob returns false for unknown job', () => {
    expect(manager.cancelJob('nonexistent')).toBe(false);
  });
});
