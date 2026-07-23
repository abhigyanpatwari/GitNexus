import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import {
  MoveFlowMcpClient,
  MoveFlowToolCallError,
  MoveFlowTransportError,
  tryResolveMoveFlowClient,
  detectMoveFlowCapabilities,
} from '../../../src/core/move/mcp-client.js';
import { spawn, execFileSync } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

describe('tryResolveMoveFlowClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.MOVE_FLOW;
  });

  it('resolves a client when the binary is found', () => {
    mockExecFileSync.mockReturnValue('move-flow 2.0.0');
    expect(tryResolveMoveFlowClient()?.client).toBeInstanceOf(MoveFlowMcpClient);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'move-flow',
      ['--version'],
      expect.objectContaining({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('returns the reported version with the resolved client', () => {
    mockExecFileSync.mockReturnValue('move-flow 2.3.4-rc1');

    expect(tryResolveMoveFlowClient('/custom/move-flow')).toMatchObject({
      client: expect.any(MoveFlowMcpClient),
      version: '2.3.4-rc1',
    });
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  it('returns null when binary is not found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(tryResolveMoveFlowClient()).toBeNull();
  });

  it.each([
    '/usr/local/bin/move-flow',
    'C:\\Program Files\\move-flow.exe',
    'move-flow;literal-name',
  ])('passes an explicit binary path directly to execFileSync: %s', (binary) => {
    process.env.MOVE_FLOW = binary;
    mockExecFileSync.mockReturnValue('move-flow 2.0.0');
    expect(tryResolveMoveFlowClient()?.client).toBeInstanceOf(MoveFlowMcpClient);
    expect(mockExecFileSync).toHaveBeenCalledWith(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  });

  it.each(['move-flow 1.9.9', 'move-flow 3.0.0', 'unknown build'])(
    'rejects an incompatible version response: %s',
    (versionOutput) => {
      mockExecFileSync.mockReturnValue(versionOutput);
      expect(tryResolveMoveFlowClient('/custom/move-flow')).toBeNull();
    },
  );

  it.each(['move-flow 2.0.0', 'move-flow 2.1.0-rc1', 'move-flow v2.3.4'])(
    'accepts a compatible-major version response: %s',
    (versionOutput) => {
      mockExecFileSync.mockReturnValue(versionOutput);
      expect(tryResolveMoveFlowClient('/custom/move-flow')?.client).toBeInstanceOf(
        MoveFlowMcpClient,
      );
    },
  );
});

describe('MoveFlowMcpClient', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    delete process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS;
  });

  it('shutdown clears all state', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const client = new MoveFlowMcpClient('move-flow');
    // Manually set internal state to simulate initialized client
    (client as any).proc = proc;
    (client as any).initialized = true;

    await client.shutdown();

    expect(proc.kill).toHaveBeenCalled();
    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);
  });

  it('shutdown is safe to call when not started', async () => {
    const client = new MoveFlowMcpClient('move-flow');
    await client.shutdown(); // Should not throw
  });

  /** Wire the mock server: reply to initialize, and to tools/call with `reply`. */
  function serveToolsCall(proc: any, reply: Record<string, unknown>): void {
    proc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (msg.method === 'tools/call') {
          proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
        }
      }
    });
  }

  it('kills and clears a timed-out initialization, ignores its late response, and retries', async () => {
    vi.useFakeTimers();
    const slowProc = createMockProc();
    const retryProc = createMockProc();
    mockSpawn.mockReturnValueOnce(slowProc as any).mockReturnValueOnce(retryProc as any);

    const client = new MoveFlowMcpClient('move-flow');
    const firstCall = client.facts('/slow');
    const firstFailure = expect(firstCall).rejects.toThrow(
      'move-flow MCP server did not respond within 30s',
    );

    await vi.advanceTimersByTimeAsync(30000);
    await firstFailure;

    expect(slowProc.kill).toHaveBeenCalledOnce();
    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);

    // The dead process may still flush an initialize response after the timer.
    // It must not resurrect the failed attempt or interfere with the retry.
    slowProc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    expect((client as any).initialized).toBe(false);
    expect((client as any).pending.size).toBe(0);

    serveToolsCall(retryProc, {
      result: { content: [{ type: 'text', text: '{"retry":"ok"}' }], isError: false },
    });
    await expect(client.facts('/retry')).resolves.toEqual({ retry: 'ok' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await client.shutdown();
  });

  it('honours the Move tool timeout override for large or test packages', async () => {
    vi.useFakeTimers();
    process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS = '25';
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    proc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
      }
    });

    const client = new MoveFlowMcpClient('move-flow');
    const request = client.facts('/slow');
    const failure = expect(request).rejects.toThrow(
      "move-flow 'move_package_query' timed out after 25ms",
    );

    await vi.advanceTimersByTimeAsync(25);
    await failure;
    expect(proc.kill).toHaveBeenCalledOnce();
    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);
    await client.shutdown();
  });

  it('retries unrelated in-flight requests when another request times out', async () => {
    vi.useFakeTimers();
    process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS = '25';
    const timedOutProc = createMockProc();
    const retryProc = createMockProc();
    mockSpawn.mockReturnValueOnce(timedOutProc as any).mockReturnValueOnce(retryProc as any);

    timedOutProc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          timedOutProc.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n',
          );
        }
      }
    });
    serveToolsCall(retryProc, {
      result: { content: [{ type: 'text', text: '{"retried":true}' }], isError: false },
    });

    const client = new MoveFlowMcpClient('move-flow');
    const first = client.facts('/first');
    const firstFailure = expect(first).rejects.toThrow(
      "move-flow 'move_package_query' timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(5);
    const secondSuccess = expect(client.facts('/second')).resolves.toEqual({ retried: true });

    await vi.advanceTimersByTimeAsync(20);
    await firstFailure;
    await secondSuccess;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('ignores a late response after a tool timeout and starts a fresh child', async () => {
    vi.useFakeTimers();
    process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS = '25';
    const timedOutProc = createMockProc();
    const retryProc = createMockProc();
    mockSpawn.mockReturnValueOnce(timedOutProc as any).mockReturnValueOnce(retryProc as any);

    timedOutProc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          timedOutProc.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n',
          );
        }
      }
    });
    const client = new MoveFlowMcpClient('move-flow');
    const first = client.facts('/slow');
    const failure = expect(first).rejects.toThrow("move-flow 'move_package_query' timed out");
    await vi.advanceTimersByTimeAsync(25);
    await failure;

    timedOutProc.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: '{"late":true}' }] },
      }) + '\n',
    );
    expect((client as any).pending.size).toBe(0);

    serveToolsCall(retryProc, {
      result: { content: [{ type: 'text', text: '{"fresh":true}' }], isError: false },
    });
    await expect(client.facts('/retry')).resolves.toEqual({ fresh: true });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('propagates a capabilities transport timeout and clears it for retry', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    proc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
      }
    });

    const client = new MoveFlowMcpClient('move-flow');
    const capabilities = client.capabilities();
    const failure = expect(capabilities).rejects.toThrow("move-flow 'tools/list' timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;

    expect(proc.kill).toHaveBeenCalledOnce();
    expect((client as any).capsPromise).toBeNull();
    expect((client as any).proc).toBeNull();
    await client.shutdown();
  });

  it('clears initialization state when move-flow exits during launch so the next call retries', async () => {
    const crashedProc = createMockProc();
    const retryProc = createMockProc();
    mockSpawn.mockReturnValueOnce(crashedProc as any).mockReturnValueOnce(retryProc as any);

    const client = new MoveFlowMcpClient('move-flow');
    const firstCall = client.facts('/crash');
    const firstFailure = expect(firstCall).rejects.toThrow(
      'move-flow exited with code 1 during init',
    );
    crashedProc.emit('exit', 1);
    await firstFailure;

    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);

    serveToolsCall(retryProc, {
      result: { content: [{ type: 'text', text: '{"retry":"ok"}' }], isError: false },
    });
    await expect(client.facts('/retry')).resolves.toEqual({ retry: 'ok' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await client.shutdown();
  });

  it('kills and clears initialization state when spawning move-flow emits an error', async () => {
    const failedProc = createMockProc();
    const retryProc = createMockProc();
    mockSpawn.mockReturnValueOnce(failedProc as any).mockReturnValueOnce(retryProc as any);

    const client = new MoveFlowMcpClient('move-flow');
    const firstCall = client.facts('/missing-binary');
    const firstFailure = expect(firstCall).rejects.toThrow(
      'Failed to spawn move-flow: spawn ENOENT',
    );
    failedProc.emit('error', new Error('spawn ENOENT'));
    await firstFailure;

    expect(failedProc.kill).toHaveBeenCalledOnce();
    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);

    serveToolsCall(retryProc, {
      result: { content: [{ type: 'text', text: '{"retry":"ok"}' }], isError: false },
    });
    await expect(client.facts('/retry')).resolves.toEqual({ retry: 'ok' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await client.shutdown();
  });

  it('rejects isError:true tool results as MoveFlowToolCallError instead of resolving the error text as data', async () => {
    // move-flow reports package build failures as a SUCCESS result with
    // isError:true; resolving its text would feed an error string to the facts
    // mapper and ingest per-character garbage Module nodes.
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    const client = new MoveFlowMcpClient('move-flow');
    serveToolsCall(proc, {
      result: {
        content: [{ type: 'text', text: 'failed to build package `/broken`: bad manifest' }],
        isError: true,
      },
    });

    await expect(client.facts('/broken')).rejects.toThrow(MoveFlowToolCallError);
    await expect(client.facts('/broken')).rejects.toThrow(
      'failed to build package `/broken`: bad manifest',
    );
    await client.shutdown();
  });

  it('classifies JSON-RPC -32602 (invalid_params) as MoveFlowToolCallError with the code attached', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    const client = new MoveFlowMcpClient('move-flow');
    serveToolsCall(proc, {
      error: { code: -32602, message: 'failed to build package `/broken`: no manifest' },
    });

    await expect(client.facts('/broken')).rejects.toMatchObject({
      name: 'MoveFlowToolCallError',
      code: -32602,
    });
    await client.shutdown();
  });

  it('rejects malformed function-usage payloads', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    const client = new MoveFlowMcpClient('move-flow');
    serveToolsCall(proc, {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              called: 'not-an-array',
              used: [],
            }),
          },
        ],
        isError: false,
      },
    });

    await expect(client.functionUsage('/pkg', 'm::f')).rejects.toThrow(MoveFlowToolCallError);
    await client.shutdown();
  });

  it('packageStatus reports ok on an isError:false status result', async () => {
    // move-flow returns "no errors or warnings" for a compiling package.
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    const client = new MoveFlowMcpClient('move-flow');
    serveToolsCall(proc, {
      result: { content: [{ type: 'text', text: 'no errors or warnings' }], isError: false },
    });

    await expect(client.packageStatus('/testonly')).resolves.toEqual({
      ok: true,
      diagnostics: 'no errors or warnings',
    });
    await client.shutdown();
  });

  it('packageStatus reports the compiler diagnostics on an isError:true status result', async () => {
    // move-flow returns the diagnostics as isError:true content text.
    const diagnostic = "error: unexpected token\n3 | }\nUnexpected '}'";
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);
    const client = new MoveFlowMcpClient('move-flow');
    serveToolsCall(proc, {
      result: { content: [{ type: 'text', text: diagnostic }], isError: true },
    });

    await expect(client.packageStatus('/broken')).resolves.toEqual({
      ok: false,
      diagnostics: diagnostic,
    });
    await client.shutdown();
  });

  it('retries a request once after a mid-flight transport crash', async () => {
    const crashProc = createMockProc();
    const freshProc = createMockProc();
    mockSpawn.mockReturnValueOnce(crashProc as any).mockReturnValueOnce(freshProc as any);

    crashProc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          crashProc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (msg.method === 'tools/call') {
          // Die mid-request instead of answering — a transport fault.
          crashProc.emit('exit', 137);
        }
      }
    });
    serveToolsCall(freshProc, {
      result: { content: [{ type: 'text', text: '{"fresh":true}' }], isError: false },
    });

    const client = new MoveFlowMcpClient('move-flow');
    await expect(client.facts('/pkg')).resolves.toEqual({ fresh: true });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('functionUsage does not retry a transport error', async () => {
    const crashProc = createMockProc();
    mockSpawn.mockReturnValueOnce(crashProc as any);

    crashProc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          crashProc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (msg.method === 'tools/call') {
          // Die mid-request — a transport fault, no retry should happen.
          crashProc.emit('exit', 137);
        }
      }
    });

    const client = new MoveFlowMcpClient('move-flow');
    await expect(client.functionUsage('/pkg', 'm::f')).rejects.toThrow(MoveFlowTransportError);
    // Exactly ONE spawn — no respawn/retry for functionUsage transport errors.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await client.shutdown();
  });

  it('rejects new requests after shutdown instead of respawning a child', async () => {
    const client = new MoveFlowMcpClient('move-flow');
    await client.shutdown();

    await expect(client.facts('/pkg')).rejects.toThrow('move-flow client is shut down');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('detectMoveFlowCapabilities', () => {
  it('reports facts support from a standalone move_package_facts tool name', () => {
    const caps = detectMoveFlowCapabilities(['move_package_query', 'move_package_facts']);
    expect(caps.hasFactsQuery).toBe(true);
    expect(caps.hasFunctionUsageQuery).toBe(false);
  });

  it('detects the facts query from the move_package_query inputSchema enum', () => {
    // Reflects reality: `facts` is a `const` in the QueryType `$defs`, not a tool.
    const caps = detectMoveFlowCapabilities([
      { name: 'move_package_manifest' },
      {
        name: 'move_package_query',
        inputSchema: {
          $defs: {
            QueryType: {
              oneOf: [
                { const: 'module_summary' },
                { const: 'call_graph' },
                { const: 'function_usage' },
                { const: 'facts' },
              ],
            },
          },
        },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
    expect(caps.hasFunctionUsageQuery).toBe(true);
  });

  it('also detects facts from a flat enum schema', () => {
    const caps = detectMoveFlowCapabilities([
      {
        name: 'move_package_query',
        inputSchema: {
          properties: { query: { enum: ['module_summary', 'function_usage', 'facts'] } },
        },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
    expect(caps.hasFunctionUsageQuery).toBe(true);
  });

  it('reports facts absent when the schema omits it', () => {
    const caps = detectMoveFlowCapabilities([
      {
        name: 'move_package_query',
        inputSchema: { $defs: { QueryType: { oneOf: [{ const: 'module_summary' }] } } },
      },
      'move_package_manifest',
    ]);
    expect(caps.hasFactsQuery).toBe(false);
    expect(caps.hasFunctionUsageQuery).toBe(false);
  });

  it('reports facts absent when move_package_query is missing entirely', () => {
    const caps = detectMoveFlowCapabilities(['move_package_status']);
    expect(caps.hasFactsQuery).toBe(false);
    expect(caps.hasFunctionUsageQuery).toBe(false);
    expect(caps.hasStatusTool).toBe(true);
  });

  it('reports the status tool absent on older builds that do not list it', () => {
    const caps = detectMoveFlowCapabilities(['move_package_query']);
    expect(caps.hasStatusTool).toBe(false);
  });
});
