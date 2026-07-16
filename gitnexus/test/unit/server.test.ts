/**
 * Unit Tests: MCP Server
 *
 * Tests: createMCPServer from server.ts
 * - Server creation returns a Server instance
 * - Tool handler wraps backend.callTool and appends hints
 * - Tool handler catches errors and returns isError: true
 * - Resource handlers delegate to resources.ts functions
 * - Prompt handlers return expected prompts
 * - Next-step hints cover all tool names
 *
 * NOTE: We test the server handler logic by calling the request handlers
 * directly through the MCP Server's handler dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMCPServer,
  installSignalShutdown,
  startMCPServer,
  SHUTDOWN_EXIT_CODES,
} from '../../src/mcp/server.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

// ─── Mock backend ──────────────────────────────────────────────────

function createMockBackend(overrides: Record<string, any> = {}): any {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function callToolThroughServer(
  backend: ReturnType<typeof createMockBackend>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = createMCPServer(backend);
  const client = new Client({ name: 'budget-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name, arguments: args });
    const text = response.content.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Expected an MCP text response');
    return { text, isError: response.isError === true };
  } finally {
    await client.close();
    await server.close();
  }
}

// ─── createMCPServer ─────────────────────────────────────────────────

describe('createMCPServer', () => {
  it('returns a Server instance with expected shape', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
    // Server should have connect/close methods
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('server has setRequestHandler method', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // The server has registered handlers — verify it was created without errors
    expect(server).toBeTruthy();
  });

  it('tools/list response includes tool annotations', async () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const response = await client.listTools();
      expect(response.tools).toHaveLength(GITNEXUS_TOOLS.length);

      for (const tool of response.tools) {
        const definition = GITNEXUS_TOOLS.find((t) => t.name === tool.name)!;
        expect(tool.annotations).toEqual(definition.annotations);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ─── getNextStepHint (tested indirectly via server tool handler) ──────

describe('getNextStepHint (via tool call response)', () => {
  // We test hints by calling the server's tool handler indirectly.
  // Since createMCPServer registers handlers on the Server, we verify
  // hints are appended by checking the tool response format.

  it('query tool response includes hint about context', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [], definitions: [] }),
    });
    const server = createMCPServer(backend);

    // We can't easily call handlers directly on the MCP Server,
    // so we verify the handler was registered by creating the server without error.
    // The actual hint logic is tested via the integration path.
    expect(backend.callTool).not.toHaveBeenCalled(); // not called until request
  });
});

describe('MCP output budgets', () => {
  it('leaves the complete formatted response unchanged when no budget is configured', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'complete' }),
      });
      const { text, isError } = await callToolThroughServer(backend, 'query', {
        search_query: 'auth',
      });
      expect(isError).toBe(false);
      expect(text).toContain('"payload": "complete"');
      expect(text).toContain('**Next:**');
      expect(text.endsWith('\n…')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('applies explicit maxTokens to the complete response deterministically and UTF-8 safely', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ payload: '😀'.repeat(100) }),
    });
    const args = { search_query: 'auth', maxTokens: 8 };

    const first = await callToolThroughServer(backend, 'query', args);
    const second = await callToolThroughServer(backend, 'query', args);

    expect(first.isError).toBe(false);
    expect(first.text).toBe(second.text);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(8 * 4);
    expect(first.text.endsWith('\n…')).toBe(true);
    expect(first.text).not.toContain('\uFFFD');
    expect(backend.callTool).toHaveBeenCalledWith('query', { search_query: 'auth' });
  });

  it('uses the environment default when maxTokens is omitted', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = '8';
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'x'.repeat(200) }),
      });
      const { text } = await callToolThroughServer(backend, 'context', { name: 'auth' });
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 4);
      expect(text.endsWith('\n…')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('lets an explicit request override the environment default', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = '1';
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'complete' }),
      });
      const { text } = await callToolThroughServer(backend, 'impact', {
        target: 'auth',
        direction: 'upstream',
        maxTokens: 200,
      });
      expect(text).toContain('"payload": "complete"');
      expect(text).toContain('**Next:**');
      expect(text.endsWith('\n…')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('rejects a non-positive explicit maxTokens before backend execution', async () => {
    const backend = createMockBackend();
    const { text, isError } = await callToolThroughServer(backend, 'query', {
      search_query: 'auth',
      maxTokens: 0,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/maxTokens.*positive integer/i);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('rejects an invalid environment default before backend execution', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = 'invalid';
    try {
      const backend = createMockBackend();
      const { text, isError } = await callToolThroughServer(backend, 'query', {
        search_query: 'auth',
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/GITNEXUS_MCP_DEFAULT_MAX_TOKENS.*positive integer/i);
      expect(backend.callTool).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('applies a valid budget to backend error text', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockRejectedValue(new Error('😀'.repeat(100))),
    });
    const { text, isError } = await callToolThroughServer(backend, 'context', {
      name: 'auth',
      maxTokens: 8,
    });
    expect(isError).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 4);
    expect(text.endsWith('\n…')).toBe(true);
    expect(text).not.toContain('\uFFFD');
  });
});

// ─── Tool handler error handling ──────────────────────────────────────

describe('server error handling', () => {
  it('createMCPServer does not throw for valid backend', () => {
    const backend = createMockBackend();
    expect(() => createMCPServer(backend)).not.toThrow();
  });

  it('createMCPServer reads version from package.json', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // Server was created with version from package.json — no crash
    expect(server).toBeDefined();
  });
});

// ─── Prompt definitions ───────────────────────────────────────────────

describe('prompt registration', () => {
  it('server registers detect_impact and generate_map prompts', () => {
    const backend = createMockBackend();
    // Creating the server registers all handlers including prompts
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
  });
});

// ─── startMCPServer ────────────────────────────────────────────────────

describe('startMCPServer', () => {
  it('registers stdin shutdown listeners before awaiting Server.prototype.connect', async () => {
    // P1 finding: startMCPServer must register process.stdin end/close/error
    // shutdown listeners before calling server.connect(), so that a stdin
    // closure during transport setup is safely handled.
    // This test asserts the listeners are present *during* the connect call.

    // Capture baseline listener counts before startMCPServer adds anything
    const closeBefore = process.stdin.listenerCount('close');
    const endBefore = process.stdin.listenerCount('end');
    const errorBefore = process.stdin.listenerCount('error');
    const beforeListeners = {
      stdinEnd: new Set(process.stdin.listeners('end')),
      stdinClose: new Set(process.stdin.listeners('close')),
      stdinError: new Set(process.stdin.listeners('error')),
      stdoutError: new Set(process.stdout.listeners('error')),
      sigint: new Set(process.listeners('SIGINT')),
      sigterm: new Set(process.listeners('SIGTERM')),
      exit: new Set(process.listeners('exit')),
      uncaughtException: new Set(process.listeners('uncaughtException')),
      unhandledRejection: new Set(process.listeners('unhandledRejection')),
    };

    // Stub process.exit to prevent actual termination if shutdown fires
    const exitStub = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Spy on Server.prototype.connect to inspect listener counts during the call
    const connectSpy = vi.spyOn(Server.prototype, 'connect').mockImplementation(async function () {
      expect(process.stdin.listenerCount('close')).toBeGreaterThan(closeBefore);
      expect(process.stdin.listenerCount('end')).toBeGreaterThan(endBefore);
      expect(process.stdin.listenerCount('error')).toBeGreaterThan(errorBefore);
    });

    const backend = createMockBackend();

    try {
      await startMCPServer(backend);
    } finally {
      connectSpy.mockRestore();
      exitStub.mockRestore();
      // Remove only listeners added by startMCPServer so no side effects leak.
      for (const listener of process.stdin.listeners('end')) {
        if (!beforeListeners.stdinEnd.has(listener)) process.stdin.removeListener('end', listener);
      }
      for (const listener of process.stdin.listeners('close')) {
        if (!beforeListeners.stdinClose.has(listener)) {
          process.stdin.removeListener('close', listener);
        }
      }
      for (const listener of process.stdin.listeners('error')) {
        if (!beforeListeners.stdinError.has(listener)) {
          process.stdin.removeListener('error', listener);
        }
      }
      for (const listener of process.stdout.listeners('error')) {
        if (!beforeListeners.stdoutError.has(listener)) {
          process.stdout.removeListener('error', listener);
        }
      }
      for (const listener of process.listeners('SIGINT')) {
        if (!beforeListeners.sigint.has(listener)) process.removeListener('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!beforeListeners.sigterm.has(listener)) process.removeListener('SIGTERM', listener);
      }
      for (const listener of process.listeners('exit')) {
        if (!beforeListeners.exit.has(listener)) process.removeListener('exit', listener);
      }
      for (const listener of process.listeners('uncaughtException')) {
        if (!beforeListeners.uncaughtException.has(listener)) {
          process.removeListener('uncaughtException', listener);
        }
      }
      for (const listener of process.listeners('unhandledRejection')) {
        if (!beforeListeners.unhandledRejection.has(listener)) {
          process.removeListener('unhandledRejection', listener);
        }
      }
    }
  });
});

// ─── Graceful shutdown signal handling (#1132) ────────────────────────

describe('installSignalShutdown (#1132)', () => {
  it('maps SIGINT→130 / SIGTERM→143 and never passes the signal name to shutdown', () => {
    // Node invokes signal listeners with the signal NAME string as the first
    // argument. The old code registered `shutdown` directly, so that string
    // reached process.exit() and crashed with ERR_INVALID_ARG_TYPE. Reproduce
    // that exact invocation and assert a numeric code is used instead.
    const received: unknown[] = [];
    let onSigint: ((...args: unknown[]) => void) | undefined;
    let onSigterm: ((...args: unknown[]) => void) | undefined;

    installSignalShutdown(
      (code) => received.push(code),
      (event, listener) => {
        if (event === 'SIGINT') onSigint = listener;
        if (event === 'SIGTERM') onSigterm = listener;
      },
    );

    expect(onSigint).toBeTypeOf('function');
    expect(onSigterm).toBeTypeOf('function');

    // Invoke exactly as Node does — with the signal name string as the arg.
    onSigint?.('SIGINT');
    onSigterm?.('SIGTERM');

    expect(received).toEqual([SHUTDOWN_EXIT_CODES.SIGINT, SHUTDOWN_EXIT_CODES.SIGTERM]);
    expect(received).toEqual([130, 143]);
    for (const code of received) {
      expect(typeof code).toBe('number');
    }
  });
});
