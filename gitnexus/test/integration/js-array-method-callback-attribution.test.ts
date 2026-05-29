/**
 * JavaScript: CALLS-edge attribution for calls inside array higher-order-
 * method callbacks (issue #1876).
 *
 * `const exportData = accountsList.map(account => transform(account))` matches
 * the HOC-wrapped-arrow declaration pattern, so before this fix the JS scope
 * model emitted a phantom `Function:exportData` for the `.map` callback (on
 * top of the value binding). Calls nested in the callback (`transform`) then
 * attributed to that phantom `Function` instead of the enclosing scope.
 *
 * U1 drops the `@declaration.function` for array-method callbacks, so the
 * binding is value-only and the inner call falls through to the File scope —
 * exactly the Zustand module-level-call behavior already pinned for TS.
 *
 * SCOPE: this asserts the registry-primary CALLS-edge ATTRIBUTION change only.
 * The duplicate *graph node* (`Function:exportData`) is created by the legacy
 * parse-worker node path, which this change does not touch; collapsing it is
 * the deferred node-creation migration. Accordingly this file makes NO node-
 * count assertion.
 *
 * Registry-primary-only correctness win: under the forced-legacy parity flag
 * (`REGISTRY_PRIMARY_JAVASCRIPT=0`) the legacy DAG still emits the phantom
 * attribution, so the suite is skipped there (mirrors the per-language
 * expected-failure handling in `resolvers/helpers.ts`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  isLegacyResolverParityRun,
  runPipelineFromRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe.skipIf(isLegacyResolverParityRun('javascript'))(
  'JavaScript array-method-callback CALLS attribution (#1876)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'javascript-array-method-callback'),
        () => {},
      );
    }, 60000);

    it('control: run() body calls transform directly (resolver is wired)', () => {
      const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'transform');
      expect(calls.map((c) => `${c.source} → ${c.target}`)).toContain('run → transform');
    });

    it('call inside .map callback attributes to File, not a phantom Function:exportData', () => {
      const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'transform');
      const fromExportData = calls.filter((c) => c.source === 'exportData');
      expect(
        fromExportData,
        'transform must NOT be attributed to exportData (phantom Function)',
      ).toEqual([]);
      const fromFile = calls.filter((c) => c.sourceLabel === 'File');
      expect(
        fromFile,
        'the .map callback call to transform must source from the File node (exactly once)',
      ).toHaveLength(1);
    });

    it('call inside .find callback attributes to File, not a phantom Function:firstActive', () => {
      const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'predicate');
      const fromFirstActive = calls.filter((c) => c.source === 'firstActive');
      expect(
        fromFirstActive,
        'predicate must NOT be attributed to firstActive (phantom Function)',
      ).toEqual([]);
      const fromFile = calls.filter((c) => c.sourceLabel === 'File');
      expect(
        fromFile,
        'the .find callback call to predicate must source from the File node (exactly once)',
      ).toHaveLength(1);
    });
  },
);
