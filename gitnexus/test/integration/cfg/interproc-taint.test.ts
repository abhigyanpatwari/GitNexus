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

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'interproc-repo');

const repos = createTempDirPool('gn-interproc-');
const freshRepo = (): string => repos.fromFixture(FIXTURE);

function taintPaths(result: PipelineResult) {
  return [...result.graph.iterRelationships()].filter((r) => r.type === 'TAINT_PATH');
}

describe('U9 — end-to-end interprocedural taint (--pdg)', () => {
  it.each(['ts', 'js'])(
    'keeps %s inline and returned handlers as distinct callers and taint summary owners (#3489)',
    async (extension) => {
      const fixture = path.join(__dirname, 'fixtures', 'inline-taint-repo');
      const repoDir = repos.fromFixture(fixture);
      if (extension === 'js') {
        const tsFile = path.join(repoDir, 'routes.ts');
        // The fixture uses only these two annotations; JS exercises its own grammar.
        fs.writeFileSync(
          path.join(repoDir, 'routes.js'),
          fs.readFileSync(tsFile, 'utf8').replaceAll(': any', '').replaceAll(': string', ''),
        );
        fs.unlinkSync(tsFile);
      }
      const result = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });
      const nodes = [...result.graph.iterNodes()];
      const findings = taintPaths(result).filter(
        (p) => result.graph.getNode(p.targetId)?.properties.name === 'runGit',
      );
      const sourceLines = findings
        .map((p) => result.graph.getNode(p.sourceId)!.properties.startLine)
        .sort((a, b) => Number(a) - Number(b));
      expect(sourceLines).toEqual([5, 10, 13, 16, 19, 25, 31, 37]);
      expect(new Set(findings.map((p) => p.sourceId)).size).toBe(8);
      for (const finding of findings) {
        const source = result.graph.getNode(finding.sourceId)!;
        expect(
          [...result.graph.iterRelationships()].some(
            (r) =>
              r.type === 'CALLS' &&
              r.sourceId === source.id &&
              result.graph.getNode(r.targetId)?.properties.name === 'forward',
          ),
        ).toBe(true);
      }
      const mount = nodes.find((n) => n.label === 'Function' && n.properties.name === 'mount')!;
      expect(
        [...result.graph.iterRelationships()].filter(
          (r) =>
            r.type === 'CALLS' &&
            r.sourceId === mount.id &&
            result.graph.getNode(r.targetId)?.properties.name === 'forward',
        ),
      ).toEqual([]);
      const sameLine = nodes.filter((n) => n.label === 'Function' && n.properties.startLine === 19);
      expect(sameLine).toHaveLength(2);
      expect(new Set(sameLine.map((n) => n.id)).size).toBe(2);
      expect(nodes.find((n) => n.properties.name === 'returnedHandler')).toBeDefined();
      expect(nodes.find((n) => n.properties.name === 'nestedIdentity')?.id).toBe(
        `Function:routes.${extension}:mountIdentity.fn@50:23.nestedIdentity@51:4`,
      );
      const outside = nodes.find((n) => n.properties.name === 'outsideReturned')!;
      expect(
        [...result.graph.iterRelationships()].some(
          (r) =>
            r.type === 'CALLS' &&
            r.sourceId === outside.id &&
            result.graph.getNode(r.targetId)?.properties.name === 'returnedHandler',
        ),
      ).toBe(false);
      const snippets = taintPaths(result).filter(
        (p) => result.graph.getNode(p.targetId)?.properties.name === 'readSnippet',
      );
      expect(snippets).toHaveLength(2);
      for (const p of snippets) {
        const decoded = decodeTaintPath(p.reason);
        expect(decoded.ok && decoded.kind).toBe('path-traversal');
        expect(result.graph.getNode(p.sourceId)?.properties.name).not.toBe('mountSnippet');
      }
      const filters = taintPaths(result).filter(
        (p) => result.graph.getNode(p.targetId)?.properties.name === 'compileFilter',
      );
      expect(filters).toHaveLength(1);
      expect(result.graph.getNode(filters[0].sourceId)?.properties.name).toBe('handleFilter');
      const decodedFilter = decodeTaintPath(filters[0].reason);
      expect(decodedFilter.ok && decodedFilter.kind).toBe('code-injection');
    },
  );
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
