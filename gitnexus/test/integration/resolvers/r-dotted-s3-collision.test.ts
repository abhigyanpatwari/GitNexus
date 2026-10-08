/**
 * R: dotted (S3 method) names must not collide with same-tailed bare names
 * in the shared simple-name indexes.
 *
 * The shared indexes key every def by the text after the last `.` of its
 * qualifiedName, so `print.foo` is indexed under `foo` next to a bare `foo`.
 * Two defects followed: a `library(prov)` wildcard bound `foo` to `print.foo`
 * when the S3 method was declared first (a wrong 0.85 edge), and a bare
 * cross-file call `foo(v)` saw two candidates and got no edge at all.
 *
 * Fixture layout: `prov/R/prov.R` declares `print.foo` BEFORE `foo`, `bar`
 * BEFORE `print.bar`, `summary.baz` after `baz`, a control `qux` with no S3
 * method and a backticked `odd name`; `cons/` and `scripts/run.R` reach them
 * through `library(prov)`; `prov/R/other.R` calls them from the same package.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('R dotted (S3) names vs same-tailed bare names', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-dotted-s3-collision'), () => {});
  }, 60000);

  /** `target:targetFile:reason:confidence` of every CALLS edge from `source` in `fileSuffix`. */
  const edges = (source: string, fileSuffix: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source && e.sourceFilePath.endsWith(fileSuffix))
      .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  const PROV = 'prov/R/prov.R';

  describe('library(prov) wildcard import', () => {
    it('binds foo to the bare def, never to print.foo declared before it', () => {
      const e = edges('use_foo', 'cons/R/cons.R');
      expect(e.filter((x) => x.startsWith('print.foo:'))).toEqual([]);
      expect(e).toEqual([`foo:${PROV}:global-name-fallback:0.5`]);
    });

    it('also keeps a script caller (no package NAMESPACE) off print.foo', () => {
      expect(edges('script_foo', 'scripts/run.R')).toEqual([
        `foo:${PROV}:global-name-fallback:0.5`,
      ]);
    });

    it('reversed declaration order (bare bar before print.bar) resolves to the bare def', () => {
      expect(edges('use_bar', 'cons/R/cons.R')).toEqual([`bar:${PROV}:global-name-fallback:0.5`]);
      expect(edges('script_bar', 'scripts/run.R')).toEqual([
        `bar:${PROV}:global-name-fallback:0.5`,
      ]);
    });

    it('bare name with an S3 method declared after it (baz / summary.baz) resolves to the bare def', () => {
      expect(edges('use_baz', 'cons/R/cons.R')).toEqual([`baz:${PROV}:global-name-fallback:0.5`]);
    });

    it('control: a name with no same-tailed S3 method is still import-resolved at 0.85', () => {
      expect(edges('use_qux', 'cons/R/cons.R')).toEqual([`qux:${PROV}:import-resolved:0.85`]);
      expect(edges('script_qux', 'scripts/run.R')).toEqual([`qux:${PROV}:import-resolved:0.85`]);
    });
  });

  describe('same-package cross-file bare calls', () => {
    const OTHER = 'prov/R/other.R';

    it('foo(v) gets a fallback edge to the bare def (was: no edge, two tail candidates)', () => {
      expect(edges('same_pkg_foo', OTHER)).toEqual([`foo:${PROV}:global-name-fallback:0.5`]);
    });

    it('bar(v) and baz(v) resolve to the bare defs', () => {
      expect(edges('same_pkg_bar', OTHER)).toEqual([`bar:${PROV}:global-name-fallback:0.5`]);
      expect(edges('same_pkg_baz', OTHER)).toEqual([`baz:${PROV}:global-name-fallback:0.5`]);
    });

    it('control: qux(v) keeps its fallback edge', () => {
      expect(edges('same_pkg_qux', OTHER)).toEqual([`qux:${PROV}:global-name-fallback:0.5`]);
    });
  });

  describe('dotted call sites', () => {
    it('print.foo(x) in the same package resolves to the S3 def via qualified lookup (0.35)', () => {
      expect(edges('dotted_call', 'prov/R/other.R')).toEqual([
        `print.foo:${PROV}:scope-resolution: call:0.35`,
      ]);
    });

    it('print.foo(x) through library(prov) resolves to the S3 def (0.35)', () => {
      expect(edges('use_dotted', 'cons/R/cons.R')).toEqual([
        `print.foo:${PROV}:scope-resolution: call:0.35`,
      ]);
    });
  });

  describe('backticked names (characterisation, unchanged by this fix)', () => {
    it('a backticked def keeps its backticks in the name and still resolves like any bare name', () => {
      // The qualifiedName keeps the backticks, so the wildcard binds the literal name and a
      // same-package call falls back to a unique-name guess. There is no dotted tail involved;
      // pinned so a future change to backtick handling is a deliberate decision.
      expect({
        cons: edges('use_odd', 'cons/R/cons.R'),
        samePkg: edges('same_pkg_odd', 'prov/R/other.R'),
      }).toEqual({
        cons: [`\`odd name\`:${PROV}:import-resolved:0.85`],
        samePkg: [`\`odd name\`:${PROV}:global-name-fallback:0.5`],
      });
    });
  });
});
