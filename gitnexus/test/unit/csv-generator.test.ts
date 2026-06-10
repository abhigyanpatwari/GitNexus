/**
 * Unit Tests: csv-generator — relationship row + source column (WI-1, #159 P3 Mode A)
 *
 * Verifies the serializer-side default for the new 7th `source` column
 * on CodeRelation. The header MUST be 7-wide and every row MUST emit
 * a non-NULL value (default 'heuristic'). When the in-memory
 * `GraphRelationship.source` is set explicitly, the row MUST carry
 * that value verbatim. Kùzu binds COPY by header name, so a row
 * missing the 7th column would shift every column's binding and
 * silently corrupt the table — these tests guard that contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';

let tmpHandle: TestDBHandle;
let csvDir: string;
let repoDir: string;

beforeAll(async () => {
  tmpHandle = await createTempDir('csv-generator-wi1-');
  csvDir = path.join(tmpHandle.dbPath, 'csv');
  repoDir = path.join(tmpHandle.dbPath, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'a.ts'), 'export function alpha() { return 1; }');
  await fs.writeFile(path.join(repoDir, 'src', 'b.ts'), 'export function beta() { return 2; }');
});

afterAll(async () => {
  try { await tmpHandle.cleanup(); } catch { /* best-effort */ }
});

describe('streamAllCSVsToDisk — relations.csv source column (WI-1)', () => {
  it('emits a 7-column header: from,to,type,confidence,reason,step,source', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        { sourceId: 'func:alpha', targetId: 'func:beta', type: 'CALLS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines[0]).toBe('from,to,type,confidence,reason,step,source');
  });

  it('defaults the 7th field to "heuristic" when GraphRelationship.source is omitted', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [
        // No `source` field on the test rel — buildTestGraph passes through
        // whatever is on the input, so the underlying GraphRelationship
        // has no `source` property. The serializer must default to 'heuristic'.
        { sourceId: 'func:alpha', targetId: 'func:beta', type: 'CALLS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);
    // Row layout: "from","to","type",confidence,"reason",step,"source"
    const dataCols = lines[1].split(',');
    expect(dataCols).toHaveLength(7);
    expect(dataCols[6]).toBe('"heuristic"');
  });

  it('carries the explicit source value when GraphRelationship.source is set', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/a.ts', label: 'File', name: 'a.ts', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', label: 'File', name: 'b.ts', filePath: 'src/b.ts' },
        { id: 'func:alpha', label: 'Function', name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:beta', label: 'Function', name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );

    // Add the rel manually so we can set `source` on it (buildTestGraph's
    // helper does not pass through the new optional field).
    graph.addRelationship({
      id: 'func:alpha-CALLS-func:beta',
      sourceId: 'func:alpha',
      targetId: 'func:beta',
      type: 'CALLS',
      confidence: 0.7,
      reason: '',
      source: 'lsp-corrected',
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    const dataCols = lines[1].split(',');
    expect(dataCols).toHaveLength(7);
    expect(dataCols[6]).toBe('"lsp-corrected"');
  });

  it('every rel row has exactly 7 fields (no truncation, no extra)', async () => {
    // Build a graph with 3 rels of varying source settings.
    const graph = buildTestGraph(
      [
        { id: 'file:a', label: 'File', name: 'a', filePath: 'a' },
        { id: 'file:b', label: 'File', name: 'b', filePath: 'b' },
        { id: 'file:c', label: 'File', name: 'c', filePath: 'c' },
        { id: 'func:x', label: 'Function', name: 'x', filePath: 'a', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:y', label: 'Function', name: 'y', filePath: 'b', startLine: 1, endLine: 1, isExported: true },
        { id: 'func:z', label: 'Function', name: 'z', filePath: 'c', startLine: 1, endLine: 1, isExported: true },
      ],
      [],
    );
    graph.addRelationship({ id: 'r1', sourceId: 'func:x', targetId: 'func:y', type: 'CALLS', confidence: 0.5, reason: '', step: 0 });
    graph.addRelationship({ id: 'r2', sourceId: 'func:y', targetId: 'func:z', type: 'CALLS', confidence: 0.7, reason: 'x', step: 1, source: 'lsp-confirmed' });
    graph.addRelationship({ id: 'r3', sourceId: 'func:z', targetId: 'func:x', type: 'CALLS', confidence: 0.7, reason: 'y', step: 2, source: 'lsp-recall' });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const content = await fs.readFile(result.relCsvPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(4); // header + 3 rows
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      expect(cols).toHaveLength(7);
    }
    // Sanity: the explicit-source rows carry the value, the default-source
    // row carries "heuristic".
    expect(lines[1].split(',')[6]).toBe('"heuristic"');
    expect(lines[2].split(',')[6]).toBe('"lsp-confirmed"');
    expect(lines[3].split(',')[6]).toBe('"lsp-recall"');
  });
});
