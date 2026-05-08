import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isGitRepo,
  getCurrentCommit,
  getGitRoot,
  findGitRootByDotGit,
  parseRepoNameFromUrl,
  sanitizeRepoName,
} from '../../src/storage/git.js';

// Mock child_process.execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe('git utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isGitRepo', () => {
    it('returns true when inside a git work tree', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from(''));
      expect(isGitRepo('/project')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('git rev-parse --is-inside-work-tree', {
        cwd: '/project',
        stdio: 'ignore',
      });
    });

    it('returns false when not a git repo', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not a git repo');
      });
      expect(isGitRepo('/not-a-repo')).toBe(false);
    });

    it('passes the correct cwd', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from(''));
      isGitRepo('/some/path');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: '/some/path' }),
      );
    });
  });

  describe('getCurrentCommit', () => {
    it('returns trimmed commit hash', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('abc123def\n'));
      expect(getCurrentCommit('/project')).toBe('abc123def');
    });

    it('returns empty string on error', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not a git repo');
      });
      expect(getCurrentCommit('/not-a-repo')).toBe('');
    });

    it('trims whitespace from output', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('  sha256hash  \n'));
      expect(getCurrentCommit('/project')).toBe('sha256hash');
    });
  });

  describe('getGitRoot', () => {
    it('returns resolved path on success', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/d/Projects/MyRepo\n'));
      const result = getGitRoot('/d/Projects/MyRepo/src');
      expect(result).toBeTruthy();
      // path.resolve normalizes the git output
      expect(typeof result).toBe('string');
    });

    it('returns null when not in a git repo', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not a git repo');
      });
      expect(getGitRoot('/not-a-repo')).toBeNull();
    });

    it('calls git rev-parse --show-toplevel', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/repo\n'));
      getGitRoot('/repo/src');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        expect.objectContaining({ cwd: '/repo/src' }),
      );
    });

    it('trims output before resolving path', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('  /repo  \n'));
      const result = getGitRoot('/repo/src');
      expect(result).not.toBeNull();
      expect(result!.trim()).toBe(result);
    });
  });

  describe('findGitRootByDotGit', () => {
    it('finds an ancestor .git directory without spawning git', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dotgit-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.git'));
        const nested = path.join(tmpDir, 'packages', 'app');
        fs.mkdirSync(nested, { recursive: true });

        expect(findGitRootByDotGit(nested)).toBe(path.resolve(tmpDir));
        expect(mockExecSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null outside a git worktree without spawning git', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-nonrepo-'));
      try {
        expect(findGitRootByDotGit(tmpDir)).toBeNull();
        expect(mockExecSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // Linked worktrees and submodules use a `.git` file (not directory) that
    // points at the real gitdir. statSync succeeds for both, so the ancestor
    // walk should treat such roots identically to ordinary repos.
    it('treats a .git file (linked worktree) as a valid root', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worktree-'));
      try {
        fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /fake/worktrees/wt\n');
        const nested = path.join(tmpDir, 'src', 'pkg');
        fs.mkdirSync(nested, { recursive: true });

        expect(findGitRootByDotGit(nested)).toBe(path.resolve(tmpDir));
        expect(mockExecSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null when the input path does not exist', () => {
      const missing = path.join(os.tmpdir(), `gitnexus-missing-${Date.now()}-${Math.random()}`);
      expect(findGitRootByDotGit(missing)).toBeNull();
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('walks from a file input by starting at its parent directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-fileinput-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.git'));
        const filePath = path.join(tmpDir, 'pkg', 'index.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export {};\n');

        expect(findGitRootByDotGit(filePath)).toBe(path.resolve(tmpDir));
        expect(mockExecSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('sanitizeRepoName', () => {
    it('strips leading dashes', () => {
      expect(sanitizeRepoName('--repo')).toBe('repo');
    });

    it('replaces unsafe characters with underscores', () => {
      expect(sanitizeRepoName('repo<tag>')).toBe('repo_tag_');
      expect(sanitizeRepoName('repo:name')).toBe('repo_name');
      expect(sanitizeRepoName('repo"quoted"')).toBe('repo_quoted_');
    });

    it('blocks path traversal segments', () => {
      expect(sanitizeRepoName('.')).toBe('unknown');
      expect(sanitizeRepoName('..')).toBe('unknown');
    });

    it('blocks Windows reserved names', () => {
      expect(sanitizeRepoName('CON')).toBe('unknown');
      expect(sanitizeRepoName('prn')).toBe('unknown');
      expect(sanitizeRepoName('AUX')).toBe('unknown');
      expect(sanitizeRepoName('NUL')).toBe('unknown');
      expect(sanitizeRepoName('COM1')).toBe('unknown');
      expect(sanitizeRepoName('LPT9')).toBe('unknown');

      // Reserved names with extensions
      expect(sanitizeRepoName('CON.txt')).toBe('unknown');
      expect(sanitizeRepoName('NUL.tar.gz')).toBe('unknown');
      expect(sanitizeRepoName('AUX.local')).toBe('unknown');
    });

    it('returns unknown for empty or invalid input', () => {
      expect(sanitizeRepoName('')).toBe('unknown');
      expect(sanitizeRepoName('---')).toBe('unknown');
    });
  });

  describe('parseRepoNameFromUrl', () => {
    it('extracts and sanitizes name from HTTPS URL', () => {
      expect(parseRepoNameFromUrl('https://github.com/user/my-repo.git')).toBe('my-repo');
      expect(parseRepoNameFromUrl('https://github.com/user/--payload.git')).toBe('payload');
    });

    it('extracts and sanitizes name from SSH URL', () => {
      expect(parseRepoNameFromUrl('git@github.com:user/my-repo.git')).toBe('my-repo');
      expect(parseRepoNameFromUrl('git@github.com:--payload.git')).toBe('payload');
    });

    it('returns null for all-dash inputs (prevents registry collision)', () => {
      expect(parseRepoNameFromUrl('https://github.com/user/---.git')).toBeNull();
    });

    it('returns null for empty URL', () => {
      expect(parseRepoNameFromUrl('')).toBeNull();
      expect(parseRepoNameFromUrl(null)).toBeNull();
    });
  });
});
