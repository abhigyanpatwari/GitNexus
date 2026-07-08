/**
 * Unit tests: removeCommand deletion order (PR #2363 review fix, F14)
 *
 * The documented contract (remove.ts header): fs.rm FIRST, then unregister.
 * A partial failure leaves the registry entry in place so the user can
 * retry (and `listRegisteredRepos({ validate: true })` self-heals a
 * rm-succeeded/unregister-failed orphan) — the registry must never be
 * unregistered while index files may still remain on disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mockRm = vi.fn();
const mockReadRegistry = vi.fn();
const mockResolveRegistryEntry = vi.fn();
const mockAssertSafeStoragePath = vi.fn();
const mockUnregisterRepo = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    rm: mockRm,
  },
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  readRegistry: mockReadRegistry,
  resolveRegistryEntry: mockResolveRegistryEntry,
  assertSafeStoragePath: mockAssertSafeStoragePath,
  unregisterRepo: mockUnregisterRepo,
  RegistryNotFoundError: class RegistryNotFoundError extends Error {},
  RegistryAmbiguousTargetError: class RegistryAmbiguousTargetError extends Error {},
  UnsafeStoragePathError: class UnsafeStoragePathError extends Error {},
}));

describe('removeCommand', () => {
  const repoPath = path.resolve('/repo');
  const entry = {
    name: 'repo',
    path: repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    process.exitCode = undefined;

    mockReadRegistry.mockResolvedValue([entry]);
    mockResolveRegistryEntry.mockReturnValue(entry);
    mockAssertSafeStoragePath.mockReturnValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockUnregisterRepo.mockResolvedValue(undefined);
  });

  it('removes the whole .gitnexus/ directory recursively, then unregisters', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { removeCommand } = await import('../../src/cli/remove.js');
    await removeCommand('repo', { force: true });

    expect(mockRm).toHaveBeenCalledWith(entry.storagePath, { recursive: true, force: true });
    expect(mockUnregisterRepo).toHaveBeenCalledWith(entry.path);
    // rm strictly precedes unregister (retryable partial-failure contract).
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnregisterRepo.mock.invocationCallOrder[0],
    );
    // No pre-unlink of individual metadata files — fs.rm removes both
    // gitnexus.json and the legacy meta.json mirror with the directory.
    expect(mockRm).toHaveBeenCalledTimes(1);
  });

  it('does NOT unregister when fs.rm fails (entry stays for retry)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
    err.code = 'EBUSY';
    mockRm.mockRejectedValue(err);

    const { removeCommand } = await import('../../src/cli/remove.js');
    await removeCommand('repo', { force: true });

    expect(mockUnregisterRepo).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
