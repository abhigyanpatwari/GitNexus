// Original callbacks used as static inputs for the scenario-map recall audit.
import { describe, it, expect } from 'vitest';
import { extractElementTypeFromString } from '../../../src/core/ingestion/type-extractors/shared.js';

describe('extractElementTypeFromString', () => {
  it('strips array suffix: User[] → User', () => {
    expect(extractElementTypeFromString('User[]')).toBe('User');
  });

  it('strips array suffix for primitive: string[] → string', () => {
    expect(extractElementTypeFromString('string[]')).toBe('string');
  });

  it('returns undefined for just brackets: []', () => {
    // Empty base after stripping suffix
    expect(extractElementTypeFromString('[]')).toBeUndefined();
  });

  it('returns undefined when base is not a simple word: user model[]', () => {
    expect(extractElementTypeFromString('user model[]')).toBeUndefined();
  });

  it('strips Go slice prefix: []User → User', () => {
    expect(extractElementTypeFromString('[]User')).toBe('User');
  });

  it('strips Go slice prefix for primitive: []string → string', () => {
    expect(extractElementTypeFromString('[]string')).toBe('string');
  });

  it('unwraps Swift array sugar: [User] → User', () => {
    expect(extractElementTypeFromString('[User]')).toBe('User');
  });

  it('unwraps single-arg generic angle: Array<User> → User', () => {
    expect(extractElementTypeFromString('Array<User>')).toBe('User');
  });

  it('unwraps single-arg generic angle: C++ vector<User> → User', () => {
    expect(extractElementTypeFromString('vector<User>')).toBe('User');
  });

  it('unwraps single-arg generic angle: Rust Vec<User> → User', () => {
    expect(extractElementTypeFromString('Vec<User>')).toBe('User');
  });

  it('unwraps Python subscript: List[User] → User', () => {
    expect(extractElementTypeFromString('List[User]')).toBe('User');
  });

  it('returns last arg by default for Map<String, User>: → User', () => {
    expect(extractElementTypeFromString('Map<String, User>')).toBe('User');
  });

  it('returns first arg with pos=first for Map<String, User>: → String', () => {
    expect(extractElementTypeFromString('Map<String, User>', 'first')).toBe('String');
  });

  it('returns undefined for empty string', () => {
    expect(extractElementTypeFromString('')).toBeUndefined();
  });

  it('returns undefined when no brackets are present: User', () => {
    // No opening bracket → falls through to undefined
    expect(extractElementTypeFromString('User')).toBeUndefined();
  });

  it('returns undefined for complex non-word base before []: user model[]', () => {
    expect(extractElementTypeFromString('user model[]')).toBeUndefined();
  });
});
