import { describe, it, expect } from 'vitest';
import {
  normalizeQualifiedName,
  stripTrailingTypeArguments,
} from '../../../src/core/ingestion/utils/qualified-name.js';

describe('stripTrailingTypeArguments', () => {
  it('strips a single generic arg list at depth 0', () => {
    expect(stripTrailingTypeArguments('Models.Box<int>')).toBe('Models.Box');
  });

  it('preserves nested generic brackets in the type name', () => {
    expect(stripTrailingTypeArguments('Ns.Outer<int>.Inner')).toBe('Ns.Outer<int>.Inner');
  });

  it('composes with normalizeQualifiedName for qualified ctor sites', () => {
    const key = stripTrailingTypeArguments(normalizeQualifiedName('Models.Box<int>'));
    expect(key).toBe('Models.Box');
  });
});
