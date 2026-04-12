/**
 * Shared repository lock for background index jobs.
 *
 * The lock key should be stable across analyze/embed callers. In practice we
 * use the storage path so both tasks serialize access to the same LadybugDB.
 */
export class RepoLockManager {
  private activeRepoPaths = new Set<string>();

  acquire(repoPath: string): string | null {
    if (this.activeRepoPaths.has(repoPath)) {
      return 'Another job is already active for this repository';
    }

    this.activeRepoPaths.add(repoPath);
    return null;
  }

  release(repoPath: string): void {
    this.activeRepoPaths.delete(repoPath);
  }

  isLocked(repoPath: string): boolean {
    return this.activeRepoPaths.has(repoPath);
  }
}
