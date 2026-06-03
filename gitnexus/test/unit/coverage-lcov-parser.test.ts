import { describe, it, expect } from 'vitest';
import { parseLcov } from '../../src/core/coverage/parsers/lcov.js';

describe('parseLcov', () => {
  const meta = { id: 'test-run', timestamp: '2026-06-03T00:00:00Z' };

  it('parses a basic LCOV file', () => {
    const input = `TN:test
SF:src/foo.ts
DA:1,5
DA:2,0
DA:3,10
LF:3
LH:2
end_of_record`;

    const result = parseLcov(input, meta);
    expect(result.format).toBe('gitnexus-coverage-v1');
    expect(result.files['src/foo.ts'].lines['1']).toBe(5);
    expect(result.files['src/foo.ts'].lines['2']).toBe(0);
    expect(result.run.totalLines).toBe(3);
    expect(result.run.coveredLines).toBe(2);
  });

  it('parses multiple files', () => {
    const input = `SF:src/a.ts
DA:1,3
end_of_record
SF:src/b.ts
DA:1,0
DA:2,5
end_of_record`;

    const result = parseLcov(input, meta);
    expect(Object.keys(result.files)).toHaveLength(2);
    expect(result.files['src/a.ts'].lines['1']).toBe(3);
    expect(result.files['src/b.ts'].lines['2']).toBe(5);
  });

  it('parses branch coverage', () => {
    const input = `SF:src/foo.ts
DA:10,5
BRDA:10,0,0,3
BRDA:10,0,1,2
end_of_record`;

    const result = parseLcov(input, meta);
    expect(result.files['src/foo.ts'].branches!['10:0']).toBe(3);
    expect(result.files['src/foo.ts'].branches!['10:1']).toBe(2);
  });

  it('handles empty input', () => {
    const result = parseLcov('', meta);
    expect(Object.keys(result.files)).toHaveLength(0);
  });
});
