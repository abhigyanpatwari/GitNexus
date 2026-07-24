import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MoveFlowMcpClient,
  ResolvedMoveFlowClient,
} from '../../../src/core/move/mcp-client.js';
import {
  ensureMoveFlowRuntime,
  type MoveFlowProvisionDependencies,
} from '../../../src/core/move/provision.js';
import type { VerifiedMoveFlowBinary } from '../../../src/core/move/install.js';

const originalMoveFlow = process.env.MOVE_FLOW;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalMoveFlow === undefined) delete process.env.MOVE_FLOW;
  else process.env.MOVE_FLOW = originalMoveFlow;
});

const client = {} as MoveFlowMcpClient;
const resolved: ResolvedMoveFlowClient = { client, version: '2.0.0' };
const cached: VerifiedMoveFlowBinary = {
  binaryPath: '/cache/move-flow',
  version: '2.0.0',
  fingerprint: 'release-fingerprint',
};

const dependencies = (
  overrides: Partial<MoveFlowProvisionDependencies> = {},
): MoveFlowProvisionDependencies => ({
  resolveClient: vi.fn(() => null),
  createClient: vi.fn(() => client),
  findCached: vi.fn(async () => null),
  install: vi.fn(async () => ({ status: 'failed', message: 'offline' })),
  ...overrides,
});

describe('ensureMoveFlowRuntime', () => {
  it('does not install when an explicit or PATH binary already resolves', async () => {
    const deps = dependencies({ resolveClient: vi.fn(() => resolved) });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({ client });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('logs when the resolved binary cannot be read for fingerprinting', async () => {
    // A resolver that answers for a locator whose file does not exist: the
    // digest falls back to a random 'unverifiable' value, which churns the
    // fingerprint (full re-index every run) - that must not stay silent.
    process.env.MOVE_FLOW = '/missing/move-flow';
    const deps = dependencies({ resolveClient: vi.fn(() => resolved) });
    const onLog = vi.fn();

    const runtime = await ensureMoveFlowRuntime({ onLog }, deps);

    expect(runtime?.client).toBe(client);
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining('could not be read for fingerprinting'),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'fingerprints local compiler bytes, not only path and version',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'move-flow-identity-'));
      const binary = path.join(directory, 'move-flow');
      try {
        process.env.MOVE_FLOW = binary;
        await writeFile(binary, '#!/bin/sh\necho first\n');
        await chmod(binary, 0o755);
        const deps = dependencies({ resolveClient: vi.fn(() => resolved) });
        const first = await ensureMoveFlowRuntime({}, deps);

        await writeFile(binary, '#!/bin/sh\necho second\n');
        await chmod(binary, 0o755);
        const second = await ensureMoveFlowRuntime({}, deps);
        expect(second?.identity.fingerprint).not.toBe(first?.identity.fingerprint);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('fingerprints a Windows PATH locator that already includes its executable extension', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'move-flow-windows-identity-'));
    const binary = path.join(directory, 'move-flow.exe');
    try {
      await writeFile(binary, 'stable move-flow bytes');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.stubEnv('MOVE_FLOW', 'move-flow.exe');
      vi.stubEnv('PATH', directory);
      vi.stubEnv('PATHEXT', '.exe');
      const deps = dependencies({ resolveClient: vi.fn(() => resolved) });

      const first = await ensureMoveFlowRuntime({}, deps);
      const second = await ensureMoveFlowRuntime({}, deps);

      expect(second?.identity.fingerprint).toBe(first?.identity.fingerprint);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an invalid explicit MOVE_FLOW authoritative', async () => {
    process.env.MOVE_FLOW = '/missing/move-flow';
    const deps = dependencies();

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    expect(deps.install).not.toHaveBeenCalled();
    expect(process.env.MOVE_FLOW).toBe('/missing/move-flow');
  });

  it('supports local-only resolution without starting installation', async () => {
    delete process.env.MOVE_FLOW;
    const deps = dependencies();

    await expect(ensureMoveFlowRuntime({ install: false }, deps)).resolves.toBeNull();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('installs once and returns the verified release identity', async () => {
    delete process.env.MOVE_FLOW;
    const deps = dependencies({
      install: vi.fn(async () => ({ status: 'installed' as const, binary: cached })),
    });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toEqual({
      client,
      identity: {
        version: '2.0.0',
        source: 'release',
        fingerprint: 'release-fingerprint',
      },
    });
    expect(deps.install).toHaveBeenCalledOnce();
    expect(deps.createClient).toHaveBeenCalledWith('/cache/move-flow');
    expect(deps.resolveClient).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejected installation within the same process', async () => {
    delete process.env.MOVE_FLOW;
    const install = vi
      .fn<MoveFlowProvisionDependencies['install']>()
      .mockRejectedValue(new Error('offline'));
    const deps = dependencies({ install });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    expect(install).toHaveBeenCalledOnce();
  });

  it('does not retry a soft installation failure within the same process', async () => {
    delete process.env.MOVE_FLOW;
    const install = vi
      .fn<MoveFlowProvisionDependencies['install']>()
      .mockResolvedValue({ status: 'failed', message: 'checksum service unavailable' });
    const deps = dependencies({ install });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    expect(install).toHaveBeenCalledOnce();
  });

  it('shares only an in-flight install attempt', async () => {
    delete process.env.MOVE_FLOW;
    let finish!: (value: { status: 'installed'; binary: VerifiedMoveFlowBinary }) => void;
    const pending = new Promise<{ status: 'installed'; binary: VerifiedMoveFlowBinary }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const install = vi.fn(() => pending);
    const deps = dependencies({ install });

    const first = ensureMoveFlowRuntime({}, deps);
    const second = ensureMoveFlowRuntime({}, deps);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    finish({ status: 'installed', binary: cached });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(deps.createClient).toHaveBeenCalledTimes(2);
  });

  it('clears a successful install attempt so a later cache miss can reinstall', async () => {
    delete process.env.MOVE_FLOW;
    const install = vi.fn(async () => ({ status: 'installed' as const, binary: cached }));
    const deps = dependencies({ install });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({ client });
    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({ client });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('uses the verified cache without another version probe', async () => {
    delete process.env.MOVE_FLOW;
    const deps = dependencies({ findCached: vi.fn(async () => cached) });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({
      client,
      identity: { source: 'release', fingerprint: 'release-fingerprint' },
    });
    expect(deps.resolveClient).not.toHaveBeenCalled();
    expect(deps.createClient).toHaveBeenCalledWith('/cache/move-flow');
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('rejects an incompatible verified cache without constructing a client', async () => {
    delete process.env.MOVE_FLOW;
    const deps = dependencies({
      findCached: vi.fn(async () => ({ ...cached, version: '3.0.0' })),
    });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('rejects an incompatible installed result without constructing a client', async () => {
    delete process.env.MOVE_FLOW;
    const deps = dependencies({
      install: vi.fn(async () => ({
        status: 'installed' as const,
        binary: { ...cached, version: '3.0.0' },
      })),
    });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    expect(deps.createClient).not.toHaveBeenCalled();
  });
});
