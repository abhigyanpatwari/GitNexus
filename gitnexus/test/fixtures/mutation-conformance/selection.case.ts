// Conformance fixture (gate 2), selection scope: the scope's testIds select "scales two" only, so
// the dry run skips "scales one" and every coverage, outcome and hook marker names only the
// selected test.
import { beforeAll, describe, expect, it } from 'vitest';
import { scale, unit } from './src/selection.js';

describe('scaling', () => {
  let suffix = '';

  beforeAll(() => {
    suffix = unit();
  });

  it('scales one', () => {
    expect(`${scale(1)}${suffix}`).toBe('3x');
  });

  it('scales two', () => {
    expect(`${scale(2)}${suffix}`).toBe('6x');
  });
});
