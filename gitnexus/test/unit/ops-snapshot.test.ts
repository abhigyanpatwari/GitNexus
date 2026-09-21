import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import {
  buildOpsSnapshot,
  isGitNexusVercelOrigin,
  serializeOpsJob,
  summarizeOpsLane,
} from '../../src/server/ops-snapshot.js';

describe('serializeOpsJob / summarizeOpsLane', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('computes duration from startedAt to now for active jobs', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const now = job.startedAt + 5_000;
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze', now);
    expect(view.durationMs).toBe(5_000);
    expect(view.lane).toBe('analyze');
  });

  it('summarizes lane metrics including avg duration of terminal jobs', () => {
    const a = manager.createJob({ repoUrl: 'https://github.com/user/a' });
    manager.updateJob(a.id, { status: 'analyzing' });
    manager.updateJob(a.id, {
      status: 'complete',
      completedAt: a.startedAt + 2_000,
    });

    const b = manager.createJob({ repoUrl: 'https://github.com/user/b' });
    manager.updateJob(b.id, { status: 'analyzing' });
    manager.updateJob(b.id, {
      status: 'failed',
      error: 'boom',
      completedAt: b.startedAt + 4_000,
    });

    const views = manager.listJobs().map((j) => serializeOpsJob(j, 'analyze', Date.now()));
    const metrics = summarizeOpsLane(views);
    expect(metrics.total).toBe(2);
    expect(metrics.complete).toBe(1);
    expect(metrics.failed).toBe(1);
    expect(metrics.active).toBe(0);
    expect(metrics.avgDurationMs).toBe(3_000);
    expect(metrics.maxDurationMs).toBe(4_000);
  });
});

describe('buildOpsSnapshot', () => {
  let analyze: JobManager;
  let embed: JobManager;

  beforeEach(() => {
    analyze = new JobManager();
    embed = new JobManager();
  });

  afterEach(() => {
    analyze.dispose();
    embed.dispose();
  });

  it('aggregates both lanes and server uptime', () => {
    const job = analyze.createJob({ repoUrl: 'https://github.com/user/repo' });
    analyze.updateJob(job.id, { status: 'analyzing' });
    const startedAt = 1_000;
    const now = 6_000;
    const snap = buildOpsSnapshot({
      analyzeJobs: analyze.listJobs(),
      embedJobs: embed.listJobs(),
      serverStartedAt: startedAt,
      server: { version: '1.0.0', launchContext: 'local', nodeVersion: 'v22.0.0' },
      now,
    });
    expect(snap.health).toBe('ok');
    expect(snap.uptimeMs).toBe(5_000);
    expect(snap.totals.active).toBe(1);
    expect(snap.analyze.jobs).toHaveLength(1);
    expect(snap.embed.jobs).toHaveLength(0);
    expect(snap.server.version).toBe('1.0.0');
  });
});

describe('isGitNexusVercelOrigin', () => {
  it('allows official and project vercel hosts', () => {
    expect(isGitNexusVercelOrigin('https://gitnexus.vercel.app')).toBe(true);
    expect(isGitNexusVercelOrigin('https://gitnexus-web.vercel.app')).toBe(true);
    expect(
      isGitNexusVercelOrigin('https://gitnexus-web-mesquitafelipe571-5486.vercel.app'),
    ).toBe(true);
    expect(
      isGitNexusVercelOrigin(
        'https://gitnexus-web-git-local-bridge-v1-mesquitafelipe571-5486.vercel.app',
      ),
    ).toBe(true);
  });

  it('rejects unrelated vercel and non-https hosts', () => {
    expect(isGitNexusVercelOrigin('https://evil.vercel.app')).toBe(false);
    expect(isGitNexusVercelOrigin('https://gitnexus-web-attacker.com')).toBe(false);
    expect(isGitNexusVercelOrigin('http://gitnexus-web.vercel.app')).toBe(false);
  });
});
