/**
 * Unit tests for the shared CLI integer flag parser (`src/cli/int-option.ts`).
 */
import { describe, it, expect } from 'vitest';
import { IntegerOptionError, parseIntegerOption } from '../../src/cli/int-option.js';

describe('parseIntegerOption', () => {
  it.each([
    ['1', 1, 1],
    ['42', 1, 42],
    ['  7  ', 1, 7],
    ['200', 200, 200],
    ['4096', 200, 4096],
    ['0', 0, 0],
    ['5', 0, 5],
  ])('parses %j with minimum %i to %i', (value, minimum, expected) => {
    expect(parseIntegerOption(value, '--flag', { minimum })).toBe(expected);
  });

  it.each(['abc', '1.5', '-5', '', '   ', '1e3', '0x10', '01'])(
    'rejects %j with the positive-integer message when the minimum is 1',
    (value) => {
      expect(() => parseIntegerOption(value, '--workers', { minimum: 1 })).toThrow(
        new IntegerOptionError('--workers', 1, '--workers must be a positive integer'),
      );
    },
  );

  it('rejects 0 with the positive-integer message when the minimum is 1', () => {
    expect(() => parseIntegerOption('0', '--retries', { minimum: 1 })).toThrow(
      '--retries must be a positive integer',
    );
  });

  it.each(['abc', '1.5', '-5', '', '199', '0'])(
    'rejects %j with a message naming the flag and a minimum of 200',
    (value) => {
      expect(() => parseIntegerOption(value, '--memory-budget', { minimum: 200 })).toThrow(
        '--memory-budget must be an integer >= 200',
      );
    },
  );

  it('rejects -1 with a message naming the flag and a minimum of 0', () => {
    expect(() => parseIntegerOption('-1', '--embeddings', { minimum: 0 })).toThrow(
      '--embeddings must be an integer >= 0',
    );
  });

  it('throws an IntegerOptionError carrying the flag and minimum', () => {
    const thrown = (() => {
      try {
        parseIntegerOption('abc', '--memory-budget', { minimum: 200 });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(IntegerOptionError);
    expect(thrown).toMatchObject({ flag: '--memory-budget', minimum: 200 });
  });

  it('rejects a value above the safe-integer bound divided by the scale', () => {
    const bound = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
    expect(parseIntegerOption(String(bound), '--timeout', { minimum: 1, scale: 1000 })).toBe(bound);
    expect(() =>
      parseIntegerOption(String(bound + 1), '--timeout', { minimum: 1, scale: 1000 }),
    ).toThrow('--timeout is too large');
  });

  it('rejects a value above the safe-integer bound without a scale', () => {
    expect(() => parseIntegerOption('9007199254740992', '--workers', { minimum: 1 })).toThrow(
      '--workers is too large',
    );
  });
});
