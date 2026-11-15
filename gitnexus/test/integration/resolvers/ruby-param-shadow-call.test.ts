/**
 * Explicit calls dispatch on self even beside same-named parameters.
 * Ruby invokes callable locals with `.call` or `.()`, never with `target()`.
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

describe('Ruby explicit target() beside a same-named parameter', () => {
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
    '%s: explicit target() beside a same-named parameter calls Host#target',
    (fn) => {
      expect(targetsFrom(fn)).toEqual([hostTargetId]);
    },
  );

  it('run_plain: explicit target() beside an unrelated parameter calls Host#target', () => {
    expect(targetsFrom('run_plain')).toEqual([hostTargetId]);
  });
});
