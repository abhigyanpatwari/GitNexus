/**
 * Documentation of PRE-EXISTING behaviour (these cases hold on main; they
 * prove no fix): an explicit `target()` call beside a same-named parameter.
 *
 * `RUBY_CALLABLE_CAPTURE_OPTIONS` models `param()` as an invoke through the
 * parameter cell, so beside a same-named parameter the explicit call resolves
 * to nothing. The assertion is exact (`[]`), so closing the gap — even to the
 * correct `Host#target` — fails here and forces the gaps doc to be updated
 * with it. Beside an unrelated parameter it resolves normally. Recorded in
 * docs/languages/ruby-ingestion-gaps.md as a known gap; kept out of
 * ruby-yard-param-scope.test.ts, whose cases must each fail without their fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('Ruby explicit target() beside a same-named parameter (pre-existing gap, documented)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let hostTargetId: string;

  const targetsFrom = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.source === source && c.target === 'target')
      .map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-param-shadow-call-'));
    writeFixtureRepo(tmpDir, {
      'host.rb': `class Host
  def target
    true
  end

  def run(target)
    target()
  end

  def run_in_block(target)
    [1].each { |target| target() }
  end

  def run_plain(other)
    target()
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
    const edge = getRelationships(result, 'HAS_METHOD').find(
      (e) => e.source === 'Host' && e.target === 'target',
    );
    if (edge === undefined) throw new Error('fixture lost Host#target');
    hostTargetId = edge.rel.targetId;
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['run', 'run_in_block'] as const)(
    '%s: explicit target() beside a same-named parameter resolves to nothing (the documented gap; a fix must update the gaps doc)',
    (fn) => {
      expect(targetsFrom(fn)).toEqual([]);
    },
  );

  it('run_plain: explicit target() beside an unrelated parameter calls Host#target', () => {
    expect(targetsFrom('run_plain')).toEqual([hostTargetId]);
  });
});
