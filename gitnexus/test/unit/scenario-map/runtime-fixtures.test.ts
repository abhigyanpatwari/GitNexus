import { expect, it } from 'vitest';
import {
  mergeCoverageSlices,
  type CoverageSliceFile,
} from '../../../tools/scenario-map/path-coverage/slices.js';

it('preserves capture versions and rejects mixed instrumented and archived coverage slices', () => {
  const slice = (index: number, captured: boolean): CoverageSliceFile => ({
    schemaVersion: 1,
    index,
    of: 2,
    layer1: [],
    mutation: 'none',
    changed: null,
    revision: null,
    work: {
      schemaVersion: 1,
      ...(captured ? { fixtureCaptureVersion: 1 } : {}),
      mode: 'normal',
      extraRoots: [],
      repeats: 1,
      blocks: [],
      files: [],
      tests: [],
      unhandledErrors: [],
    },
  });
  expect(
    mergeCoverageSlices([[], []], [slice(0, true), slice(1, true)]).fixtureCaptureVersion,
  ).toBe(1);
  expect(
    mergeCoverageSlices([[], []], [slice(0, false), slice(1, false)]).fixtureCaptureVersion,
  ).toBeUndefined();
  expect(() => mergeCoverageSlices([[], []], [slice(0, true), slice(1, false)])).toThrow(
    'not the run',
  );
});
