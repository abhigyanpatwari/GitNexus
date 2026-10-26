/**
 * Lossless MCP serialization benchmark: real server/SDK, fixed backend responses.
 * Run: node --import tsx scripts/bench/mcp-serialization.ts [--include-text]
 * Byte counts are exact; they are not billing tokens or whole-session costs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer, getNextStepHint } from '../../src/mcp/server.js';

const references = Array.from({ length: 30 }, (_, i) => ({
  id: `Function:src/orders.ts:submitOrder${i}`,
  name: `submitOrder${i}`,
  filePath: 'src/orders.ts',
  startLine: i * 10,
  endLine: i * 10 + 8,
}));
const diagnostics = {
  epistemic: 'lower-bound',
  boundaries: ['Dynamic dispatch may omit callers.'],
  causes: { receiverTyping: 2, dispatchBoundary: 1 },
  staleness: { status: 'behind', commitsBehind: 1, hint: 'Run gitnexus analyze.' },
};
const cases: Array<{ name: string; tool: string; args: Record<string, unknown>; result: unknown }> =
  [
    {
      name: 'query',
      tool: 'query',
      args: { search_query: 'submit order', repo: 'fixture' },
      result: {
        processes: [{ id: 'proc:submit', summary: 'Submit order', step_count: 3 }],
        process_symbols: references,
        definitions: [],
        ...diagnostics,
      },
    },
    {
      name: 'context with source',
      tool: 'context',
      args: { name: 'submitOrder0', include_content: true, repo: 'fixture' },
      result: {
        symbol: references[0],
        content: 'export function submitOrder0() {\n  return "雪 😀 \\"quoted\\"";\n}\n',
        incoming: { calls: references },
        outgoing: { calls: references.slice(0, 3), imports: [] },
        processes: [],
        ...diagnostics,
      },
    },
    {
      name: 'impact with incomplete evidence',
      tool: 'impact',
      args: { target: 'submitOrder0', direction: 'upstream', repo: 'fixture' },
      result: {
        target: references[0],
        risk: 'UNKNOWN',
        riskNote: 'Unresolved dispatch prevents an exact count.',
        impactedCount: 30,
        byDepth: { '1': references },
        partial: true,
        truncated: true,
        ...diagnostics,
      },
    },
    {
      name: 'empty query',
      tool: 'query',
      args: { search_query: 'missing', repo: 'fixture' },
      result: { processes: [], process_symbols: [], definitions: [] },
    },
    {
      name: 'structured error',
      tool: 'context',
      args: { name: 'missing', repo: 'fixture' },
      result: { error: 'Symbol not found', candidates: [], ...diagnostics },
    },
    {
      name: 'plain text',
      tool: 'cypher',
      args: { statement: 'RETURN 1', repo: 'fixture' },
      result: 'name | count\n雪 😀 | 1\n',
    },
  ];

// Isolate the measurement from the invoking shell's optional policy and budgets.
for (const name of [
  'GITNEXUS_MCP_DEFAULT_MAX_TOKENS',
  'GITNEXUS_MCP_READ_ONLY',
  'GITNEXUS_MCP_ALLOWED_REPOS',
  'GITNEXUS_MCP_DEFAULT_REPO',
])
  delete process.env[name];

const measurements = [];
for (const entry of cases) {
  const backend = {
    callTool: async () => entry.result,
  } as unknown as LocalBackend;
  const server = createMCPServer(backend);
  const client = new Client({ name: 'serialization-bench', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = CallToolResultSchema.parse(
      await client.callTool({ name: entry.tool, arguments: entry.args }),
    );
    assert.notEqual(response.isError, true);
    const text = response.content.find((item) => item.type === 'text')?.text;
    assert.equal(typeof text, 'string');
    const currentText = text as string;
    const hint = getNextStepHint(entry.tool, entry.args, false, entry.result);
    if (entry.tool === 'query') {
      const { next, ...body } = JSON.parse(currentText);
      assert.equal(next, hint);
      assert.deepEqual(body, entry.result);
    } else {
      assert.ok(currentText.endsWith(hint));
      const body = hint ? currentText.slice(0, -hint.length) : currentText;
      if (typeof entry.result === 'string') assert.equal(body, entry.result);
      else assert.deepEqual(JSON.parse(body), entry.result);
    }
    const prettyText =
      (typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)) +
      hint;
    const baselineBytes = Buffer.byteLength(prettyText);
    const currentBytes = Buffer.byteLength(currentText);
    // Moving the query hint into JSON adds a field even for an empty result.
    assert.ok(currentBytes <= baselineBytes + (entry.tool === 'query' ? 64 : 0));
    measurements.push({
      name: entry.name,
      baselineBytes,
      currentBytes,
      ...(process.argv.includes('--include-text') ? { prettyText, currentText } : {}),
    });
  } finally {
    await client.close();
    await server.close();
  }
}
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
console.log(
  JSON.stringify(
    {
      workload: 'Fixed synthetic responses through the real MCP server; includes unchanged hints',
      fidelity: true,
      corpusSha256: sha256(JSON.stringify(cases)),
      serverSha256: sha256(readFileSync(new URL('../../src/mcp/server.ts', import.meta.url))),
      measurements,
    },
    null,
    2,
  ),
);
