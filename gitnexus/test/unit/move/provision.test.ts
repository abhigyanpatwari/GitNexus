import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('retries after a rejected installation', async () => {
    delete process.env.MOVE_FLOW;
    const install = vi
      .fn<MoveFlowProvisionDependencies['install']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ status: 'installed', binary: cached });
    const deps = dependencies({ install });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({ client });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('retries after a soft installation failure', async () => {
    delete process.env.MOVE_FLOW;
    const install = vi
      .fn<MoveFlowProvisionDependencies['install']>()
      .mockResolvedValueOnce({ status: 'failed', message: 'checksum service unavailable' })
      .mockResolvedValueOnce({ status: 'installed', binary: cached });
    const deps = dependencies({ install });

    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toBeNull();
    await expect(ensureMoveFlowRuntime({}, deps)).resolves.toMatchObject({ client });
    expect(install).toHaveBeenCalledTimes(2);
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
