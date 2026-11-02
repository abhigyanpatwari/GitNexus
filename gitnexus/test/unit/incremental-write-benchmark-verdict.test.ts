import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { isVariableDeclarator, traverseFast } from '@babel/types';
import { expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { reconcileGraphNodeIdentities } from '../../src/core/incremental/write-reconciliation.js';

// Execute the standalone benchmark's actual audit closure, without its timed
// workload, against the production oracle and controlled native scan results.
const source = readFileSync(
  new URL('../../bench/incremental-write-integrity/measure.cjs', import.meta.url),
  'utf8',
);
let auditSource: string | undefined;
traverseFast(parse(source, { sourceType: 'script' }), (node) => {
  if (
    isVariableDeclarator(node) &&
    node.id.type === 'Identifier' &&
    node.id.name === 'audit' &&
    node.init?.start != null &&
    node.init.end != null
  ) {
    auditSource = source.slice(node.init.start, node.init.end);
  }
});
if (!auditSource) throw new Error('Benchmark audit closure not found');

const row = { id: 'Function:a.ts:f', name: 'f', filePath: 'a.ts', startLine: 0, endLine: 1 };
it.each([
  { name: 'healthy scan', rows: [row], verdict: 'certified' },
  { name: 'complete tuple set plus duplicate row', rows: [row, row], verdict: 'rejected' },
  {
    name: 'complete tuple set plus unexpected row',
    rows: [row, { ...row, id: 'Function:a.ts:extra' }],
    verdict: 'rejected',
  },
  { name: 'missing tuple', rows: [], verdict: 'rejected' },
  { name: 'inconsistent range', rows: [{ ...row, startLine: 99 }], verdict: 'rejected' },
])('reports the production rejection verdict for $name', async ({ rows, verdict }) => {
  const graph = createKnowledgeGraph();
  graph.addNode({ id: row.id, label: 'Function', properties: { ...row } });
  const wanted = new Set([
    JSON.stringify([row.id, row.name, row.filePath, row.startLine, row.endLine]),
  ]);
  const nativePhases: { verdict: string }[] = [];
  const audit = vm.runInNewContext(`(${auditSource})`, {
    assert,
    graph,
    wanted,
    nativePhases,
    size: { nodes: 1 },
    reconcileGraphNodeIdentities,
    adapter: { executeQuery: async (query: string) => (query.includes('Function') ? rows : []) },
  }) as (phase: string) => Promise<void>;
  await audit('controlled-scan');
  expect(nativePhases).toEqual([expect.objectContaining({ verdict, rows: rows.length })]);
});
