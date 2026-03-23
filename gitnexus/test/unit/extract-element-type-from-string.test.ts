import { describe, it, expect } from 'vitest';
import { extractElementTypeFromString } from '../../src/core/ingestion/type-extractors/shared.js';

describe('extractElementTypeFromString', () => {
  describe('array suffix (TypeScript / Java / C#)', () => {
    it('User[] → User', () => {
      expect(extractElementTypeFromString('User[]')).toBe('User');
    });

    it('string[] → string', () => {
      expect(extractElementTypeFromString('string[]')).toBe('string');
    });

    it('int[] → int', () => {
      expect(extractElementTypeFromString('int[]')).toBe('int');
    });
  });

  describe('Go slice prefix', () => {
    it('[]User → User', () => {
      expect(extractElementTypeFromString('[]User')).toBe('User');
    });

    it('[]string → string', () => {
      expect(extractElementTypeFromString('[]string')).toBe('string');
    });
  });

  describe('Swift array sugar', () => {
    it('[User] → User', () => {
      expect(extractElementTypeFromString('[User]')).toBe('User');
    });

    it('[String] → String', () => {
      expect(extractElementTypeFromString('[String]')).toBe('String');
    });
  });

  describe('generic angle-bracket containers', () => {
    it('Array<User> → User', () => {
      expect(extractElementTypeFromString('Array<User>')).toBe('User');
    });

    it('Vec<User> → User (Rust)', () => {
      expect(extractElementTypeFromString('Vec<User>')).toBe('User');
    });

    it('vector<User> → User (C++)', () => {
      expect(extractElementTypeFromString('vector<User>')).toBe('User');
    });

    it('Set<User> → User', () => {
      expect(extractElementTypeFromString('Set<User>')).toBe('User');
    });

    it('List<User> → User', () => {
      expect(extractElementTypeFromString('List<User>')).toBe('User');
    });

    it('IEnumerable<User> → User (C#)', () => {
      expect(extractElementTypeFromString('IEnumerable<User>')).toBe('User');
    });
  });

  describe('Python subscript-style generics', () => {
    it('List[User] → User', () => {
      expect(extractElementTypeFromString('List[User]')).toBe('User');
    });

    it('Set[User] → User', () => {
      expect(extractElementTypeFromString('Set[User]')).toBe('User');
    });
  });

  describe('multi-argument generics — default returns last (value) arg', () => {
    it('Map<String, User> → User (default: last/value arg)', () => {
      expect(extractElementTypeFromString('Map<String, User>')).toBe('User');
    });

    it('Map<String, User> → String (pos=first: key arg)', () => {
      expect(extractElementTypeFromString('Map<String, User>', 'first')).toBe('String');
    });

    it('Map<String, List<User>> → undefined (last arg is nested generic)', () => {
      expect(extractElementTypeFromString('Map<String, List<User>>')).toBeUndefined();
    });

    it('Map<String, List<User>> → String (pos=first: key arg)', () => {
      expect(extractElementTypeFromString('Map<String, List<User>>', 'first')).toBe('String');
    });

    it('Dict[str, User] → User (default: last/value arg, Python)', () => {
      expect(extractElementTypeFromString('Dict[str, User]')).toBe('User');
    });

    it('Dict[str, User] → str (pos=first: key arg, Python)', () => {
      expect(extractElementTypeFromString('Dict[str, User]', 'first')).toBe('str');
    });
  });

  describe('nested generics as element type — returns undefined', () => {
    it('Array<List<User>> → undefined (element is itself generic)', () => {
      // The element "List<User>" is not a plain word, so return undefined.
      expect(extractElementTypeFromString('Array<List<User>>')).toBeUndefined();
    });

    it('Vec<Option<User>> → undefined (element is itself generic)', () => {
      expect(extractElementTypeFromString('Vec<Option<User>>')).toBeUndefined();
    });
  });

  describe('cross-bracket nesting (bracket depth fix)', () => {
    it('Dict[str, List[int]] → undefined (default: last arg is nested generic)', () => {
      expect(extractElementTypeFromString('Dict[str, List[int]]')).toBeUndefined();
    });

    it('Dict[str, List[int]] → str (pos=first: key arg)', () => {
      expect(extractElementTypeFromString('Dict[str, List[int]]', 'first')).toBe('str');
    });

    it('Map<String, List<User>> → undefined (default: last arg is nested generic)', () => {
      expect(extractElementTypeFromString('Map<String, List<User>>')).toBeUndefined();
    });

    it('Map<String, List<User>> → String (pos=first: key arg)', () => {
      expect(extractElementTypeFromString('Map<String, List<User>>', 'first')).toBe('String');
    });

    it('mismatched close bracket at depth 0 → undefined', () => {
      // openChar is '<' but first close at depth 0 is ']' — malformed
      expect(extractElementTypeFromString('Array<int]')).toBeUndefined();
    });
  });

  describe('edge cases — return undefined', () => {
    it('empty string → undefined', () => {
      expect(extractElementTypeFromString('')).toBeUndefined();
    });

    it('plain type name (no container) → undefined', () => {
      expect(extractElementTypeFromString('User')).toBeUndefined();
    });

    it('bare angle bracket with no close → undefined (malformed)', () => {
      expect(extractElementTypeFromString('Array<User')).toBeUndefined();
    });

    it('bare [] prefix with spaces only → undefined', () => {
      expect(extractElementTypeFromString('[]')).toBeUndefined();
    });

    it('empty array suffix → undefined', () => {
      expect(extractElementTypeFromString('[]')).toBeUndefined();
    });

    it('[] suffix with no base → undefined', () => {
      expect(extractElementTypeFromString('[]')).toBeUndefined();
    });

    it('empty Swift sugar [] → undefined', () => {
      // starts with '[' and ends with ']' but inner is empty
      expect(extractElementTypeFromString('[ ]')).toBeUndefined();
    });
  });
});
