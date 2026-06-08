/**
 * Unit tests for coverage color utilities.
 */

import { describe, expect, it } from 'vitest';
import { coverageColor, coverageLabel, coverageEdgeStyle } from '../../src/lib/coverage-colors';

describe('coverageColor', () => {
  it('returns gray for undefined coverage', () => {
    expect(coverageColor(undefined)).toBe('#484f58');
  });

  it('returns green for high coverage (>= 0.8)', () => {
    expect(coverageColor(0.8)).toBe('#10b981');
    expect(coverageColor(0.95)).toBe('#10b981');
    expect(coverageColor(1.0)).toBe('#10b981');
  });

  it('returns amber for medium coverage (>= 0.4 and < 0.8)', () => {
    expect(coverageColor(0.4)).toBe('#f59e0b');
    expect(coverageColor(0.6)).toBe('#f59e0b');
    expect(coverageColor(0.79)).toBe('#f59e0b');
  });

  it('returns red for low coverage (> 0 and < 0.4)', () => {
    expect(coverageColor(0.01)).toBe('#ef4444');
    expect(coverageColor(0.2)).toBe('#ef4444');
    expect(coverageColor(0.39)).toBe('#ef4444');
  });

  it('returns gray for zero coverage', () => {
    expect(coverageColor(0)).toBe('#484f58');
  });
});

describe('coverageLabel', () => {
  it('returns "No data" for undefined', () => {
    expect(coverageLabel(undefined)).toBe('No data');
  });

  it('returns "Well covered" for >= 0.8', () => {
    expect(coverageLabel(0.8)).toBe('Well covered');
  });

  it('returns "Partial" for >= 0.4', () => {
    expect(coverageLabel(0.5)).toBe('Partial');
  });

  it('returns "Poor" for > 0 and < 0.4', () => {
    expect(coverageLabel(0.1)).toBe('Poor');
  });

  it('returns "Uncovered" for 0', () => {
    expect(coverageLabel(0)).toBe('Uncovered');
  });
});

describe('coverageEdgeStyle', () => {
  it('returns "solid" when traversed is true', () => {
    expect(coverageEdgeStyle(true)).toBe('solid');
  });

  it('returns "dashed" when traversed is false', () => {
    expect(coverageEdgeStyle(false)).toBe('dashed');
  });
});