/**
 * U9 (#2084 M4) — end-to-end interprocedural taint over the real pipeline.
 *
 * Runs the full pipeline (workers + scope-resolution + the taintSummaries
 * phase) on a tiny CROSS-FILE repo: `source.ts#handle` reads `req.body` and
 * passes it into `sink.ts#runIt`, which calls `exec`. The fixpoint must
 * compose the source→callee-arg summary with the param→sink summary into one
 * cross-function `TAINT_PATH` edge. The flag-off run proves the opt-in gate:
 * zero TAINT_PATH edges (byte-identical graph).
 *
 * Build the worker dist first (`node scripts/build.js`) — the pipeline spawns
 * the parse worker, and a stale dist is a spurious red.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'interproc-repo');

const tmpDirs: string[] = [];
function freshRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-interproc-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function taintPaths(result: PipelineResult) {
  return [...result.graph.iterRelationships()].filter((r) => r.type === 'TAINT_PATH');
}

describe('U9 — end-to-end interprocedural taint (--pdg)', () => {
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('with --pdg: composes a cross-file source→sink into a TAINT_PATH edge', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const paths = taintPaths(result);
    expect(paths.length).toBeGreaterThan(0);

    // At least one edge from `handle` (source fn) to `runIt` (sink fn).
    const nameOf = (id: string): string => {
      const n = result.graph.getNode(id);
      return typeof n?.properties.name === 'string' ? n.properties.name : '';
    };
    const handleToRunIt = paths.find(
      (p) => nameOf(p.sourceId) === 'handle' && nameOf(p.targetId) === 'runIt',
    );
    expect(handleToRunIt, 'expected a TAINT_PATH from handle → runIt').toBeDefined();

    // The reason decodes to a command-injection finding.
    const decoded = decodeTaintPath(handleToRunIt!.reason);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.kind).toBe('command-injection');

    // Endpoints are real graph nodes (Function/Method).
    expect(result.graph.getNode(handleToRunIt!.sourceId)).toBeDefined();
    expect(result.graph.getNode(handleToRunIt!.targetId)).toBeDefined();
  });

  it('finds the multi-hop flow handle2 → forward → runIt', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const nameOf = (id: string): string => {
      const n = result.graph.getNode(id);
      return typeof n?.properties.name === 'string' ? n.properties.name : '';
    };
    const found = taintPaths(result).some(
      (p) => nameOf(p.sourceId) === 'handle2' && nameOf(p.targetId) === 'runIt',
    );
    expect(found, 'expected a multi-hop TAINT_PATH from handle2 → runIt').toBe(true);
  });

  it('composes a generative sourceToReturn flow getInput → handleGen (#2084 review P1-1)', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const nameOf = (id: string): string => {
      const n = result.graph.getNode(id);
      return typeof n?.properties.name === 'string' ? n.properties.name : '';
    };
    const found = taintPaths(result).some(
      (p) => nameOf(p.sourceId) === 'getInput' && nameOf(p.targetId) === 'handleGen',
    );
    expect(found, 'expected a generative TAINT_PATH from getInput → handleGen').toBe(true);
  });

  it('without --pdg: emits ZERO TAINT_PATH edges (opt-in gate / golden parity)', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {});
    expect(taintPaths(result)).toHaveLength(0);
  });

  it('the taintSummaries phase ARMS the per-run edge cap (#2084 review P1-3)', async () => {
    // The fixture yields ≥2 cross-function findings (handle→runIt, handle2→runIt).
    // A cap of 1 must bound the emitted TAINT_PATH edges — proving the phase
    // passes the limit, not just that the solver supports one.
    const uncapped = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    expect(taintPaths(uncapped).length).toBeGreaterThan(1);

    const capped = await runPipelineFromRepo(freshRepo(), () => {}, {
      pdg: true,
      pdgMaxInterprocEdges: 1,
    });
    expect(taintPaths(capped)).toHaveLength(1);
  });
});
