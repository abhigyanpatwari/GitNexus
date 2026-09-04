import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindServeUpdateControllerLifecycle,
  buildServerInfo,
  createServeUpdateController,
} from '../../src/server/update-controller.js';
import { evaluate } from '../../src/core/update-check.js';
import type { UpdateState } from '../../src/core/update-check.js';

const baseKeys = ['version', 'launchContext', 'nodeVersion'];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GET /api/info update state', () => {
  it('keeps the existing three fields unchanged when no update is available', () => {
    const response = buildServerInfo(null);

    expect(Object.keys(response)).toEqual(baseKeys);
    expect(response).toEqual({
      version: '1.6.10',
      launchContext: expect.stringMatching(/^(npx|global|local)$/),
      nodeVersion: process.version,
    });
  });

  it('adds optional update fields only for an available version', () => {
    expect(buildServerInfo({ updateAvailable: true, latestVersion: '9.8.7' })).toEqual({
      version: '1.6.10',
      launchContext: expect.stringMatching(/^(npx|global|local)$/),
      nodeVersion: process.version,
      latestVersion: '9.8.7',
      updateAvailable: true,
    });

    expect(
      Object.keys(buildServerInfo({ updateAvailable: false, latestVersion: '1.6.10' })),
    ).toEqual(baseKeys);
  });

  it.each(['GITNEXUS_NO_UPDATE_NOTIFIER', 'NO_UPDATE_NOTIFIER', 'CI'])(
    'omits update fields after start when %s is set',
    async (name) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-serve-update-'));
      tempDirs.push(home);
      vi.stubEnv('GITNEXUS_HOME', home);
      vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org');
      vi.stubEnv(name, '1');
      await fs.writeFile(
        path.join(home, 'update-check.json'),
        JSON.stringify({
          lastCheckAt: new Date().toISOString(),
          registry: 'https://registry.npmjs.org',
          latestVersion: '9.9.9',
        }),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const evaluateSpy = vi.fn((options?: { refreshIfStale?: boolean }) =>
        evaluate({ ...options, eligible: true }),
      );
      const controller = createServeUpdateController({
        evaluate: evaluateSpy,
        armScheduler: vi.fn(() => vi.fn()),
      });

      await controller.start();

      expect(evaluateSpy).toHaveBeenCalledWith({ refreshIfStale: false });
      expect(Object.keys(buildServerInfo(controller.snapshot()))).toEqual(baseKeys);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('omits update fields after start for an ineligible install', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-serve-update-'));
    tempDirs.push(home);
    vi.stubEnv('GITNEXUS_HOME', home);
    vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org');
    vi.stubEnv('CI', '');
    await fs.writeFile(
      path.join(home, 'update-check.json'),
      JSON.stringify({
        lastCheckAt: new Date().toISOString(),
        registry: 'https://registry.npmjs.org',
        latestVersion: '9.9.9',
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const evaluateSpy = vi.fn((options?: { refreshIfStale?: boolean }) =>
      evaluate({ ...options, eligible: false }),
    );
    const controller = createServeUpdateController({
      evaluate: evaluateSpy,
      armScheduler: vi.fn(() => vi.fn()),
    });

    await controller.start();

    expect(evaluateSpy).toHaveBeenCalledWith({ refreshIfStale: false });
    expect(Object.keys(buildServerInfo(controller.snapshot()))).toEqual(baseKeys);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays assignable to the web client ServerInfo contract', () => {
    // Mirrors gitnexus-web/src/services/backend-client.ts without creating a
    // cross-package import that would couple either package's build graph.
    interface WebClientServerInfo {
      version: string;
      launchContext: 'npx' | 'global' | 'local';
      nodeVersion: string;
      latestVersion?: string;
      updateAvailable?: boolean;
    }

    const response: WebClientServerInfo = buildServerInfo({
      updateAvailable: true,
      latestVersion: '9.8.7',
    });
    expect(response.updateAvailable).toBe(true);
  });
});

describe('serve update controller lifecycle', () => {
  it('starts only after successful listen and stops whenever the server closes', async () => {
    const server = new EventEmitter();
    const controller = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      snapshot: vi.fn().mockReturnValue(null),
    };
    bindServeUpdateControllerLifecycle(server, controller);

    expect(controller.start).not.toHaveBeenCalled();

    server.emit('listening');
    expect(controller.start).toHaveBeenCalledOnce();

    server.emit('close');
    expect(controller.stop).toHaveBeenCalledOnce();
  });

  it('evaluates once before arming the scheduler and serves memory-only snapshots', async () => {
    const calls: string[] = [];
    let publish: ((state: UpdateState | null) => void) | undefined;
    const evaluate = vi.fn(async () => {
      calls.push('evaluate');
      return { updateAvailable: true, latestVersion: '2.0.0' };
    });
    const armScheduler = vi.fn((onState) => {
      calls.push('arm');
      publish = onState;
      return vi.fn();
    });
    const controller = createServeUpdateController({ evaluate, armScheduler });

    expect(controller.snapshot()).toBeNull();
    await controller.start();
    expect(calls).toEqual(['evaluate', 'arm']);
    expect(controller.snapshot()).toEqual({
      updateAvailable: true,
      latestVersion: '2.0.0',
    });

    publish?.({ updateAvailable: true, latestVersion: '2.1.0' });
    expect(controller.snapshot()).toEqual({
      updateAvailable: true,
      latestVersion: '2.1.0',
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({ refreshIfStale: false });
  });

  it('fails open and still arms the long-lived refresh scheduler', async () => {
    const armScheduler = vi.fn(() => vi.fn());
    const controller = createServeUpdateController({
      evaluate: vi.fn().mockRejectedValue(new Error('checker failed')),
      armScheduler,
    });

    await expect(controller.start()).resolves.toBeUndefined();
    expect(controller.snapshot()).toBeNull();
    expect(armScheduler).toHaveBeenCalledOnce();
    expect(Object.keys(buildServerInfo(controller.snapshot()))).toEqual(baseKeys);
  });

  it('stops the scheduler on shutdown and is idempotent', async () => {
    const stop = vi.fn();
    const controller = createServeUpdateController({
      evaluate: vi.fn().mockResolvedValue(null),
      armScheduler: vi.fn(() => stop),
    });

    await controller.start();
    controller.stop();
    controller.stop();

    expect(stop).toHaveBeenCalledOnce();
  });
});
