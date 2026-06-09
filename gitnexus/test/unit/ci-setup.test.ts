import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Mock @inquirer/prompts so tests don't hang waiting for TTY input.
// Default: all selects return the first choice; confirm returns false (no overwrite).
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(({ choices }: { choices: { value: string }[] }) =>
    Promise.resolve(choices[0].value),
  ),
  confirm: vi.fn(() => Promise.resolve(false)),
}));

// Mock child_process to prevent actual git/shell calls from the detect module.
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    const gitRoot = process.env._TEST_GIT_ROOT;
    if (cmd.includes('rev-parse --show-toplevel') || cmd.includes('rev-parse --is-inside-work-tree')) {
      if (!gitRoot) throw new Error('not a git repository');
      return Buffer.from(gitRoot);
    }
    return Buffer.from('');
  }),
}));

describe('ciSetupCommand', () => {
  let tempDir: string;
  let originalGitRoot: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ci-setup-'));

    // Simulate a git repo by pointing _TEST_GIT_ROOT at tempDir
    originalGitRoot = process.env._TEST_GIT_ROOT;
    process.env._TEST_GIT_ROOT = tempDir;

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env._TEST_GIT_ROOT = originalGitRoot;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('--dry-run writes no files', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    await ciSetupCommand({
      ci: 'github-actions',
      deploy: 'docker',
      auth: 'token',
      branchStrategy: 'pr-scoped',
      dryRun: true,
      apply: false,
      yes: false,
      outputDir: tempDir,
    });

    const entries = await fs.readdir(tempDir);
    expect(entries).toHaveLength(0);
  });

  it('--apply writes expected files', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    await ciSetupCommand({
      ci: 'github-actions',
      deploy: 'docker',
      auth: 'token',
      branchStrategy: 'pr-scoped',
      apply: true,
      yes: true,
      outputDir: tempDir,
    });

    const wfPath = path.join(tempDir, '.github', 'workflows', 'gitnexus-ci.yml');
    const dcPath = path.join(tempDir, 'docker-compose.gitnexus.yml');
    const cfPath = path.join(tempDir, 'Caddyfile');
    const snipPath = path.join(tempDir, '.claude', 'gitnexus-mcp-snippet.json');
    const mdPath = path.join(tempDir, 'GITNEXUS.md');

    await expect(fs.access(wfPath)).resolves.toBeUndefined();
    await expect(fs.access(dcPath)).resolves.toBeUndefined();
    await expect(fs.access(cfPath)).resolves.toBeUndefined();
    await expect(fs.access(snipPath)).resolves.toBeUndefined();
    await expect(fs.access(mdPath)).resolves.toBeUndefined();
  });

  it('--apply is idempotent: second run skips identical files', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    const opts = {
      ci: 'github-actions' as const,
      deploy: 'docker' as const,
      auth: 'token' as const,
      branchStrategy: 'pr-scoped' as const,
      apply: true,
      yes: true,
      outputDir: tempDir,
    };

    await ciSetupCommand(opts);

    // Record mtimes after first apply
    const wfPath = path.join(tempDir, '.github', 'workflows', 'gitnexus-ci.yml');
    const mtime1 = (await fs.stat(wfPath)).mtimeMs;

    // Small delay to ensure mtime would differ if file is rewritten
    await new Promise((r) => setTimeout(r, 20));

    vi.resetModules();
    const { ciSetupCommand: ciSetupCommand2 } = await import('../../src/cli/ci-setup.js');
    await ciSetupCommand2(opts);

    const mtime2 = (await fs.stat(wfPath)).mtimeMs;
    expect(mtime2).toBe(mtime1); // file not rewritten
  });

  it('exits with error when not in a git repo', async () => {
    process.env._TEST_GIT_ROOT = ''; // simulate no git root
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });

    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    await expect(
      ciSetupCommand({
        ci: 'github-actions',
        deploy: 'docker',
        auth: 'token',
        apply: true,
        yes: true,
        outputDir: tempDir,
      }),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--auth none generates no Caddyfile', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    await ciSetupCommand({
      ci: 'github-actions',
      deploy: 'docker',
      auth: 'none',
      apply: true,
      yes: true,
      outputDir: tempDir,
    });

    const cfPath = path.join(tempDir, 'Caddyfile');
    await expect(fs.access(cfPath)).rejects.toThrow();
  });

  it('--auth none docker-compose has no proxy service', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    await ciSetupCommand({
      ci: 'github-actions',
      deploy: 'docker',
      auth: 'none',
      apply: true,
      yes: true,
      outputDir: tempDir,
    });

    const dcContent = await fs.readFile(
      path.join(tempDir, 'docker-compose.gitnexus.yml'),
      'utf-8',
    );
    expect(dcContent).not.toContain('gitnexus-proxy');
    expect(dcContent).not.toContain('caddy');
  });

  it('default mode (no --dry-run / --apply flag) defaults to dry-run', async () => {
    const { ciSetupCommand } = await import('../../src/cli/ci-setup.js');
    // No apply or dryRun flags — should default to dry-run
    await ciSetupCommand({
      ci: 'github-actions',
      deploy: 'docker',
      auth: 'token',
      outputDir: tempDir,
    });

    const entries = await fs.readdir(tempDir);
    expect(entries).toHaveLength(0);
  });
});
