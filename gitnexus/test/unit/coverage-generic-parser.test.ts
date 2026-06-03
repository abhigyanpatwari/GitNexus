import { describe, it, expect } from 'vitest';
import { parseGenericCoverage } from '../../src/core/coverage/parsers/generic.js';

describe('parseGenericCoverage', () => {
  it('parses valid canonical format', () => {
    const input = JSON.stringify({
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-1', timestamp: '2026-06-03T00:00:00Z' },
      files: { 'src/foo.ts': { lines: { '1': 5, '2': 0 } } },
    });

    const result = parseGenericCoverage(input);
    expect(result.format).toBe('gitnexus-coverage-v1');
    expect(result.files['src/foo.ts'].lines['1']).toBe(5);
  });

  it('throws on invalid format', () => {
    expect(() => parseGenericCoverage('{"format":"bad"}')).toThrow();
  });

  it('throws on non-JSON', () => {
    expect(() => parseGenericCoverage('not json')).toThrow();
  });

  it('throws when run is missing', () => {
    expect(() =>
      parseGenericCoverage(JSON.stringify({ format: 'gitnexus-coverage-v1', files: {} })),
    ).toThrow();
  });
});
