import { createRequire } from 'node:module';
import { armUpdateRefreshScheduler, evaluate, type UpdateState } from '../core/update-check.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');

export interface ServerInfoResponse {
  version: string;
  launchContext: 'npx' | 'global' | 'local';
  nodeVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
}

interface ServeUpdateControllerDependencies {
  evaluate: (options?: { refreshIfStale?: boolean }) => Promise<UpdateState | null>;
  armScheduler: (onState: (state: UpdateState | null) => void) => () => void;
}

export interface ServeUpdateController {
  start: () => Promise<void>;
  stop: () => void;
  snapshot: () => UpdateState | null;
}

/**
 * Own the update state for one `serve` process. The route reads snapshot()
 * synchronously; all cache and network work stays on the startup/scheduler path.
 */
export const createServeUpdateController = (
  dependencies: ServeUpdateControllerDependencies = {
    evaluate,
    armScheduler: armUpdateRefreshScheduler,
  },
): ServeUpdateController => {
  let updateState: UpdateState | null = null;
  let stopScheduler: (() => void) | undefined;
  let started = false;
  let stopped = false;

  return {
    start: async () => {
      if (started || stopped) return;
      started = true;
      try {
        // Cache-only: the scheduler's first cycle owns any stale refresh.
        updateState = await dependencies.evaluate({ refreshIfStale: false });
      } catch {
        updateState = null;
      }
      if (stopped) return;
      try {
        stopScheduler = dependencies.armScheduler((state) => {
          if (
            state?.updateAvailable !== updateState?.updateAvailable ||
            state?.latestVersion !== updateState?.latestVersion
          ) {
            updateState = state;
          }
        });
      } catch {
        // Update checks are best-effort and never affect HTTP availability.
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        stopScheduler?.();
      } catch {
        // Shutdown must continue even if notifier cleanup unexpectedly fails.
      }
    },
    snapshot: () => updateState,
  };
};

export const buildServerInfo = (updateState: UpdateState | null): ServerInfoResponse => {
  const execPath = process.env.npm_execpath ?? '';
  const argv0 = process.argv[1] ?? '';
  let launchContext: 'npx' | 'global' | 'local';
  if (
    execPath.includes('npx') ||
    argv0.includes('_npx') ||
    process.env.npm_config_prefix?.includes('_npx')
  ) {
    launchContext = 'npx';
  } else if (argv0.includes('node_modules')) {
    launchContext = 'local';
  } else {
    launchContext = 'global';
  }

  return {
    version: pkg.version,
    launchContext,
    nodeVersion: process.version,
    ...(updateState?.updateAvailable && updateState.latestVersion
      ? { latestVersion: updateState.latestVersion, updateAvailable: true }
      : {}),
  };
};

export const bindServeUpdateControllerLifecycle = (
  server: {
    once(event: 'listening' | 'close', listener: () => void): unknown;
  },
  controller: ServeUpdateController,
): void => {
  server.once('listening', () => void controller.start());
  server.once('close', controller.stop);
};
