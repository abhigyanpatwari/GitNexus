import { describe, it, expect } from 'vitest';
import { generateId } from '../../src/lib/utils.js';

describe('generateId', () => {
  it('creates id from label and name', () => {
    expect(generateId('Function', 'main')).toBe('Function:main');
  });

  it('handles labels with various node types', () => {
    expect(generateId('File', 'src/index.ts')).toBe('File:src/index.ts');
    expect(generateId('Class', 'UserService')).toBe('Class:UserService');
    expect(generateId('Method', 'getData')).toBe('Method:getData');
    expect(generateId('Folder', 'src')).toBe('Folder:src');
    expect(generateId('Interface', 'IUser')).toBe('Interface:IUser');
  });

  it('handles special characters in name', () => {
    expect(generateId('Function', 'path/to/file.ts:init')).toBe('Function:path/to/file.ts:init');
  });

  it('handles empty strings', () => {
    expect(generateId('', '')).toBe(':');
    expect(generateId('', 'name')).toBe(':name');
    expect(generateId('label', '')).toBe('label:');
  });

  it('handles relationship IDs', () => {
    expect(generateId('CONTAINS', 'Folder:src->File:src/index.ts')).toBe('CONTAINS:Folder:src->File:src/index.ts');
  });

  it('handles multi-language node types', () => {
    expect(generateId('Struct', 'Point')).toBe('Struct:Point');
    expect(generateId('Trait', 'Display')).toBe('Trait:Display');
    expect(generateId('Impl', 'Display for Point')).toBe('Impl:Display for Point');
    expect(generateId('Enum', 'Color')).toBe('Enum:Color');
    expect(generateId('Namespace', 'std')).toBe('Namespace:std');
    expect(generateId('Constructor', 'User')).toBe('Constructor:User');
  });
});
