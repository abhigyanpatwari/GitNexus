/**
 * The group nesting limit of the export-pattern engine must lie inside what the call stack
 * allows, or whether a deep pattern compiles depends on how warm the process is.
 */
import { describe, it, expect } from 'vitest';
import {
  compileLinearRegex,
  compileLinearRegexDetailed,
  MAX_NESTING,
} from '../../src/core/ingestion/languages/r/linear-regex.js';

const reasonOf = (r: ReturnType<typeof compileLinearRegexDetailed>): string =>
  'reason' in r ? r.reason : '';

describe('MAX_NESTING does not depend on how warm the process is', () => {
  const nested = (depth: number): string => '('.repeat(depth) + 'a' + ')'.repeat(depth);

  it('is 256, a quarter-stack-safe depth', () => {
    expect(MAX_NESTING).toBe(256);
  });

  it('accepts exactly MAX_NESTING levels and refuses one more with the right reason', () => {
    expect(compileLinearRegex(nested(256))).not.toBeNull();
    const refused = compileLinearRegexDetailed(nested(257));
    expect(reasonOf(refused)).toBe('groups are nested too deeply');
  });
});
