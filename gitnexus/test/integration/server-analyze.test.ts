import { describe, it, expect, afterAll } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import { extractRepoName, getCloneDir } from '../../src/server/git-clone.js';

describe('server-side analyze integration', () => {
  const manager = new JobManager();

  afterAll(() => manager.dispose());

  it('full job lifecycle: create -> clone -> analyze -> complete', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/test-repo' });
    expect(job.status).toBe('queued');

    // Simulate clone phase
    manager.updateJob(job.id, {
      status: 'cloning',
      progress: { phase: 'cloning', percent: 5, message: 'Cloning...' },
    });
    expect(manager.getJob(job.id)!.status).toBe('cloning');

    // Simulate analyze phase
    manager.updateJob(job.id, {
      status: 'analyzing',
      repoPath: '/tmp/test-repo',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing code' },
    });
    expect(manager.getJob(job.id)!.status).toBe('analyzing');

    // Simulate completion
    manager.updateJob(job.id, {
      status: 'complete',
      repoName: 'test-repo',
    });

    const final = manager.getJob(job.id)!;
    expect(final.status).toBe('complete');
    expect(final.repoName).toBe('test-repo');
    expect(final.completedAt).toBeDefined();
  });

  it('SSE progress listener receives all events in order', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/sse-test' });
    const events: any[] = [];

    const unsubscribe = manager.onProgress(job.id, (progress) => {
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

    unsubscribe();

    expect(events.length).toBe(3);
    expect(events[0].phase).toBe('parsing');
    expect(events[1].phase).toBe('calls');
    expect(events[2].phase).toBe('complete');
  });

  it('failed job emits failure event', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/fail-test' });
    const events: any[] = [];

    const unsubscribe = manager.onProgress(job.id, (progress) => {
      events.push(progress);
    });

    manager.updateJob(job.id, {
      status: 'failed',
      error: 'Clone failed: repository not found',
    });

    unsubscribe();

    expect(events.length).toBe(1);
    expect(events[0].phase).toBe('failed');
    expect(events[0].message).toBe('Clone failed: repository not found');
  });

  it('git URL name extraction for clone paths', () => {
    expect(extractRepoName('https://github.com/facebook/react.git')).toBe('react');
    expect(extractRepoName('git@github.com:microsoft/vscode.git')).toBe('vscode');
    const dir = getCloneDir('react');
    expect(dir).toMatch(/\.gitnexus/);
    expect(dir).toMatch(/repos/);
    expect(dir).toContain('react');
  });

  it('concurrency: blocks second job while first is active', () => {
    // First job completes from previous test, start fresh
    const freshManager = new JobManager();

    const job1 = freshManager.createJob({ repoUrl: 'https://github.com/user/repo-a' });
    freshManager.updateJob(job1.id, { status: 'analyzing' });

    // Second different repo should be rejected
    expect(() => freshManager.createJob({ repoUrl: 'https://github.com/user/repo-b' })).toThrow(
      /already in progress/,
    );

    // Same repo should return existing job
    const job1again = freshManager.createJob({ repoUrl: 'https://github.com/user/repo-a' });
    expect(job1again.id).toBe(job1.id);

    // After completion, new job allowed
    freshManager.updateJob(job1.id, { status: 'complete' });
    const job2 = freshManager.createJob({ repoUrl: 'https://github.com/user/repo-b' });
    expect(job2.status).toBe('queued');
    expect(job2.id).not.toBe(job1.id);

    freshManager.dispose();
  });
});
