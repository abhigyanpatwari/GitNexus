import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoveFlowMcpClient } from '../../../src/core/move/mcp-client.js';
import {
  ensureMoveFlowClient,
  type MoveFlowProvisionDependencies,
} from '../../../src/core/move/provision.js';

const originalMoveFlow = process.env.MOVE_FLOW;

afterEach(() => {
  if (originalMoveFlow === undefined) delete process.env.MOVE_FLOW;
  else process.env.MOVE_FLOW = originalMoveFlow;
});

const client = {} as MoveFlowMcpClient;

describe('ensureMoveFlowClient', () => {
  it('does not install when an explicit or PATH binary already resolves', async () => {
    const dependencies: MoveFlowProvisionDependencies = {
      resolveClient: vi.fn(() => client),
      findCached: vi.fn(async () => null),
      install: vi.fn(),
    };

    await expect(ensureMoveFlowClient({}, dependencies)).resolves.toBe(client);
    expect(dependencies.install).not.toHaveBeenCalled();
  });

  it('keeps an invalid explicit MOVE_FLOW authoritative', async () => {
    process.env.MOVE_FLOW = '/missing/move-flow';
    const dependencies: MoveFlowProvisionDependencies = {
      resolveClient: vi.fn(() => null),
      findCached: vi.fn(async () => null),
      install: vi.fn(),
    };

    await expect(ensureMoveFlowClient({}, dependencies)).resolves.toBeNull();
    expect(dependencies.install).not.toHaveBeenCalled();
    expect(process.env.MOVE_FLOW).toBe('/missing/move-flow');
  });

  it('installs once, publishes the cache path to the resolver, and returns a client', async () => {
    delete process.env.MOVE_FLOW;
    const resolveClient = vi
      .fn<(binaryPath?: string) => MoveFlowMcpClient | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(client);
    const install = vi.fn(async () => ({
      status: 'installed' as const,
      binaryPath: '/cache/move-flow',
    }));

    await expect(
      ensureMoveFlowClient({}, { resolveClient, findCached: async () => null, install }),
    ).resolves.toBe(client);
    expect(install).toHaveBeenCalledOnce();
    expect(resolveClient).toHaveBeenLastCalledWith('/cache/move-flow');
    expect(process.env.MOVE_FLOW).toBeUndefined();
  });

  it('soft-fails when installation rejects', async () => {
    delete process.env.MOVE_FLOW;
    const onLog = vi.fn();
    const dependencies: MoveFlowProvisionDependencies = {
      resolveClient: vi.fn(() => null),
      findCached: vi.fn(async () => null),
      install: vi.fn(async () => {
        throw new Error('offline');
      }),
    };

    await expect(ensureMoveFlowClient({ onLog }, dependencies)).resolves.toBeNull();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('does not retry a failed installation within the same process', async () => {
    delete process.env.MOVE_FLOW;
    const dependencies: MoveFlowProvisionDependencies = {
      resolveClient: vi.fn(() => null),
      findCached: vi.fn(async () => null),
      install: vi.fn(async () => {
        throw new Error('offline');
      }),
    };

    await expect(ensureMoveFlowClient({}, dependencies)).resolves.toBeNull();
    await expect(ensureMoveFlowClient({}, dependencies)).resolves.toBeNull();
    expect(dependencies.install).toHaveBeenCalledOnce();
  });

  it('uses the verified user cache before PATH candidates', async () => {
    delete process.env.MOVE_FLOW;
    const resolveClient = vi.fn((binaryPath?: string) =>
      binaryPath === '/cache/move-flow' ? client : null,
    );
    const dependencies: MoveFlowProvisionDependencies = {
      resolveClient,
      findCached: vi.fn(async () => '/cache/move-flow'),
      install: vi.fn(),
    };

    await expect(ensureMoveFlowClient({}, dependencies)).resolves.toBe(client);
    expect(resolveClient).toHaveBeenCalledTimes(1);
    expect(resolveClient).toHaveBeenCalledWith('/cache/move-flow');
    expect(dependencies.install).not.toHaveBeenCalled();
  });
});
