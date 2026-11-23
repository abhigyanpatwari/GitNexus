/**
 * Fault class of failed `tools/call` responses, through the real handler and
 * SDK client: `_meta["io.github.abhigyanpatwari.gitnexus/fault"]` is `client`
 * or `server` on every `isError` result and every result with a top-level
 * `error`, absent on success, and the response text is the same as before the
 * key existed.
 *
 * The fault-class module is imported dynamically where a test needs it, so
 * this file also loads against an older server.ts that does not import the
 * module; the text-compatibility tests then run unchanged against it.
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

describe('tools/call arguments of the wrong JSON type', () => {
  it.each([
    ['context', { name: 'auth', repo: 5 }, 'repo', 'a number'],
    ['cypher', { statement: 'RETURN 1', repo: { name: 'x' } }, 'repo', 'an object'],
    ['context', { name: 5 }, 'name', 'a number'],
    ['context', { name: ['a'] }, 'name', 'an array'],
    ['rename', { symbol_name: 5, new_name: 'b' }, 'symbol_name', 'a number'],
    // A value the server used to ignore, and one it used to coerce with String().
    ['impact', { target: 'auth', direction: 5 }, 'direction', 'a number'],
    ['route_map', { route: {} }, 'route', 'an object'],
  ] as const)('%s %j is rejected as a client fault', async (tool, args, key, actual) => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, tool, args);
    expect(response.isError).toBe(true);
    expect(response.text).toBe(
      `Error: Argument "${key}" for tool "${tool}" must be a string, not ${actual}. The advertised inputSchema declares type "string".`,
    );
    expect(response.meta?.[KEY]).toBe('client');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it.each([
    [5, 'a number'],
    [{}, 'an object'],
    [true, 'a boolean'],
  ] as const)(
    'a union of string and array given %j is rejected as a client fault',
    async (repo, actual) => {
      const backend = mockBackend(async () => ({ result: 'ok' }));
      const response = await callTool(backend, 'query', { search_query: 'auth', repo });
      expect(response).toMatchObject({
        isError: true,
        text: `Error: Argument "repo" for tool "query" must be a string or an array, not ${actual}. The advertised inputSchema declares type ["string","array"].`,
      });
      expect(response.meta?.[KEY]).toBe('client');
      expect(backend.callTool).not.toHaveBeenCalled();
    },
  );

  it('an array property given a string is rejected as a client fault', async () => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, 'impact', {
      target: 'auth',
      direction: 'upstream',
      relationTypes: 'CALLS',
    });
    expect(response).toMatchObject({
      isError: true,
      text: 'Error: Argument "relationTypes" for tool "impact" must be an array, not a string. The advertised inputSchema declares type "array".',
    });
    expect(response.meta?.[KEY]).toBe('client');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ['context', { name: 'auth', repo: null }],
    ['query', { search_query: 'auth', include_content: 'true' }],
    ['impact', { target: 'auth', direction: 'upstream', summaryOnly: 'true' }],
    ['query', { search_query: 'auth', repo: 'x' }],
    ['query', { search_query: 'auth', repo: ['x'] }],
  ] as const)('%s %j still reaches the backend unchanged', async (tool, args) => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, tool, args);
    expect(response).not.toHaveProperty('isError');
    expect(response.meta).toBeUndefined();
    expect(backend.callTool).toHaveBeenCalledTimes(1);
    expect(backend.callTool.mock.calls[0][1]).toMatchObject(args);
  });
});

describe('JSON type rule branches', () => {
  const schema = {
    noType: { enum: ['a', 'b'] },
    anyOf: { anyOf: [{ type: 'string' }] },
    emptyTypes: { type: [] },
    nullable: { type: ['string', 'null'] },
    union: { type: ['string', 'array'] },
    list: { type: 'array', items: { type: 'string' } },
  };

  it.each([
    ['a property without a type', { noType: 5 }],
    ['an anyOf property', { anyOf: 5 }],
    ['an empty type list', { emptyTypes: 5 }],
    ['a union with a member outside string and array', { nullable: 5 }],
    ['null on a union', { union: null }],
    ['null on an array property', { list: null }],
  ])('leaves %s unchecked', async (_label, args) => {
    const { assertKnownMcpToolArguments } = await import('../../src/mcp/tool-arguments.js');
    expect(() => assertKnownMcpToolArguments('synthetic', args, schema)).not.toThrow();
  });

  it('rejects a value outside a string and array union', async () => {
    const { assertKnownMcpToolArguments } = await import('../../src/mcp/tool-arguments.js');
    expect(() => assertKnownMcpToolArguments('synthetic', { union: 5 }, schema)).toThrow(
      'Argument "union" for tool "synthetic" must be a string or an array, not a number. The advertised inputSchema declares type ["string","array"].',
    );
  });

  it.each([
    ['search', { search_query: 5 }, 'search_query'],
    ['explore', { name: 5 }, 'name'],
  ] as const)('legacy %s checks the schema it shares', async (tool, args, key) => {
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const response = await callTool(backend, tool, args);
    expect(response.isError).toBe(true);
    expect(response.text).toContain(`Argument "${key}" for tool "${tool}" must be a string`);
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('read-only mode still checks argument types', async () => {
    vi.stubEnv('GITNEXUS_MCP_READ_ONLY', '1');
    const backend = mockBackend(async () => ({ result: 'ok' }));
    const rejected = await callTool(backend, 'context', { name: 5 });
    expect(rejected.isError).toBe(true);
    expect(rejected.meta?.[KEY]).toBe('client');
    const passed = await callTool(backend, 'query', { search_query: 'auth', repo: null });
    expect(passed).not.toHaveProperty('isError');
    expect(backend.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('tool-name lookups ignore Object.prototype', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('%s', async (name) => {
    const { assertKnownMcpToolArguments, foldNumericToolArgumentAliases, schemaSourceToolName } =
      await import('../../src/mcp/tool-arguments.js');
    expect(schemaSourceToolName(name)).toBe(name);
    expect(foldNumericToolArgumentAliases(name, { a: 1 })).toEqual({ params: { a: 1 } });
    expect(() =>
      assertKnownMcpToolArguments(name, { x: 'y' }, { x: { type: 'string' } }),
    ).not.toThrow();
  });

  it('legacy aliases still resolve', async () => {
    const { schemaSourceToolName } = await import('../../src/mcp/tool-arguments.js');
    expect(schemaSourceToolName('search')).toBe('query');
    expect(schemaSourceToolName('explore')).toBe('context');
  });
});
