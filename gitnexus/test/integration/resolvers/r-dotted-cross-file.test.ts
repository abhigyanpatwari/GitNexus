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
 * drop a dotted call (with the hook disabled every edge below is unchanged). The hook's other
 * rules apply to the dotted call as to any other: package code reaches another package only
 * through a link it declares (`other` declares none, so its calls are refused), and an
 * `S3method()` registration is not an export (`print.widget` is private to callers outside
 * `prov`).
 *
 * Layout: `prov/R/defs.R` defines `helper.util`, `print.widget` and `plain_fn`; callers
 * are in the same package (`prov/R/use.R`), another package (`other/R/use.R`) that does
 * not import `prov`, a script that `library(prov)`s, and a script with no import at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

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

  it('refuses a dotted call from a package that does not import the provider', () => {
    expect(edges('other_helper')).toEqual([]);
    expect(edges('other_print')).toEqual([]);
  });

  it('binds an exported dotted call from a script with library(prov) and from one with no import', () => {
    expect(edges('script_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
    expect(edges('bare_helper')).toEqual([`helper.util:${DEFS}:${QUALIFIED}`]);
  });

  it('refuses a script call of a method that NAMESPACE only registers (S3method())', () => {
    expect(edges('script_print')).toEqual([]);
  });

  it('control: an undotted cross-file call in the package still goes through the global-name fallback (0.5)', () => {
    expect(edges('same_pkg_plain')).toEqual([`plain_fn:${DEFS}:global-name-fallback:0.5`]);
  });

  it('control: an undotted call from a package that does not import the provider is refused too', () => {
    expect(edges('other_plain')).toEqual([]);
  });
});
