/**
 * R: a call that spells a dotted function name (`helper.util(x)`, `print.widget(x)`)
 * in another file, with no import naming it.
 *
 * `rIsCallableVisibleFromCaller` refuses every candidate whose qualified name contains
 * a `.`, so that a bare `foo(x)` cannot reach `print.foo`. The free-call fallback's
 * simple-name index keys a def by the text after its last `.`, so a call spelled
 * `helper.util` never finds `helper.util` there, and the hook has nothing to refuse for
 * it. The call binds in the later qualified-name pass (reason `scope-resolution: call`,
 * confidence 0.35) instead. This file pins that: the hook's blanket rejection does not
 * drop a dotted call (with the hook disabled every edge below is unchanged).
 *
 * Layout: `prov/R/defs.R` defines `helper.util`, `print.widget` and `plain_fn`; callers
 * are in the same package (`prov/R/use.R`), another package (`other/R/use.R`) that does
 * not import `prov`, a script that `library(prov)`s, and a script with no import at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('R dotted function names called across files', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-dotted-cross-file'), () => {});
  }, 60000);

  /** `target:targetFile:reason:confidence` of every CALLS edge from `source`. */
  const edges = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  const DEFS = 'prov/R/defs.R';
  const QUALIFIED = 'scope-resolution: call:0.35';

  it('binds a dotted call in the same package through the qualified-name pass', () => {
    expect(edges('same_pkg_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
    expect(edges('same_pkg_print')).toEqual([`print.widget:${DEFS}:${QUALIFIED}`]);
  });

  it('binds a dotted call from a package that does not import the provider', () => {
    expect(edges('other_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
    expect(edges('other_print')).toEqual([`print.widget:${DEFS}:${QUALIFIED}`]);
  });

  it('binds a dotted call from a script with library(prov) and from one with no import', () => {
    expect(edges('script_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
    expect(edges('script_print')).toEqual([`print.widget:${DEFS}:${QUALIFIED}`]);
    expect(edges('bare_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
  });

  it('control: an undotted cross-file call still goes through the global-name fallback (0.5)', () => {
    expect(edges('same_pkg_plain')).toEqual([`plain_fn:${DEFS}:global-name-fallback:0.5`]);
    expect(edges('other_plain')).toEqual([`plain_fn:${DEFS}:global-name-fallback:0.5`]);
  });
});
