import { describe, it, expect } from 'vitest';
import { formatElapsed } from '../../src/cli/format-elapsed.js';

describe('formatElapsed', () => {
  it('formats 0 seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
  });

  it('formats seconds below 60', () => {
    expect(formatElapsed(1)).toBe('1s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('formats exactly 60 seconds as 1m 0s', () => {
    expect(formatElapsed(60)).toBe('1m 0s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(61)).toBe('1m 1s');
    expect(formatElapsed(125)).toBe('2m 5s');
  });

  it('formats the last second before an hour', () => {
    expect(formatElapsed(3599)).toBe('59m 59s');
  });

  it('formats exactly 3600 seconds as 1h 0m', () => {
    expect(formatElapsed(3600)).toBe('1h 0m');
  });

  it('formats hours and minutes', () => {
    expect(formatElapsed(3661)).toBe('1h 1m');
    expect(formatElapsed(7200)).toBe('2h 0m');
    expect(formatElapsed(7323)).toBe('2h 2m');
  });
});
