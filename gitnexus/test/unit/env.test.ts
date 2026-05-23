import { describe, expect, it } from 'vitest';
import { parseTruthyEnv } from '../../src/core/ingestion/utils/env.js';

describe('parseTruthyEnv', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['TRUE', true],
    ['Yes', true],
    ['YES', true],
    ['  1  ', true],
    [' true ', true],
    ['\tyes\n', true],
  ])('accepts %j as truthy', (raw, expected) => {
    expect(parseTruthyEnv(raw)).toBe(expected);
  });

  it.each([
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['', false],
    [' ', false],
    ['maybe', false],
    ['2', false],
    ['truthy', false],
    ['1.0', false],
    ['yes please', false],
  ])('rejects %j as falsy', (raw, expected) => {
    expect(parseTruthyEnv(raw)).toBe(expected);
  });

  it('returns false for undefined', () => {
    expect(parseTruthyEnv(undefined)).toBe(false);
  });
});
