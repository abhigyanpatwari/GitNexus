import { describe, expect, it } from 'vitest';
import { extractElementTypeFromString } from '../../src/core/ingestion/type-extractors/shared.js';

const elementAtLimit = 'A'.repeat(2048 - 'Array<>'.length);

describe('extractElementTypeFromString input length limit', () => {
  it('accepts a valid container at 2048 characters', () => {
    const container = `Array<${elementAtLimit}>`;
    expect(container).toHaveLength(2048);
    expect(extractElementTypeFromString(container)).toBe(elementAtLimit);
  });

  it('rejects an otherwise valid container at 2049 characters', () => {
    const container = `Array<${elementAtLimit}A>`;
    expect(container).toHaveLength(2049);
    expect(extractElementTypeFromString(container)).toBeUndefined();
  });
});
