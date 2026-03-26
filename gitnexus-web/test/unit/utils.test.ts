import { describe, expect, it } from 'vitest';
import { generateId } from '../../src/lib/utils';

describe('generateId', () => {
  it('creates label:name format', () => {
    expect(generateId('File', 'index.ts')).toBe('File:index.ts');
    expect(generateId('Function', 'main')).toBe('Function:main');
  });

  it('handles empty strings', () => {
    expect(generateId('', '')).toBe(':');
  });

  it('preserves special characters in name', () => {
    expect(generateId('File', 'src/components/App.tsx')).toBe('File:src/components/App.tsx');
  });
});
