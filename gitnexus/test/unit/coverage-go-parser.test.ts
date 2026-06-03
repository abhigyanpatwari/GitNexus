import { describe, it, expect } from 'vitest';
import { parseGoCover } from '../../src/core/coverage/parsers/go-cover.js';

describe('parseGoCover', () => {
  const meta = { id: 'test-run', timestamp: '2026-06-03T00:00:00Z' };

  it('parses a Go coverprofile (mode: set)', () => {
    const input = `mode: set
module/foo.go:10.2,15.8 3 1
module/foo.go:20.0,25.0 5 0`;

    const result = parseGoCover(input, meta);
    expect(result.files['module/foo.go']).toBeDefined();
    expect(result.files['module/foo.go'].lines['10']).toBeGreaterThan(0);
    expect(result.files['module/foo.go'].lines['20']).toBe(0);
  });

  it('handles mode: count', () => {
    const input = `mode: count
pkg/main.go:5.0,10.0 2 15`;

    const result = parseGoCover(input, meta);
    expect(result.files['pkg/main.go'].lines['5']).toBe(15);
  });

  it('ignores mode line', () => {
    const input = `mode: set`;
    const result = parseGoCover(input, meta);
    expect(Object.keys(result.files)).toHaveLength(0);
  });
});
