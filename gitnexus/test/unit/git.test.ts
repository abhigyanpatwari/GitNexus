import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { isGitRepo, getCurrentCommit, getGitRoot } from '../../src/storage/git.js';

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
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse --is-inside-work-tree',
        { cwd: '/project', stdio: 'ignore' }
      );
    });

    it('returns false when not a git repo', () => {
      mockExecSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
      expect(isGitRepo('/not-a-repo')).toBe(false);
    });

    it('passes the correct cwd', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from(''));
      isGitRepo('/some/path');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: '/some/path' })
      );
    });
  });

  describe('getCurrentCommit', () => {
    it('returns trimmed commit hash', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('abc123def\n'));
      expect(getCurrentCommit('/project')).toBe('abc123def');
    });

    it('returns empty string on error', () => {
      mockExecSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
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
      mockExecSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
      expect(getGitRoot('/not-a-repo')).toBeNull();
    });

    it('calls git rev-parse --show-toplevel', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/repo\n'));
      getGitRoot('/repo/src');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        expect.objectContaining({ cwd: '/repo/src' })
      );
    });

    it('trims output before resolving path', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('  /repo  \n'));
      const result = getGitRoot('/repo/src');
      expect(result).not.toBeNull();
      expect(result!.trim()).toBe(result);
    });
  });
});
