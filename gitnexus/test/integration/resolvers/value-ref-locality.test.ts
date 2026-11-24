import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';

const LANG_FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');

interface AccessEdge {
  readonly source: string;
  readonly target: string;
  readonly targetLabel: string;
  readonly reason: string;
}

const accessesOf = (result: PipelineResult): AccessEdge[] => {
  const out: AccessEdge[] = [];
  result.graph.forEachRelationship((r) => {
    if (r.type !== 'ACCESSES') return;
    const source = result.graph.getNode(r.sourceId);
    const target = result.graph.getNode(r.targetId);
    out.push({
      source: String(source?.properties.name ?? ''),
      target: String(target?.properties.name ?? ''),
      targetLabel: String(target?.label ?? ''),
      reason: String(r.reason ?? ''),
    });
  });
  return out;
};

describe('value-reference locality filter', () => {
  describe('the two cases the filter exists for still hold', () => {
    let js: PipelineResult;

    beforeAll(async () => {
      js = await runPipelineFromRepo(
        path.join(LANG_FIXTURES, 'javascript-const-references'),
        () => {},
        {},
      );
    }, 60_000);

    it('keeps a module-scope const read', () => {
      const targets = accessesOf(js).map((e) => e.target);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets).toContain('DEFAULT_FETCH_LIMIT');
    });

    it('drops a function-local const read', () => {
      // The whole reason the filter exists. `localScratchValue` is declared and
      // read inside one function; an edge to it retains a symbol
      // `pruneLocalSymbols` would otherwise remove.
      expect(accessesOf(js).map((e) => e.target)).not.toContain('localScratchValue');
    });
  });
});
