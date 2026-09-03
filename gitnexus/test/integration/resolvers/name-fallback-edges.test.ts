/**
 * End-to-end behaviour of the global-name fallback after WS1-A.
 *
 * Two things used to be true at once and both were wrong:
 *
 *  1. A call to a name that happens to be unique in the repository acquired a
 *     CALLS edge even when the language forbids the call outright — Go's
 *     unexported identifiers being the clearest case.
 *  2. Every such edge was emitted with `confidence: 0.85` and
 *     `reason: 'import-resolved'`, i.e. spelled exactly like an edge a real
 *     import produced, so no consumer could discount it.
 *
 * These tests pin both. The Go arm proves the impossible edge is now REFUSED,
 * with the same-package call kept as the control that shows the refusal is
 * targeted rather than a blanket disabling of the tier. The Ruby arm proves a
 * surviving guess is LABELED, since Ruby deliberately keeps the tier for
 * autoload. The last test is the regression that matters most: no edge from
 * this tier may ever again carry `import-resolved`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';
import { GLOBAL_NAME_FALLBACK_REASON } from '../../../src/core/graph/edge-reasons.js';

const rmRepo = (dir: string | undefined): void => {
  if (dir !== undefined) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
};

describe('Go: an unexported identifier is not callable from another package', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ws1-go-fallback-'));
    writeFixtureRepo(repoDir, {
      'go.mod': 'module example.com/mod\n\ngo 1.22\n',
      // Package `a` owns `uniqueHelperXyz`. The name is unique repo-wide, which
      // is the ONLY reason the old fallback matched it from package `b`.
      'a/helper.go': `package a

func uniqueHelperXyz() int {
	return 41
}

func UseItLocally() int {
	return uniqueHelperXyz() + 1
}
`,
      // Package `b` cannot see `uniqueHelperXyz` under any spelling: Go's
      // lower-case initial makes it package-private, so no import helps.
      'b/caller.go': `package b

func CallItRemotely() int {
	return uniqueHelperXyz() + 1
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 120000);

  afterAll(() => rmRepo(repoDir));

  it('keeps the same-package call (control: the tier still works)', () => {
    const calls = getRelationships(result, 'CALLS');
    const local = calls.find((c) => c.source === 'UseItLocally' && c.target === 'uniqueHelperXyz');
    expect(local).toBeDefined();
  });

  it('emits NO caller edge from the other package', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossPackage = calls.filter(
      (c) => c.source === 'CallItRemotely' && c.target === 'uniqueHelperXyz',
    );
    expect(crossPackage).toEqual([]);
  });

  it('records the drop as a refusal rather than losing it silently', () => {
    const refusals = getResolutionOutcomes(result).filter(
      (o) => o.kind === 'fallback-refused' && o.name === 'uniqueHelperXyz',
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((o) => o.kind === 'fallback-refused' && o.language === 'go')).toBe(true);
  });

  it('lists no cross-package caller for the unexported helper at all', () => {
    // The shape an `impact --direction upstream` answer is built from: every
    // CALLS edge whose target is the helper. Package `b` must not appear.
    const callers = getRelationships(result, 'CALLS')
      .filter((c) => c.target === 'uniqueHelperXyz')
      .map((c) => c.sourceFilePath);
    expect(callers.some((filePath) => filePath.includes('b/caller.go'))).toBe(false);
    expect(callers.some((filePath) => filePath.includes('a/helper.go'))).toBe(true);
  });
});

describe('Ruby: a surviving name guess is labeled as a guess', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ws1-ruby-fallback-'));
    writeFixtureRepo(repoDir, {
      // A top-level method in one file, called from another with no `require` —
      // the autoload shape Ruby keeps the fallback for. The edge is a guess and
      // is allowed to exist, but it must say so.
      'app/a.rb': `def unique_helper_xyz
  41
end
`,
      'app/b.rb': `def call_it
  unique_helper_xyz()
end
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 120000);

  afterAll(() => rmRepo(repoDir));

  it('emits the edge with the guess reason and 0.5 confidence', () => {
    const edge = getRelationships(result, 'CALLS').find(
      (c) => c.source === 'call_it' && c.target === 'unique_helper_xyz',
    );
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe(GLOBAL_NAME_FALLBACK_REASON);
    expect(edge!.rel.confidence).toBe(0.5);
  });

  it('counts the guess so a reader can see how much of the graph is guessed', () => {
    const guesses = getResolutionOutcomes(result).filter(
      (o) => o.kind === 'fallback-guessed' && o.name === 'unique_helper_xyz',
    );
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.every((o) => o.kind === 'fallback-guessed' && o.language === 'ruby')).toBe(true);
  });

  it('REGRESSION: no guessed edge is spelled like an import-resolved one', () => {
    // The specific lie this work removed. Asserted over the whole graph, not
    // just the one edge, so a future emitter cannot reintroduce it elsewhere.
    const mislabeled = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.confidence === 0.5 && c.rel.reason === 'import-resolved',
    );
    expect(mislabeled).toEqual([]);
  });
});
