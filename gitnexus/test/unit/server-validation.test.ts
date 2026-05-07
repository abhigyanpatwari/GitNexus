/**
 * Unit Tests: server validation helpers (gitnexus/src/server/validation.ts)
 *
 * Covers U1 of the security remediation plan:
 *   - assertString closes js/type-confusion-through-parameter-tampering by
 *     rejecting array-form HTTP query parameters before they reach a `.length` guard.
 *   - assertSafePath consolidates the path-traversal guard from api.ts:1067-1077
 *     for reuse across other path-injection findings.
 *   - escapeRegExp is the utility for upcoming /api/grep regex-injection fix.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  assertString,
  assertSafePath,
  escapeRegExp,
  BadRequestError,
  ForbiddenError,
} from '../../src/server/validation.js';

describe('assertString', () => {
  it('returns the value when it is a string', () => {
    expect(assertString('hello', 'name')).toBe('hello');
  });

  it('returns an empty string as-is (length validation is the caller’s job)', () => {
    expect(assertString('', 'name')).toBe('');
  });

  it('rejects an array with a message naming the field', () => {
    expect(() => assertString(['a', 'b'], 'pattern')).toThrow(BadRequestError);
    try {
      assertString(['a', 'b'], 'pattern');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).status).toBe(400);
      expect((err as Error).message).toContain('pattern');
      expect((err as Error).message).toContain('array');
    }
  });

  it('rejects undefined', () => {
    expect(() => assertString(undefined, 'name')).toThrow(BadRequestError);
  });

  it('rejects a number', () => {
    expect(() => assertString(123, 'name')).toThrow(BadRequestError);
  });

  it('rejects an object', () => {
    expect(() => assertString({ key: 'value' }, 'name')).toThrow(BadRequestError);
  });
});

describe('assertSafePath', () => {
  const root = path.resolve('/repos/x');

  it('resolves an in-repo relative path to its absolute form', () => {
    const result = assertSafePath('src/foo.ts', root);
    expect(result).toBe(path.join(root, 'src/foo.ts'));
  });

  it('accepts the root itself', () => {
    expect(assertSafePath('.', root)).toBe(root);
  });

  it('rejects a parent-directory traversal with ForbiddenError (status 403)', () => {
    expect(() => assertSafePath('../../../etc/passwd', root)).toThrow(ForbiddenError);
    try {
      assertSafePath('../../../etc/passwd', root);
    } catch (err) {
      expect((err as BadRequestError).status).toBe(403);
    }
  });

  it('rejects an absolute path that escapes the root', () => {
    expect(() => assertSafePath('/etc/passwd', root)).toThrow(ForbiddenError);
  });

  it('rejects an empty path', () => {
    expect(() => assertSafePath('', root)).toThrow(BadRequestError);
  });

  it('rejects a path containing a null byte', () => {
    expect(() => assertSafePath('foo\0bar', root)).toThrow(BadRequestError);
  });

  it('does not confuse "src/.." with "../" (must not escape root)', () => {
    // src/.. resolves back to root, which is allowed.
    expect(assertSafePath('src/..', root)).toBe(root);
  });
});

describe('escapeRegExp', () => {
  it('escapes the dot metacharacter', () => {
    expect(escapeRegExp('a.b')).toBe('a\\.b');
  });

  it('escapes all common regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o',
    );
  });

  it('passes through a string with no metacharacters', () => {
    expect(escapeRegExp('plain text')).toBe('plain text');
  });

  it('handles an empty string', () => {
    expect(escapeRegExp('')).toBe('');
  });

  it('produces a literal-matching regex when fed back to new RegExp', () => {
    const userInput = 'a.b*c';
    const re = new RegExp(escapeRegExp(userInput));
    expect(re.test('a.b*c')).toBe(true);
    expect(re.test('axbxc')).toBe(false); // confirms the . was treated as literal
  });
});
