/**
 * Fault class of failed `tools/call` responses against a real LadybugDB.
 *
 * Every call goes through createMCPServer and the SDK client, and every
 * engine failure is injected below the pool adapter (on the native
 * connection, or in the VECTOR extension loader), so the real marking
 * boundary runs. Outside the caller's own cypher statement the class follows
 * where an error was born, never its wording: I3 injects an engine failure
 * whose message reads like a parser error and still expects `server`. Under
 * cypher an engine error is classified by its engine exception category, the
 * type the engine names at the start of its message.
 *
 * I9 pins the response text with literals recorded before the fault key
 * existed; like every call here, it runs against the current server only.
 */
import lbug from '@ladybugdb/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { closeLbug, executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { engineFaultOf, queryStageOf } from '../../src/core/fault-class.js';
import { loadVectorExtension } from '../../src/core/lbug/lbug-adapter.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  LOCAL_BACKEND_SEED_DATA,
  LOCAL_BACKEND_FTS_INDEXES,
} from '../fixtures/local-backend-seed.js';

const KEY = 'io.github.abhigyanpatwari.gitnexus/fault';

vi.mock('../../src/storage/repo-manager.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

// Pass-through: I5 lets a real init complete and then tears the pool down,
// the way a concurrent close or idle eviction would.
vi.mock('../../src/core/lbug/pool-adapter.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, initLbug: vi.fn(actual.initLbug) };
});

// Pass-through: one test makes the VECTOR extension fail to load for a vector query.
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>();
  return { ...actual, loadVectorExtension: vi.fn(actual.loadVectorExtension) };
});

interface ToolResponse {
  text: string;
  isError?: boolean;
  contentCount: number;
  meta: Record<string, unknown> | undefined;
}

async function callThroughServer(
  backend: LocalBackend,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const server = createMCPServer(backend);
  const client = new Client({ name: 'fault-class-integration', version: '0.0.0' });
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

/**
 * Let native executes run, then move the clock past every query deadline, so the
 * pool adapter's own deadline check fails the query as a timeout.
 */
function timeOutNativeExecute() {
  const execute = lbug.Connection.prototype.execute;
  return vi.spyOn(lbug.Connection.prototype, 'execute').mockImplementation(async function (
    this: lbug.Connection,
    ...args
  ) {
    const result = await execute.apply(this, args as Parameters<typeof execute>);
    vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    return result;
  });
}

/** Fail every native execute with a fresh error until restored. */
function failNativeExecute(message: string) {
  return vi
    .spyOn(lbug.Connection.prototype, 'execute')
    .mockImplementation(() => Promise.reject(new Error(message)));
}

withTestLbugDB(
  'mcp-tool-fault-class',
  (handle) => {
    describe('tools/call fault class with a real LadybugDB', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
        backend = ext._backend;
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      /** Warm the pool so the injected failure lands in the tool's own queries. */
      const warm = () => backend.callTool('cypher', { statement: 'RETURN 1 AS one' });

      it('I1: a cypher syntax error is a client fault', async () => {
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n RETURN n',
        });
        expect(response).not.toHaveProperty('isError');
        expect(JSON.parse(response.text.split('\n\n---')[0]).error).toMatch(/Parser exception/);
        expect(response.meta?.[KEY]).toBe('client');
      });

      // The fixture shares a writable database with the pool, so the engine's
      // read-only rejection is injected at the native connection instead.
      it('I2: a cypher write is rejected as a client fault', async () => {
        await warm();
        failNativeExecute('Cannot execute write operations in a read-only database!');
        const response = await callThroughServer(backend, 'cypher', {
          statement: "MATCH (n:File) WHERE n.id = '__missing__' SET n.name = 'x' RETURN n.id",
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toMatch(/read-only/i);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it('I3: an engine failure under impact is a server fault whatever its wording', async () => {
        await warm();
        failNativeExecute('Parser exception: synthetic');
        const response = await callThroughServer(backend, 'impact', {
          target: 'validate',
          direction: 'upstream',
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toContain('Parser exception: synthetic');
        expect(response.meta?.[KEY]).toBe('server');
      });

      it('I3: an engine failure under context is a server fault whatever its wording', async () => {
        await warm();
        failNativeExecute('Parser exception: synthetic');
        const response = await callThroughServer(backend, 'context', { name: 'login' });
        expect(response.text).toContain('Parser exception: synthetic');
        expect(response.meta?.[KEY]).toBe('server');
      });

      it("I4: the same Parser engine failure while running the caller's cypher is a client fault", async () => {
        await warm();
        failNativeExecute('Parser exception: synthetic');
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n:Function) RETURN n.name AS name',
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toContain('Parser exception: synthetic');
        expect(response.meta?.[KEY]).toBe('client');
      });

      it("a Binder error from the caller's cypher is a client fault", async () => {
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n:NoSuchTable) RETURN n',
        });
        expect(response).not.toHaveProperty('isError');
        expect(JSON.parse(response.text.split('\n\n---')[0]).error).toMatch(/Binder exception/);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it.each([
        'IO exception: synthetic read failure',
        'Buffer manager exception: synthetic',
        'Storage exception: synthetic',
        'Connection exception: synthetic',
        'Copy exception: synthetic',
        'synthetic engine failure without a category',
      ])(
        "the engine failure %j while running the caller's cypher is a server fault",
        async (message) => {
          await warm();
          failNativeExecute(message);
          const response = await callThroughServer(backend, 'cypher', {
            statement: 'MATCH (n:Function) RETURN n.name AS name',
          });
          expect(response).not.toHaveProperty('isError');
          expect(JSON.parse(response.text.split('\n\n---')[0]).error).toBe(message);
          expect(response.meta?.[KEY]).toBe('server');
        },
      );

      // Guards the format the classification reads: if the engine stops naming
      // its exception category at the start of the message, these real errors
      // stop being recognized and fail here, instead of every caller's cypher
      // error quietly becoming a server fault.
      it.each([
        ['Parser', 'prepare', 'MATCH (n RETURN n'],
        ['Binder', 'prepare', 'MATCH (n:NoSuchTable) RETURN n'],
        ['Catalog', 'prepare', 'RETURN nosuchfn(1)'],
        ['Conversion', 'prepare', "RETURN CAST('abc' AS INT64)"],
        // Data-dependent, so only running the statement can raise it.
        ['Runtime', 'execute', 'MATCH (n:Function) RETURN 1 / (n.startLine - n.startLine)'],
      ])(
        'the engine names the %s category of a real %s error',
        async (category, stage, statement) => {
          const error = await executeParameterized(handle.repoId, statement, {}).then(
            () => undefined,
            (err: unknown) => err as Error,
          );
          const prefix = stage === 'prepare' ? 'Prepare failed: ' : '';
          expect(error?.message).toMatch(new RegExp(`^${prefix}${category} exception: `));
          expect(queryStageOf(error)).toBe(stage);
          expect(engineFaultOf(error)).toBe('client');
        },
      );

      // The engine reports a parameter the call did not pass only when the
      // statement runs, with a message that names no exception category.
      it.each([
        ['a misspelled parameter', '$nmae', { name: 'login' }, 'Parameter nmae not found.'],
        ['forgotten params', '$name', undefined, 'Parameter name not found.'],
        // The engine keys a quoted parameter by its spelling with the backticks.
        [
          'a quoted parameter passed without its backticks',
          '$`my param`',
          { 'my param': 'login' },
          'Parameter `my param` not found.',
        ],
      ])("%s in the caller's cypher is a client fault", async (_label, ref, params, message) => {
        const response = await callThroughServer(backend, 'cypher', {
          statement: `MATCH (n:Function) WHERE n.name = ${ref} RETURN n.name AS name`,
          ...(params ? { params } : {}),
        });
        expect(response).not.toHaveProperty('isError');
        expect(JSON.parse(response.text.split('\n\n---')[0]).error).toBe(message);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it('a quoted parameter passed with its backticks runs', async () => {
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n:Function) WHERE n.name = $`my param` RETURN n.name AS name',
          params: { '`my param`': 'login' },
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.meta).toBeUndefined();
        expect(response.text).toContain('login');
      });

      it.each([
        ['every parameter supplied', 'WHERE n.name = $name', { name: 'login' }],
        ['a dollar sign only inside a string literal', "WHERE n.name <> '$name'", undefined],
      ])(
        'an uncategorized engine failure with %s is a server fault',
        async (_label, where, params) => {
          await warm();
          failNativeExecute('synthetic engine failure without a category');
          const response = await callThroughServer(backend, 'cypher', {
            statement: `MATCH (n:Function) ${where} RETURN n.name AS name`,
            ...(params ? { params } : {}),
          });
          expect(JSON.parse(response.text.split('\n\n---')[0]).error).toBe(
            'synthetic engine failure without a category',
          );
          expect(response.meta?.[KEY]).toBe('server');
        },
      );

      it('I6: an unknown repository is a client fault', async () => {
        const response = await callThroughServer(backend, 'context', {
          name: 'login',
          repo: 'no-such-repo',
        });
        expect(response.isError).toBe(true);
        expect(response.text).toMatch(/^Error: Repository "no-such-repo" not found\./);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it('I7: an empty search query is a client fault', async () => {
        const response = await callThroughServer(backend, 'query', { search_query: '' });
        expect(response).not.toHaveProperty('isError');
        expect(JSON.parse(response.text).error).toMatch(/required/);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it('I8: impact on an unknown symbol is a client fault', async () => {
        const response = await callThroughServer(backend, 'impact', {
          target: 'noSuchSymbolAnywhere',
          direction: 'upstream',
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toMatch(/not found/i);
        expect(response.meta?.[KEY]).toBe('client');
      });

      it("a timeout while running the caller's cypher is a client fault", async () => {
        await warm();
        timeOutNativeExecute();
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n:Function) RETURN n.name AS name',
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toContain('Query timed out after 30000ms');
        expect(response.meta?.[KEY]).toBe('client');
      });

      it.each([
        ['impact', { target: 'validate', direction: 'upstream' }],
        ['context', { name: 'login' }],
      ] as const)('the same timeout under %s is a server fault', async (tool, args) => {
        await warm();
        timeOutNativeExecute();
        const response = await callThroughServer(backend, tool, args);
        expect(response.text).toContain('Query timed out after 30000ms');
        expect(response.meta?.[KEY]).toBe('server');
      });

      it('a corrupted WAL under cypher is a server fault', async () => {
        await warm();
        failNativeExecute('Runtime exception: corrupted WAL record');
        const response = await callThroughServer(backend, 'cypher', {
          statement: 'MATCH (n:Function) RETURN n.name AS name',
        });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toContain('WAL corruption detected');
        expect(response.meta?.[KEY]).toBe('server');
      });

      it('a vector query without a loadable VECTOR extension is a server fault', async () => {
        await warm();
        vi.mocked(loadVectorExtension).mockRejectedValueOnce(new Error('dlopen failed: synthetic'));
        const response = await callThroughServer(backend, 'cypher', {
          statement:
            "CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', [0.1, 0.2], 3) RETURN *",
        });
        expect(response).not.toHaveProperty('isError');
        expect(JSON.parse(response.text.split('\n\n---')[0]).error).toEqual(expect.any(String));
        expect(response.meta?.[KEY]).toBe('server');
      });

      // Expected texts are literals: the bytes the handler produced before the
      // fault key existed, recorded once. These calls run against the current
      // server only, so they pin the text rather than compare two servers.
      describe('I9: response text is unchanged', () => {
        it.each([
          [
            'cypher syntax error (I1)',
            'cypher',
            { statement: 'MATCH (n RETURN n' },
            '{"error":"Prepare failed: Parser exception: Invalid input <MATCH (n RETURN>: expected rule oC_SingleQuery (line: 1, offset: 9)\\n\\"MATCH (n RETURN n\\"\\n          ^^^^^^"}\n\n---\n**Next:** To explore a result symbol, use context({name: "<name>"}). For schema reference, READ gitnexus://repo/{name}/schema.',
          ],
          [
            'empty search query (I7)',
            'query',
            { search_query: '' },
            '{"error":"search_query (or legacy query) parameter is required and cannot be empty.","next":"Use context({uid: \\"<id>\\"}) for a symbol\'s references and processes."}',
          ],
        ] as const)('%s', async (_label, tool, args, expected) => {
          const response = await callThroughServer(backend, tool, args);
          expect(response).not.toHaveProperty('isError');
          expect(response.contentCount).toBe(1);
          expect(response.text).toBe(expected);
        });

        it('engine failure under impact (I3)', async () => {
          await warm();
          failNativeExecute('Parser exception: synthetic');
          const response = await callThroughServer(backend, 'impact', {
            target: 'validate',
            direction: 'upstream',
          });
          expect(response).not.toHaveProperty('isError');
          expect(response.contentCount).toBe(1);
          expect(response.text).toBe(
            '{"error":"Parser exception: synthetic","target":{"name":"validate"},"direction":"upstream","impactedCount":null,"risk":"UNKNOWN","suggestion":"The graph query failed — try gitnexus context <symbol> as a fallback"}\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ gitnexus://repo/{name}/processes.',
          );
        });
      });

      // Last: it leaves the pool closed for the remaining calls of this file.
      it('I5: cypher on a pool torn down after init is a server fault', async () => {
        const actualInit = vi.mocked(initLbug).getMockImplementation()!;
        vi.mocked(initLbug).mockImplementationOnce(async (repoId, ...rest) => {
          const reopened = await actualInit(repoId, ...rest);
          await closeLbug(repoId);
          return reopened;
        });
        await closeLbug();
        const response = await callThroughServer(backend, 'cypher', { statement: 'RETURN 1' });
        expect(response).not.toHaveProperty('isError');
        expect(response.text).toContain('LadybugDB not ready');
        expect(response.meta?.[KEY]).toBe('server');
      });
    });
  },
  {
    seed: LOCAL_BACKEND_SEED_DATA,
    ftsIndexes: LOCAL_BACKEND_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'fault-class-repo',
          path: '/fault-class/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
