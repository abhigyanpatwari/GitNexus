import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

// Keep PATH-resolution tests independent of a developer or CI cache that may
// already contain vendor/move-flow/<platform>/move-flow.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

import {
  MoveFlowMcpClient,
  MoveFlowToolCallError,
  tryCreateMoveFlowClient,
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

describe('tryCreateMoveFlowClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.MOVE_FLOW;
  });

  it('returns MoveFlowMcpClient when binary is found', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const client = tryCreateMoveFlowClient();
    expect(client).toBeInstanceOf(MoveFlowMcpClient);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'move-flow',
      ['--version'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('returns null when binary is not found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(tryCreateMoveFlowClient()).toBeNull();
  });

  it.each([
    '/usr/local/bin/move-flow',
    'C:\\Program Files\\move-flow.exe',
    'move-flow;literal-name',
  ])('passes an explicit binary path directly to execFileSync: %s', (binary) => {
    process.env.MOVE_FLOW = binary;
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const client = tryCreateMoveFlowClient();
    expect(client).toBeInstanceOf(MoveFlowMcpClient);
    expect(mockExecFileSync).toHaveBeenCalledWith(binary, ['--version'], {
      stdio: 'ignore',
      timeout: 5000,
    });
  });
});

describe('MoveFlowMcpClient', () => {
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
});

describe('detectMoveFlowCapabilities', () => {
  it('reports facts support from a standalone move_package_facts tool name', () => {
    const caps = detectMoveFlowCapabilities(['move_package_query', 'move_package_facts']);
    expect(caps.hasFactsQuery).toBe(true);
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
              oneOf: [{ const: 'module_summary' }, { const: 'call_graph' }, { const: 'facts' }],
            },
          },
        },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
  });

  it('also detects facts from a flat enum schema', () => {
    const caps = detectMoveFlowCapabilities([
      {
        name: 'move_package_query',
        inputSchema: { properties: { query: { enum: ['module_summary', 'facts'] } } },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
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
  });

  it('reports facts absent when move_package_query is missing entirely', () => {
    const caps = detectMoveFlowCapabilities(['move_package_status']);
    expect(caps.hasFactsQuery).toBe(false);
    expect(caps.hasStatusTool).toBe(true);
  });

  it('reports the status tool absent on older builds that do not list it', () => {
    const caps = detectMoveFlowCapabilities(['move_package_query']);
    expect(caps.hasStatusTool).toBe(false);
  });
});
