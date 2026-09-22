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
    expect(view.repoName).toBe('repo');
    expect(view.repoUrl).toBeUndefined();
    expect(view.repoPath).toBeUndefined();
  });

  it('strips query and fragment when deriving repoName from repoUrl', () => {
    const job = manager.createJob({
      repoUrl: 'https://github.com/user/repo.git?access_token=secret#frag',
    });
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze');
    expect(view.repoName).toBe('repo');
    expect(view.repoName).not.toContain('access_token');
    expect(view.repoUrl).toBeUndefined();
  });

  it('redacts the full repository URL from job.error on the public ops view', () => {
    const job = manager.createJob({
      repoUrl: 'https://x-access-token:ghs_secret@github.com/user/repo.git',
    });
    manager.updateJob(job.id, {
      status: 'failed',
      error: 'fatal: unable to access https://x-access-token:ghs_secret@github.com/user/repo.git/',
    });
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze');
    expect(view.error).toBe('fatal: unable to access [repo]');
    expect(JSON.stringify(view)).not.toContain('ghs_secret');
    expect(JSON.stringify(view)).not.toContain('x-access-token');
    expect(JSON.stringify(view)).not.toContain('github.com');
  });

  it('redacts the full repository URL from progress.message on the public ops view', () => {
    const job = manager.createJob({
      repoUrl: 'https://x-access-token:ghs_secret@github.com/user/repo.git',
    });
    manager.updateJob(job.id, {
      status: 'cloning',
      progress: {
        phase: 'cloning',
        percent: 0,
        message: 'Cloning https://x-access-token:ghs_secret@github.com/user/repo.git...',
      },
    });
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze');
    expect(view.progress.message).toBe('Cloning [repo]...');
    expect(JSON.stringify(view)).not.toContain('ghs_secret');
    expect(JSON.stringify(view)).not.toContain('x-access-token');
    expect(JSON.stringify(view)).not.toContain('github.com');
  });

  it('redacts host, path, and query from a credential-stripped clone URL', () => {
    const job = manager.createJob({
      repoUrl: 'https://git.example/private/repo?token=x',
    });
    manager.updateJob(job.id, {
      status: 'cloning',
      progress: {
        phase: 'cloning',
        percent: 0,
        message: 'Cloning https://git.example/private/repo?token=x',
      },
    });
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze');
    expect(view.progress.message).toBe('Cloning [repo]');
    expect(JSON.stringify(view)).not.toContain('git.example');
    expect(JSON.stringify(view)).not.toContain('private/repo');
    expect(JSON.stringify(view)).not.toContain('token=x');
  });

  it('basenames Windows-like drive paths instead of emitting the full path', () => {
    const job = manager.createJob({
      repoUrl: String.raw`C:\Users\alice\private\repo`,
    });
    const view = serializeOpsJob(manager.getJob(job.id)!, 'analyze');
    expect(view.repoName).toBe('repo');
    expect(JSON.stringify(view)).not.toContain('Users');
    expect(JSON.stringify(view)).not.toContain('alice');
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
  it('allows exact official vercel hosts only', () => {
    expect(isGitNexusVercelOrigin('https://gitnexus.vercel.app')).toBe(true);
    expect(isGitNexusVercelOrigin('https://gitnexus-web.vercel.app')).toBe(true);
  });

  it('rejects preview and unrelated vercel hosts', () => {
    expect(isGitNexusVercelOrigin('https://gitnexus-web-mesquitafelipe571-5486.vercel.app')).toBe(
      false,
    );
    expect(
      isGitNexusVercelOrigin(
        'https://gitnexus-web-git-local-bridge-v1-mesquitafelipe571-5486.vercel.app',
      ),
    ).toBe(false);
    expect(isGitNexusVercelOrigin('https://gitnexus-web-evil.vercel.app')).toBe(false);
    expect(isGitNexusVercelOrigin('https://evil.vercel.app')).toBe(false);
    expect(isGitNexusVercelOrigin('https://gitnexus-web-attacker.com')).toBe(false);
    expect(isGitNexusVercelOrigin('http://gitnexus-web.vercel.app')).toBe(false);
  });

  it('rejects non-default ports on the official hostnames', () => {
    expect(isGitNexusVercelOrigin('https://gitnexus-web.vercel.app:8443')).toBe(false);
    // :443 is the HTTPS default — URL.port is empty, same as the bare origin.
    expect(isGitNexusVercelOrigin('https://gitnexus.vercel.app')).toBe(true);
  });
});
