import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';

// R ships a control-flow-only CfgVisitor. This runs the real worker pipeline under
// `--pdg` on R source and pins (a) what is emitted, and (b) how a CFG joins its
// Function node. The CFG anchors at the `function_definition` token; the Function
// node anchors at the whole assignment, so the two share a start line except for
// the split form `f <-\n  function(x)`.

const repos = createTempDirPool('gn-pdg-r-');

// Force worker-pool parsing even for a single small file: the CFG is built in the worker.
const WORKER_PDG = {
  pdg: true,
  workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
  workerPoolSize: 2,
} as const;

const SRC = [
  'a <- function(x) {', //                 1
  '  if (x) 1 else 2', //                  2
  '}', //                                  3
  'b <-', //                               4  Function node starts here
  '  function(x) {', //                    5  CFG anchors here
  '    if (x) 1 else 2', //                6
  '  }', //                                7
  'c = function(x) {', //                  8
  '  if (x) 1 else 2', //                  9
  '}', //                                  10
  'd <- \\(x) {', //                       11
  '  if (x) 1 else 2', //                  12
  '}', //                                  13
  'lapply(1:3, function(z) {', //          14  anonymous: CFG but no Function node
  '  if (z) 1 else 2', //                  15
  '})', //                                 16
  '',
].join('\n');

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R CFG under --pdg (worker pipeline)', () => {
  it('emits BasicBlock/CFG/CDG, no REACHING_DEF, and joins to Function nodes', async () => {
    const dir = repos.dir();
    fs.writeFileSync(path.join(dir, 'a.R'), SRC);
    const result = await runPipelineFromRepo(dir, () => {}, WORKER_PDG);

    const fnStart = new Map<string, { start: number; end: number }>();
    const cfgAnchors = new Set<string>(); // "line:col" of each CFG
    const blockLines = new Map<string, number[]>();
    result.graph.forEachNode((n) => {
      if (n.label === 'Function')
        fnStart.set(String(n.properties.name), {
          start: Number(n.properties.startLine),
          end: Number(n.properties.endLine),
        });
      if (n.label === 'BasicBlock') {
        const anchor = n.id.split(':').slice(2, 4).join(':');
        cfgAnchors.add(anchor);
        blockLines.set(anchor, [...(blockLines.get(anchor) ?? []), Number(n.properties.startLine)]);
      }
    });
    const rels = { CFG: 0, CDG: 0, REACHING_DEF: 0 };
    for (const rel of result.graph.iterRelationships())
      if (rel.type in rels) rels[rel.type as keyof typeof rels]++;

    expect(rels.CFG).toBeGreaterThan(0);
    expect(rels.CDG).toBeGreaterThan(0);
    expect(rels.REACHING_DEF).toBe(0); // no def/use harvest: reaching-defs is 'no-facts'

    // One CFG per function_definition: a, b, c, d and the anonymous lapply argument.
    expect([...cfgAnchors].sort()).toEqual(['11:5', '14:12', '1:5', '5:2', '8:4']);
    expect([...fnStart.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);

    // Function.startLine is 0-based; an exact join needs a CFG at startLine + 1.
    const span = (name: string): { start: number; end: number } => {
      const fn = fnStart.get(name);
      if (!fn) throw new Error(`no Function node ${name}`);
      return fn;
    };
    const joinsExactly = (name: string): boolean =>
      [...cfgAnchors].some((a) => a.startsWith(`${span(name).start + 1}:`));
    expect(['a', 'c', 'd'].map(joinsExactly)).toEqual([true, true, true]);
    expect(joinsExactly('b')).toBe(false); // split form: documented gap

    // The span-containment join (used by the MCP pdg tools) still holds for `b`:
    // its CFG blocks sit inside the Function node's [start + 1, end + 1] window.
    const { start, end } = span('b');
    for (const line of blockLines.get('5:2') ?? []) {
      expect(line).toBeGreaterThanOrEqual(start + 1);
      expect(line).toBeLessThanOrEqual(end + 1);
    }
  }, 60000);
});
