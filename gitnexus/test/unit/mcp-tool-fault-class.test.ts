/**
 * Fault class of failed `tools/call` responses, through the real handler and
 * SDK client: `_meta["io.github.abhigyanpatwari.gitnexus/fault"]` is `client`
 * or `server` on every error (thrown or returned as `{ error }`), absent on
 * success, and the response text is the same as before the key existed.
 *
 * The fault-class module is imported dynamically where a test needs it, so
 * the text-compatibility tests also run against a server without the module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';

const KEY = 'io.github.abhigyanpatwari.gitnexus/fault';
const UNKNOWN_ARGUMENT_TEXT =
  'Error: Unknown argument "bogus" for tool "cypher". The advertised inputSchema does not include this key.';

function mockBackend(callTool: (...args: any[]) => unknown): any {
  return {
    callTool: vi.fn(callTool),
    listRepos: vi.fn().mockResolvedValue([]),
    countRepos: vi.fn().mockResolvedValue(0),
    cachedRepoCount: vi.fn().mockReturnValue(0),
    getContext: vi.fn().mockReturnValue(null),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

async function callTool(
  backend: any,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  text: string;
  isError?: boolean;
  contentCount: number;
  meta: Record<string, unknown> | undefined;
}> {
  const server = createMCPServer(backend);
  const client = new Client({ name: 'fault-class-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Expected an MCP text response');
    // Keep isError only when the server sent it: absent and false are different bytes.
    return {
      text,
      ...('isError' in response ? { isError: response.isError } : {}),
      contentCount: response.content.length,
      meta: response._meta,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('tools/call fault class', () => {
  it('U1: an unknown argument is a client fault with unchanged text', async () => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, 'cypher', { statement: 'RETURN 1', bogus: 1 });
    expect(response.isError).toBe(true);
    expect(response.text).toBe(UNKNOWN_ARGUMENT_TEXT);
    expect(response.meta?.[KEY]).toBe('client');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('U1 (compat): unknown-argument text', async () => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, 'cypher', { statement: 'RETURN 1', bogus: 1 });
    expect(response.contentCount).toBe(1);
    expect(response.isError).toBe(true);
    expect(response.text).toBe(UNKNOWN_ARGUMENT_TEXT);
  });

  it('U2: a read-only policy denial is a client fault', async () => {
    vi.stubEnv('GITNEXUS_MCP_READ_ONLY', '1');
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, 'rename', {
      symbol_name: 'a',
      new_name: 'b',
      dry_run: false,
    });
    expect(response.isError).toBe(true);
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('U3: a thrown server-marked error is a server fault', async () => {
    const { markFault } = await import('../../src/core/fault-class.js');
    const backend = mockBackend(async () => {
      throw markFault(new Error('x'), 'server');
    });
    const response = await callTool(backend, 'context', { name: 'auth' });
    expect(response).toMatchObject({ isError: true, text: 'Error: x' });
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('U4: an unclassified thrown error is a server fault', async () => {
    const backend = mockBackend(async () => {
      throw new Error('boom');
    });
    const response = await callTool(backend, 'context', { name: 'auth' });
    expect(response).toMatchObject({ isError: true, text: 'Error: boom' });
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('U5: a returned { error } is a client fault and keeps isError unset', async () => {
    const result = { error: 'Symbol not found' };
    const response = await callTool(
      mockBackend(async () => result),
      'context',
      { name: 'auth' },
    );
    expect(response).not.toHaveProperty('isError');
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('U5 (compat): returned { error } text is the result JSON plus the hint', async () => {
    const result = { error: 'Symbol not found' };
    const args = { name: 'auth' };
    const response = await callTool(
      mockBackend(async () => result),
      'context',
      args,
    );
    expect(response).not.toHaveProperty('isError');
    expect(response.contentCount).toBe(1);
    expect(response.text).toBe(
      '{"error":"Symbol not found"}\n\n---\n**Next:** If planning changes, use impact({target: "auth", direction: "upstream"}) to check blast radius. To see execution flows, READ gitnexus://repo/{name}/processes.',
    );
  });

  it('U6: a returned { error } after a reported server fault is a server fault', async () => {
    const { reportFault } = await import('../../src/core/fault-class.js');
    const backend = mockBackend(async () => {
      await Promise.resolve();
      reportFault('server');
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    });
    const response = await callTool(backend, 'cypher', { statement: 'RETURN 1' });
    expect(response).not.toHaveProperty('isError');
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('U7: a successful call carries no fault key', async () => {
    const response = await callTool(
      mockBackend(async () => ({ result: 'ok' })),
      'context',
      { name: 'auth' },
    );
    expect(response).not.toHaveProperty('isError');
    expect(response.meta?.[KEY]).toBeUndefined();
    expect(response.meta).toBeUndefined();
  });

  it('U8: an impact budget too small for the result is a client fault', async () => {
    const response = await callTool(
      mockBackend(async () => ({
        impactedCount: 1,
        risk: 'HIGH',
        byDepthCounts: { 1: 1 },
        byDepth: { 1: [{ id: 'caller' }] },
        affected_processes: [{ name: 'x'.repeat(4000) }],
      })),
      'impact',
      { target: 'auth', direction: 'upstream', maxTokens: 20 },
    );
    expect(response.isError).toBe(true);
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('an operator default budget too small for the result is a server fault', async () => {
    vi.stubEnv('GITNEXUS_MCP_DEFAULT_MAX_TOKENS', '20');
    const response = await callTool(
      mockBackend(async () => ({
        impactedCount: 1,
        risk: 'HIGH',
        byDepthCounts: { 1: 1 },
        byDepth: { 1: [{ id: 'caller' }] },
        affected_processes: [{ name: 'x'.repeat(4000) }],
      })),
      'impact',
      { target: 'auth', direction: 'upstream' },
    );
    expect(response).toMatchObject({ isError: true, text: '{"error":"Increase maxTokens"}' });
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('U8 (compat): impact budget error text', async () => {
    const response = await callTool(
      mockBackend(async () => ({
        impactedCount: 1,
        risk: 'HIGH',
        byDepthCounts: { 1: 1 },
        byDepth: { 1: [{ id: 'caller' }] },
        affected_processes: [{ name: 'x'.repeat(4000) }],
      })),
      'impact',
      { target: 'auth', direction: 'upstream', maxTokens: 20 },
    );
    expect(response.isError).toBe(true);
    expect(response.contentCount).toBe(1);
    expect(response.text).toBe('{"error":"Increase maxTokens"}');
  });

  it('U9: an unclassified error with a string code is a server fault', async () => {
    const backend = mockBackend(async () => {
      throw Object.assign(new Error('reader refused'), { code: 'E_X' });
    });
    const response = await callTool(backend, 'context', { name: 'auth' });
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('U9 (compat): error code text', async () => {
    const backend = mockBackend(async () => {
      throw Object.assign(new Error('reader refused'), { code: 'E_X' });
    });
    const response = await callTool(backend, 'context', { name: 'auth' });
    expect(response).toMatchObject({
      isError: true,
      contentCount: 1,
      text: 'Error [E_X]: reader refused',
    });
  });

  it('U10: an invalid operator default for maxTokens is a server fault', async () => {
    vi.stubEnv('GITNEXUS_MCP_DEFAULT_MAX_TOKENS', 'many');
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, 'context', { name: 'auth' });
    expect(response).toMatchObject({
      isError: true,
      text: 'Error: GITNEXUS_MCP_DEFAULT_MAX_TOKENS must be a positive integer.',
    });
    expect(response.meta?.[KEY]).toBe('server');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('isolates the fault scope between concurrent calls on one server', async () => {
    const { reportFault } = await import('../../src/core/fault-class.js');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Open the gate only once both calls are inside the backend, so each one
    // reports while the other's scope is also open.
    let entered = 0;
    let bothEntered!: () => void;
    const arrived = new Promise<void>((resolve) => (bothEntered = resolve));
    const backend = mockBackend(async (_name: string, args: { name: string }) => {
      if (++entered === 2) bothEntered();
      await gate;
      if (args.name === 'broken') reportFault('server');
      return { error: `${args.name} failed` };
    });
    const server = createMCPServer(backend);
    const client = new Client({ name: 'fault-class-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const calls = ['broken', 'missing'].map((name) =>
        client.callTool({ name: 'context', arguments: { name } }),
      );
      await arrived;
      release();
      const [broken, missing] = await Promise.all(calls);
      expect(broken._meta?.[KEY]).toBe('server');
      expect(missing._meta?.[KEY]).toBe('client');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
