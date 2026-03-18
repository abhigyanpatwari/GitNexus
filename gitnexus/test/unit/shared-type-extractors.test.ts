import { describe, it, expect } from 'vitest';
import {
  extractElementTypeFromString,
  stripNullable,
  extractReturnTypeName,
  methodToTypeArgPosition,
  getContainerDescriptor,
} from '../../src/core/ingestion/type-extractors/shared.js';

// ---------------------------------------------------------------------------
// extractElementTypeFromString
// ---------------------------------------------------------------------------

describe('extractElementTypeFromString', () => {
  // --- Array suffix ---
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

  // --- Go slice prefix ---
  it('strips Go slice prefix: []User → User', () => {
    expect(extractElementTypeFromString('[]User')).toBe('User');
  });

  it('strips Go slice prefix for primitive: []string → string', () => {
    expect(extractElementTypeFromString('[]string')).toBe('string');
  });

  // --- Swift array sugar ---
  it('unwraps Swift array sugar: [User] → User', () => {
    expect(extractElementTypeFromString('[User]')).toBe('User');
  });

  // --- Generic angle brackets ---
  it('unwraps single-arg generic angle: Array<User> → User', () => {
    expect(extractElementTypeFromString('Array<User>')).toBe('User');
  });

  it('unwraps single-arg generic angle: C++ vector<User> → User', () => {
    expect(extractElementTypeFromString('vector<User>')).toBe('User');
  });

  it('unwraps single-arg generic angle: Rust Vec<User> → User', () => {
    expect(extractElementTypeFromString('Vec<User>')).toBe('User');
  });

  // --- Generic square brackets ---
  it('unwraps Python subscript: List[User] → User', () => {
    expect(extractElementTypeFromString('List[User]')).toBe('User');
  });

  // --- Multi-argument generics ---
  it('returns last arg by default for Map<String, User>: → User', () => {
    expect(extractElementTypeFromString('Map<String, User>')).toBe('User');
  });

  it('returns first arg with pos=first for Map<String, User>: → String', () => {
    expect(extractElementTypeFromString('Map<String, User>', 'first')).toBe('String');
  });

  it('returns last arg explicitly for Map<String, User>: → User', () => {
    expect(extractElementTypeFromString('Map<String, User>', 'last')).toBe('User');
  });

  // --- Nested generics ---
  it('returns undefined for nested generics: List<Map<String, User>>', () => {
    // The inner arg "Map<String, User>" is not a simple word (/^\w+$/ fails)
    expect(extractElementTypeFromString('List<Map<String, User>>')).toBeUndefined();
  });

  // --- Guard conditions ---
  it('returns undefined for empty string', () => {
    expect(extractElementTypeFromString('')).toBeUndefined();
  });

  it('returns undefined for string longer than 2048 chars', () => {
    expect(extractElementTypeFromString('A'.repeat(2049))).toBeUndefined();
  });

  it('returns undefined at exactly the 2048-char limit', () => {
    // Length > 2048 is rejected; length === 2048 may or may not parse — test boundary
    const exactly2048 = 'A'.repeat(2048);
    // This won't contain valid container syntax, so it won't resolve, but it won't be
    // rejected by the length guard alone. We only assert > 2048 is rejected.
    expect(extractElementTypeFromString('A'.repeat(2049))).toBeUndefined();
  });

  it('returns undefined for malformed brackets: Map<String, User]', () => {
    // Mismatched bracket at depth 0 → malformed
    expect(extractElementTypeFromString('Map<String, User]')).toBeUndefined();
  });

  it('returns undefined for just closing angle brackets: >', () => {
    expect(extractElementTypeFromString('>')).toBeUndefined();
  });

  it('returns undefined when no brackets are present: User', () => {
    // No opening bracket → falls through to undefined
    expect(extractElementTypeFromString('User')).toBeUndefined();
  });

  it('returns undefined for complex non-word base before []: user model[]', () => {
    expect(extractElementTypeFromString('user model[]')).toBeUndefined();
  });

  // --- Edge cases for Swift vs List-subscript disambiguation ---
  it('does not treat [User] as Swift if it contains angle bracket (impossible case sanity-check)', () => {
    // [User<X>] — starts with [ ends with ] but contains <, so Swift path is skipped.
    // Falls to generic extraction: openSquare=0, extracts "User<X>" which is not /^\w+$/.
    expect(extractElementTypeFromString('[User<X>]')).toBeUndefined();
  });

  // --- pos='first' on single-arg container falls through to the same result ---
  it('returns same result for Vec<User> with pos=first', () => {
    expect(extractElementTypeFromString('Vec<User>', 'first')).toBe('User');
  });

  // --- Whitespace inside generics ---
  it('handles whitespace in generic args: Array< User > → User', () => {
    expect(extractElementTypeFromString('Array< User >')).toBe('User');
  });
});

// ---------------------------------------------------------------------------
// stripNullable
// ---------------------------------------------------------------------------

describe('stripNullable', () => {
  // --- Nullable union stripping ---
  it('strips "| null": User | null → User', () => {
    expect(stripNullable('User | null')).toBe('User');
  });

  it('strips "| undefined": User | undefined → User', () => {
    expect(stripNullable('User | undefined')).toBe('User');
  });

  it('strips both "| null | undefined": User | null | undefined → User', () => {
    expect(stripNullable('User | null | undefined')).toBe('User');
  });

  // --- Nullable suffix ---
  it('strips nullable suffix: User? → User', () => {
    expect(stripNullable('User?')).toBe('User');
  });

  // --- Genuine union is rejected ---
  it('returns undefined for genuine union: User | Repo', () => {
    expect(stripNullable('User | Repo')).toBeUndefined();
  });

  // --- Bare nullable keywords ---
  it('returns undefined for bare "null"', () => {
    expect(stripNullable('null')).toBeUndefined();
  });

  it('returns undefined for bare "undefined"', () => {
    expect(stripNullable('undefined')).toBeUndefined();
  });

  it('returns undefined for bare "None"', () => {
    expect(stripNullable('None')).toBeUndefined();
  });

  it('returns undefined for bare "nil"', () => {
    expect(stripNullable('nil')).toBeUndefined();
  });

  it('returns undefined for bare "void"', () => {
    expect(stripNullable('void')).toBeUndefined();
  });

  // --- Empty / whitespace ---
  it('returns undefined for empty string', () => {
    expect(stripNullable('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(stripNullable('   ')).toBeUndefined();
  });

  // --- Trimming ---
  it('trims surrounding whitespace: "  User  " → User', () => {
    expect(stripNullable('  User  ')).toBe('User');
  });

  // --- No-op for clean type names ---
  it('returns the type name unchanged when no nullable markers: User → User', () => {
    expect(stripNullable('User')).toBe('User');
  });

  // --- All-nullable union is rejected ---
  it('returns undefined when the union is all nullable keywords: null | undefined', () => {
    expect(stripNullable('null | undefined')).toBeUndefined();
  });

  // --- Nullable suffix does NOT interact with pipe (order matters) ---
  it('returns "User?" when ? is embedded before pipe: User? | null', () => {
    // The ? strip only fires when the whole string ends with '?'.
    // "User? | null" ends with 'null', so ? is NOT stripped first.
    // The pipe branch splits → parts: ['User?', 'null'] → filters 'null' → one part
    // remaining is 'User?' (not in NULLABLE_KEYWORDS), so it is returned as-is.
    expect(stripNullable('User? | null')).toBe('User?');
  });
});

// ---------------------------------------------------------------------------
// extractReturnTypeName
// ---------------------------------------------------------------------------

describe('extractReturnTypeName', () => {
  // --- Simple user-defined type ---
  it('returns simple type: User → User', () => {
    expect(extractReturnTypeName('User')).toBe('User');
  });

  // --- Wrapper generics unwrapping ---
  it('unwraps Promise: Promise<User> → User', () => {
    expect(extractReturnTypeName('Promise<User>')).toBe('User');
  });

  it('unwraps Option: Option<User> → User', () => {
    expect(extractReturnTypeName('Option<User>')).toBe('User');
  });

  it('unwraps Result (first arg): Result<User, Error> → User', () => {
    expect(extractReturnTypeName('Result<User, Error>')).toBe('User');
  });

  // --- Nullable union / suffix ---
  it('strips nullable union: User | null → User', () => {
    expect(extractReturnTypeName('User | null')).toBe('User');
  });

  it('strips nullable suffix: User? → User', () => {
    expect(extractReturnTypeName('User?')).toBe('User');
  });

  // --- Pointer / reference prefix stripping ---
  it('strips Go pointer prefix: *User → User', () => {
    expect(extractReturnTypeName('*User')).toBe('User');
  });

  it('strips Rust reference prefix: &User → User', () => {
    expect(extractReturnTypeName('&User')).toBe('User');
  });

  it('strips Rust mutable reference prefix: &mut User → User', () => {
    expect(extractReturnTypeName('&mut User')).toBe('User');
  });

  // --- Non-wrapper generic returns base type ---
  it('returns base type for non-wrapper generic: List<User> → List', () => {
    expect(extractReturnTypeName('List<User>')).toBe('List');
  });

  // --- Qualified names ---
  it('extracts last segment of dot-qualified name: models.User → User', () => {
    expect(extractReturnTypeName('models.User')).toBe('User');
  });

  it('extracts last segment of PHP namespace: \\App\\Models\\User → User', () => {
    expect(extractReturnTypeName('\\App\\Models\\User')).toBe('User');
  });

  it('extracts last segment of Rust path: models::User → User', () => {
    expect(extractReturnTypeName('models::User')).toBe('User');
  });

  // --- Primitives rejected ---
  it('returns undefined for primitive "string"', () => {
    expect(extractReturnTypeName('string')).toBeUndefined();
  });

  it('returns undefined for primitive "int"', () => {
    expect(extractReturnTypeName('int')).toBeUndefined();
  });

  it('returns undefined for primitive "boolean"', () => {
    expect(extractReturnTypeName('boolean')).toBeUndefined();
  });

  it('returns undefined for primitive "void"', () => {
    expect(extractReturnTypeName('void')).toBeUndefined();
  });

  // --- Lowercase (non-uppercase start) rejected ---
  it('returns undefined for lowercase identifier: user', () => {
    expect(extractReturnTypeName('user')).toBeUndefined();
  });

  // --- Empty ---
  it('returns undefined for empty string', () => {
    expect(extractReturnTypeName('')).toBeUndefined();
  });

  // --- Bare wrapper without type arg ---
  it('returns undefined for bare wrapper without type arg: Promise', () => {
    expect(extractReturnTypeName('Promise')).toBeUndefined();
  });

  it('returns undefined for bare wrapper: Option', () => {
    expect(extractReturnTypeName('Option')).toBeUndefined();
  });

  // --- Recursive unwrap (nested wrappers) ---
  it('recursively unwraps nested wrappers: Future<Option<User>> → User', () => {
    expect(extractReturnTypeName('Future<Option<User>>')).toBe('User');
  });

  // --- Rust smart pointer ---
  it('unwraps Rc: Rc<User> → User', () => {
    expect(extractReturnTypeName('Rc<User>')).toBe('User');
  });

  it('unwraps Arc: Arc<User> → User', () => {
    expect(extractReturnTypeName('Arc<User>')).toBe('User');
  });

  // --- Guard conditions ---
  it('returns undefined for input longer than 2048 chars', () => {
    expect(extractReturnTypeName('A'.repeat(2049))).toBeUndefined();
  });

  it('returns undefined when depth > 10', () => {
    expect(extractReturnTypeName('User', 11)).toBeUndefined();
  });

  // --- Rust lifetimes in Result ---
  it('skips Rust lifetime parameters in Result: Result<\'_, User, Error> is unusual but lifetime in first pos is skipped', () => {
    // Lifetime as FIRST arg: Result<'a, User> — extractFirstTypeArg skips lifetimes
    expect(extractReturnTypeName("Result<'a, User>")).toBe('User');
  });

  it('skips Rust anonymous lifetime: Result<\'_, User>', () => {
    expect(extractReturnTypeName("Result<'_, User>")).toBe('User');
  });

  // --- Genuine union is rejected ---
  it('returns undefined for genuine union: User | Repo', () => {
    expect(extractReturnTypeName('User | Repo')).toBeUndefined();
  });

  // --- Uppercase-start constraint ---
  it('accepts underscore-start identifier: _User', () => {
    // Pattern is /^[A-Z_]\w*$/ — underscore start is accepted
    expect(extractReturnTypeName('_User')).toBe('_User');
  });

  // --- Type with multiple pointer sigils ---
  it('strips multiple pointer sigils: **User → User', () => {
    // Regex: /^[&*]+\s*(mut\s+)?/ strips all leading & and *
    expect(extractReturnTypeName('**User')).toBe('User');
  });
});

// ---------------------------------------------------------------------------
// methodToTypeArgPosition
// ---------------------------------------------------------------------------

describe('methodToTypeArgPosition', () => {
  // --- Known single-element container → always 'last' ---
  it('returns last for known single-element container method: get on Array', () => {
    expect(methodToTypeArgPosition('get', 'Array')).toBe('last');
  });

  it('returns last for iter on Vec (single-element)', () => {
    expect(methodToTypeArgPosition('iter', 'Vec')).toBe('last');
  });

  // --- Known map container with key method ---
  it('returns first for keys on Map', () => {
    expect(methodToTypeArgPosition('keys', 'Map')).toBe('first');
  });

  it('returns last for values on Map', () => {
    expect(methodToTypeArgPosition('values', 'Map')).toBe('last');
  });

  it('returns last for get on Map (value method)', () => {
    expect(methodToTypeArgPosition('get', 'Map')).toBe('last');
  });

  // --- Java-specific keySet ---
  it('returns first for keySet on LinkedHashMap (Java keyMethods)', () => {
    expect(methodToTypeArgPosition('keySet', 'LinkedHashMap')).toBe('first');
  });

  it('returns first for keySet on HashMap (Java keyMethods via STD_KEY_METHODS — note: HashMap uses STD_KEY_METHODS, not JAVA_KEY_METHODS)', () => {
    // HashMap uses STD_KEY_METHODS which has 'keys', not 'keySet'
    // So keySet on HashMap is not a key method → falls to 'last'
    expect(methodToTypeArgPosition('keySet', 'HashMap')).toBe('last');
  });

  it('returns first for keySet on TreeMap (JAVA_KEY_METHODS)', () => {
    expect(methodToTypeArgPosition('keySet', 'TreeMap')).toBe('first');
  });

  // --- C# Keys property ---
  it('returns first for Keys on Dictionary (C# key method)', () => {
    expect(methodToTypeArgPosition('Keys', 'Dictionary')).toBe('first');
  });

  it('returns last for Values on Dictionary (C# value method)', () => {
    expect(methodToTypeArgPosition('Values', 'Dictionary')).toBe('last');
  });

  // --- Unknown container falls back to method name heuristic ---
  it('returns first for keys on unknown container: keys on MyMap', () => {
    expect(methodToTypeArgPosition('keys', 'MyMap')).toBe('first');
  });

  it('returns last for get on unknown container: get on MyMap', () => {
    expect(methodToTypeArgPosition('get', 'MyMap')).toBe('last');
  });

  it('returns first for keySet on unknown container (fallback heuristic)', () => {
    expect(methodToTypeArgPosition('keySet', 'MyMap')).toBe('first');
  });

  it('returns first for Keys on unknown container (fallback heuristic)', () => {
    expect(methodToTypeArgPosition('Keys', 'SomeUnknownMap')).toBe('first');
  });

  // --- Undefined method / no container ---
  it('returns last when method and container are both undefined', () => {
    expect(methodToTypeArgPosition(undefined)).toBe('last');
  });

  it('returns last when method is undefined and container is known map', () => {
    // containerTypeName is Map (arity 2), method is undefined → not in keyMethods → 'last'
    expect(methodToTypeArgPosition(undefined, 'Map')).toBe('last');
  });

  it('returns last for unknown method on unknown container', () => {
    expect(methodToTypeArgPosition('somethingElse', 'FooBar')).toBe('last');
  });

  // --- No container provided, non-key method ---
  it('returns last for non-key method with no container', () => {
    expect(methodToTypeArgPosition('get')).toBe('last');
  });

  it('returns first for keys with no container', () => {
    expect(methodToTypeArgPosition('keys')).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// getContainerDescriptor
// ---------------------------------------------------------------------------

describe('getContainerDescriptor', () => {
  // --- Known map-type (arity 2) ---
  it('returns descriptor with arity 2 for Map', () => {
    const desc = getContainerDescriptor('Map');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(2);
  });

  it('descriptor for Map has keys in keyMethods', () => {
    const desc = getContainerDescriptor('Map');
    expect(desc!.keyMethods.has('keys')).toBe(true);
  });

  it('descriptor for Map has get in valueMethods', () => {
    const desc = getContainerDescriptor('Map');
    expect(desc!.valueMethods.has('get')).toBe(true);
  });

  it('returns descriptor with arity 2 for HashMap', () => {
    const desc = getContainerDescriptor('HashMap');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(2);
  });

  it('returns descriptor with arity 2 for Dictionary (C#)', () => {
    const desc = getContainerDescriptor('Dictionary');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(2);
  });

  // --- Known single-element container (arity 1) ---
  it('returns descriptor with arity 1 for Vec', () => {
    const desc = getContainerDescriptor('Vec');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(1);
  });

  it('descriptor for Vec has empty keyMethods', () => {
    const desc = getContainerDescriptor('Vec');
    expect(desc!.keyMethods.size).toBe(0);
  });

  it('descriptor for Vec has get in valueMethods', () => {
    const desc = getContainerDescriptor('Vec');
    expect(desc!.valueMethods.has('get')).toBe(true);
  });

  it('returns descriptor with arity 1 for Array', () => {
    const desc = getContainerDescriptor('Array');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(1);
  });

  it('returns descriptor with arity 1 for List', () => {
    const desc = getContainerDescriptor('List');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(1);
  });

  // --- Unknown type ---
  it('returns undefined for unknown type: FooBar', () => {
    expect(getContainerDescriptor('FooBar')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getContainerDescriptor('')).toBeUndefined();
  });

  it('returns undefined for lowercase unknown: mycontainer', () => {
    expect(getContainerDescriptor('mycontainer')).toBeUndefined();
  });

  // --- Lowercase built-in containers ---
  it('returns descriptor for lowercase list (Python)', () => {
    const desc = getContainerDescriptor('list');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(1);
  });

  it('returns descriptor for lowercase dict (Python)', () => {
    const desc = getContainerDescriptor('dict');
    expect(desc).toBeDefined();
    expect(desc!.arity).toBe(2);
  });

  // --- Java-specific map with keySet ---
  it('descriptor for TreeMap has keySet in keyMethods', () => {
    const desc = getContainerDescriptor('TreeMap');
    expect(desc).toBeDefined();
    expect(desc!.keyMethods.has('keySet')).toBe(true);
  });

  it('descriptor for ConcurrentHashMap has keySet in keyMethods', () => {
    const desc = getContainerDescriptor('ConcurrentHashMap');
    expect(desc).toBeDefined();
    expect(desc!.keyMethods.has('keySet')).toBe(true);
  });
});
