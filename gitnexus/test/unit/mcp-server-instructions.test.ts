/**
 * initialize must carry the tool-usage policy on every transport createMCPServer serves.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { CompatibleStdioServerTransport } from '../../src/mcp/compatible-stdio-transport.js';
import { createStreamableHttpHandler } from '../../src/mcp/http-transport.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { mcpServerInstructions } from '../../src/mcp/tool-usage-policy.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

function createMockBackend(): LocalBackend {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
    countRepos: vi.fn().mockResolvedValue(0),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as LocalBackend;
}

function initializeMessage(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'instructions-test', version: '1.0.0' },
    },
  };
}

function instructionsFromRpc(message: { result?: { instructions?: string } }): string {
  const instructions = message.result?.instructions;
  if (typeof instructions !== 'string') {
    throw new Error(`initialize result has no instructions: ${JSON.stringify(message)}`);
  }
  return instructions;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MCP initialize instructions', () => {
  it('returns the shared policy from an in-memory initialize', async () => {
    const server = createMCPServer(createMockBackend());
    const client = new Client({ name: 'instructions-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getInstructions()).toBe(mcpServerInstructions());
      expect(client.getInstructions()).toContain(
        "determine the selected repository's target branch",
      );
      expect(client.getInstructions()).not.toContain('fetch target branch "main"');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns preview-only rename guidance when the server is read-only', async () => {
    vi.stubEnv('GITNEXUS_MCP_READ_ONLY', '1');
    const server = createMCPServer(createMockBackend());
    const client = new Client({ name: 'instructions-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getInstructions()).toContain('Rename is preview-only in read-only mode.');
      expect(client.getInstructions()).not.toContain('dry_run: false');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('includes the policy in the stdio initialize response', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = createMCPServer(createMockBackend());
    const transport = new CompatibleStdioServerTransport(stdin, stdout);
    let raw = '';
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio initialize timed out: ${raw}`)), 2000);
      stdout.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        const line = raw.split('\n').find((entry) => entry.includes('"id":1'));
        if (!line) return;
        clearTimeout(timer);
        resolve(line);
      });
    });

    await server.connect(transport);
    stdin.write(`${JSON.stringify(initializeMessage())}\n`);

    try {
      const message = JSON.parse(await response) as { result?: { instructions?: string } };
      expect(instructionsFromRpc(message)).toBe(mcpServerInstructions());
    } finally {
      stdin.end();
      await server.close();
    }
  });

  it('includes the policy in the streamable HTTP initialize response', async () => {
    const { handler, cleanup } = createStreamableHttpHandler(createMockBackend());
    const app = express();
    app.use(express.json());
    app.all('/mcp', (req, res) => {
      void handler(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.status(500).json({ error: String(err) });
      });
    });
    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify(initializeMessage()));
        req.end();
      });

      expect(result.status).toBe(200);
      const dataLine = result.body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(line.indexOf(':') + 1).trim())
        .find((line) => line.includes('"instructions"'));
      const raw = dataLine ?? result.body;
      const message = JSON.parse(raw) as { result?: { instructions?: string } };
      expect(instructionsFromRpc(message)).toBe(mcpServerInstructions());
    } finally {
      await cleanup();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
