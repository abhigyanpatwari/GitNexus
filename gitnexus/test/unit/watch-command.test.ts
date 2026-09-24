import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSync = vi.hoisted(() => ({
  startAutoSyncWatch: vi.fn(),
}));

vi.mock('../../src/core/auto-sync/index.js', () => ({
  getAutoSyncConfigPath: vi.fn(() => '/tmp/watch_config.yml'),
  getAutoSyncMutexPath: vi.fn(() => '/tmp/watch.mutex'),
  readAutoSyncWatchStatus: vi.fn(),
  resetAutoSyncState: vi.fn(),
  startAutoSyncWatch: autoSync.startAutoSyncWatch,
  stopAutoSyncWatch: vi.fn(),
}));

import { autoSyncCommand } from '../../src/cli/auto-sync.js';

describe('auto-sync command', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('reports foreground stop failures and exits non-zero', async () => {
    const stop = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    autoSync.startAutoSyncWatch.mockResolvedValue({ stop });
    let signalHandler: (() => void) | undefined;
    vi.spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') signalHandler = listener as () => void;
      return process;
    }) as typeof process.once);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await autoSyncCommand('start');
    signalHandler?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith('[auto-sync] Failed to stop watch: cleanup failed\n');
    expect(stderr).not.toHaveBeenCalledWith('[auto-sync] Watch stopped.\n');
  });
});
