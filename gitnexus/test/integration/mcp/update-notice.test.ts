import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../../../src/mcp/server.js';
import type { UpdateState } from '../../../src/core/update-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface FakeChecker {
  evaluate: () => Promise<UpdateState | null>;
  armUpdateRefreshScheduler: (onState: (state: UpdateState | null) => void) => () => void;
}

interface FakeLogger {
  info: ReturnType<typeof vi.fn>;
}

function checker(initial: UpdateState | null): {
  service: FakeChecker;
  publish: (state: UpdateState | null) => void;
  stop: ReturnType<typeof vi.fn>;
} {
  let subscriber: ((state: UpdateState | null) => void) | undefined;
  const stop = vi.fn();
  return {
    service: {
      evaluate: vi.fn().mockResolvedValue(initial),
      armUpdateRefreshScheduler: vi.fn((onState) => {
        subscriber = onState;
        return stop;
      }),
    },
    publish: (state) => subscriber?.(state),
    stop,
  };
}

function mockBackend() {
  return {
    callTool: vi
      .fn()
      .mockImplementation(async (name: string) =>
        name === 'list_repos'
          ? { repositories: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } }
          : { ok: true },
      ),
    listRepos: vi.fn().mockResolvedValue([]),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    selectToolRepository: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

async function protocolSnapshot(pendingUpdate: boolean): Promise<string> {
  const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');
  const backend = mockBackend();
  const server = createMCPServer(backend as never);
  const client = new Client({ name: 'update-snapshot', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const log = { info: vi.fn() };
  const fake = checker(pendingUpdate ? { updateAvailable: true, latestVersion: '99.0.0' } : null);

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await startMcpUpdateNotifier(log, async () => fake.service);

    const snapshot = {
      initialize: {
        serverInfo: client.getServerVersion(),
        capabilities: client.getServerCapabilities(),
      },
      tools: await client.listTools(),
      resources: await client.listResources(),
      resource: await client.readResource({ uri: 'gitnexus://repos' }),
      prompts: await client.listPrompts(),
      call: await client.callTool({ name: 'list_repos', arguments: { limit: 5 } }),
    };
    return JSON.stringify(snapshot);
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../../src/mcp/server.js');
  vi.doUnmock('../../../src/mcp/local/local-backend.js');
  vi.doUnmock('../../../src/mcp/repository-policy.js');
  vi.doUnmock('../../../src/mcp/http-transport.js');
  vi.doUnmock('../../../src/core/logger.js');
  vi.doUnmock('../../../src/core/update-check.js');
});

describe('MCP process update notice', () => {
  it('keeps the full protocol surface byte-identical with and without a cached update', async () => {
    expect(await protocolSnapshot(true)).toBe(await protocolSnapshot(false));
  });

  it.each(['CI', 'GITNEXUS_NO_UPDATE_NOTIFIER'])(
    'emits no log and performs no fetch when %s is set',
    async (name) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-update-guard-'));
      fs.writeFileSync(
        path.join(home, 'update-check.json'),
        `${JSON.stringify({
          lastCheckAt: new Date().toISOString(),
          registry: 'https://registry.npmjs.org',
          latestVersion: '99.0.0',
        })}\n`,
      );
      const previousHome = process.env.GITNEXUS_HOME;
      const previousCi = process.env.CI;
      const previousOptOut = process.env.GITNEXUS_NO_UPDATE_NOTIFIER;
      const fetchStub = vi.fn();
      vi.stubGlobal('fetch', fetchStub);
      process.env.GITNEXUS_HOME = home;
      process.env[name] = '1';
      if (name !== 'CI') delete process.env.CI;
      const actualChecker = await vi.importActual<
        typeof import('../../../src/core/update-check.js')
      >('../../../src/core/update-check.js');
      const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');
      const log: FakeLogger = { info: vi.fn() };

      try {
        await startMcpUpdateNotifier(log, async () => actualChecker);
        expect(log.info).not.toHaveBeenCalled();
        expect(fetchStub).not.toHaveBeenCalled();
      } finally {
        if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
        else process.env.GITNEXUS_HOME = previousHome;
        if (previousCi === undefined) delete process.env.CI;
        else process.env.CI = previousCi;
        if (previousOptOut === undefined) delete process.env.GITNEXUS_NO_UPDATE_NOTIFIER;
        else process.env.GITNEXUS_NO_UPDATE_NOTIFIER = previousOptOut;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('emits one structured stderr logger event per process per newer version', async () => {
    const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');
    const log: FakeLogger = { info: vi.fn() };
    const first = checker({ updateAvailable: true, latestVersion: '9.0.0' });
    const second = checker({ updateAvailable: true, latestVersion: '9.0.0' });

    await startMcpUpdateNotifier(log, async () => first.service);
    first.publish({ updateAvailable: true, latestVersion: '9.0.0' });
    await startMcpUpdateNotifier(log, async () => second.service);
    second.publish({ updateAvailable: true, latestVersion: '10.0.0' });
    second.publish({ updateAvailable: true, latestVersion: '10.0.0' });

    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      { event: 'gitnexus.update_available', latestVersion: '9.0.0' },
      'GitNexus update available',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      { event: 'gitnexus.update_available', latestVersion: '10.0.0' },
      'GitNexus update available',
    );
  });

  it('uses only the logger channel and never writes directly to stdout', async () => {
    const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');
    const stdout = vi.spyOn(process.stdout, 'write');
    const log: FakeLogger = { info: vi.fn() };
    const fake = checker({ updateAvailable: true, latestVersion: '11.0.0' });

    await startMcpUpdateNotifier(log, async () => fake.service);

    expect(stdout).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('catch-isolates checker import, evaluation, logger, and scheduler failures', async () => {
    const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');

    await expect(
      startMcpUpdateNotifier({ info: vi.fn() }, async () => {
        throw new Error('import failed');
      }),
    ).resolves.toBeUndefined();

    await expect(
      startMcpUpdateNotifier({ info: vi.fn() }, async () => ({
        evaluate: vi.fn().mockRejectedValue(new Error('evaluation failed')),
        armUpdateRefreshScheduler: vi.fn(() => () => {}),
      })),
    ).resolves.toBeUndefined();

    await expect(
      startMcpUpdateNotifier(
        {
          info: vi.fn(() => {
            throw new Error('logger failed');
          }),
        },
        async () => ({
          evaluate: vi.fn().mockResolvedValue({
            updateAvailable: true,
            latestVersion: '12.0.0',
          }),
          armUpdateRefreshScheduler: vi.fn(() => () => {}),
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      startMcpUpdateNotifier({ info: vi.fn() }, async () => ({
        evaluate: vi.fn().mockResolvedValue(null),
        armUpdateRefreshScheduler: vi.fn(() => {
          throw new Error('scheduler failed');
        }),
      })),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['stdio', 'hang'],
    ['http', 'fail'],
  ] as const)(
    'starts %s notifier work only after its startup boundary and never awaits a registry %s',
    async (transport, registryBehavior) => {
      const order: string[] = [];
      let evaluateStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        evaluateStarted = resolve;
      });
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-update-'));
      const previousHome = process.env.GITNEXUS_HOME;
      const previousCi = process.env.CI;
      let releaseFetch: ((response: Response) => void) | undefined;
      const fetchStub = vi.fn(() =>
        registryBehavior === 'hang'
          ? new Promise<Response>((resolve) => {
              releaseFetch = resolve;
            })
          : Promise.reject(new Error('registry unavailable')),
      );
      vi.stubGlobal('fetch', fetchStub);
      process.env.GITNEXUS_HOME = home;
      delete process.env.CI;
      const actualChecker = await vi.importActual<
        typeof import('../../../src/core/update-check.js')
      >('../../../src/core/update-check.js');

      vi.doMock('../../../src/mcp/server.js', () => ({
        startMCPServer: vi.fn(async () => {
          order.push('stdio-connected');
        }),
      }));
      vi.doMock('../../../src/mcp/local/local-backend.js', () => ({
        LocalBackend: class {
          async init() {}
          async listRepos() {
            return [];
          }
        },
      }));
      vi.doMock('../../../src/mcp/repository-policy.js', () => ({
        createMcpRepositoryPolicy: vi.fn(async () => ({
          scopeBackend: (backend: unknown) => backend,
        })),
      }));
      vi.doMock('../../../src/core/logger.js', () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }));
      vi.doMock('../../../src/mcp/http-transport.js', () => ({
        resolveAuthToken: vi.fn(),
        startMcpHttpServer: vi.fn(async () => {
          order.push('http-listening');
        }),
      }));
      vi.doMock('../../../src/core/update-check.js', () => ({
        ...actualChecker,
        evaluate: vi.fn(() => {
          order.push('evaluate');
          evaluateStarted();
          return actualChecker.evaluate({ eligible: true });
        }),
        armUpdateRefreshScheduler: vi.fn(() => () => {}),
      }));

      try {
        const { mcpCommand } = await import('../../../src/cli/mcp.js');
        await expect(
          mcpCommand(transport === 'http' ? { http: true, port: '3000' } : undefined),
        ).resolves.toBeUndefined();
        await started;
        await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledOnce());

        expect(order).toEqual([
          transport === 'http' ? 'http-listening' : 'stdio-connected',
          'evaluate',
        ]);
      } finally {
        if (releaseFetch) {
          releaseFetch(new Response('', { status: 503 }));
          await actualChecker.refresh({ eligible: true });
        }
        if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
        else process.env.GITNEXUS_HOME = previousHome;
        if (previousCi === undefined) delete process.env.CI;
        else process.env.CI = previousCi;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('wires the scheduler stop function into process exit', async () => {
    const { startMcpUpdateNotifier } = await import('../../../src/cli/mcp.js');
    const fake = checker(null);
    const before = new Set(process.listeners('exit'));

    await startMcpUpdateNotifier({ info: vi.fn() }, async () => fake.service);
    const added = process.listeners('exit').filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);

    added[0](0);
    expect(fake.stop).toHaveBeenCalledOnce();
    process.removeListener('exit', added[0]);
  });

  it('uses an unrefd scheduler timer so an opted-out MCP process can exit', async () => {
    const script = [
      "import { startMcpUpdateNotifier } from './dist/cli/mcp.js';",
      'await startMcpUpdateNotifier({ info() {} });',
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITNEXUS_NO_UPDATE_NOTIFIER: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('MCP notifier scheduler kept the child process alive'));
      }, 2_000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stderr });
      });
    });

    expect(result).toEqual({ code: 0, stderr: '' });
  });
});
