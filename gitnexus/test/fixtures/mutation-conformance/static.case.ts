// Conformance fixture (gate 2): static mutants, hit while modules load or tests are collected.
import { describe, expect, it } from 'vitest';
import { UNITS, rowNames, suiteLabel } from './src/static-table.js';

it('reads the unit table', () => {
  expect(UNITS.ms).toBe('milliseconds');
});

describe('a suite whose body calls production code', () => {
  const label = suiteLabel();

  it('keeps the label computed during collection', () => {
    expect(label).toBe('collected');
  });
});

it.each(rowNames())('row %s', (name) => {
  expect(['alpha', 'beta']).toContain(name);
});
