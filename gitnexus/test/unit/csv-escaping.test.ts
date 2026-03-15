/**
 * P0 Unit Tests: CSV Escaping Functions
 *
 * Tests: escapeCSVField, escapeCSVNumber, sanitizeUTF8, isBinaryContent
 * Covers hardening fix #23 (keyword arrays with backslashes and commas)
 */
import { describe, it, expect } from 'vitest';
import {
  escapeCSVField,
  escapeCSVNumber,
  sanitizeUTF8,
  isBinaryContent,
} from '../../src/core/lbug/csv-generator.js';

// ─── escapeCSVField ──────────────────────────────────────────────────

describe('escapeCSVField', () => {
  it('returns empty quoted string for null', () => {
    expect(escapeCSVField(null)).toBe('""');
  });

  it('returns empty quoted string for undefined', () => {
    expect(escapeCSVField(undefined)).toBe('""');
  });

  it('returns quoted empty string for empty input', () => {
    expect(escapeCSVField('')).toBe('""');
  });

  it('wraps simple string in quotes', () => {
    expect(escapeCSVField('hello')).toBe('"hello"');
  });

  it('doubles internal double quotes', () => {
    expect(escapeCSVField('say "hello"')).toBe('"say ""hello"""');
  });

  it('handles strings with commas', () => {
    expect(escapeCSVField('a,b,c')).toBe('"a,b,c"');
  });

  it('handles strings with newlines', () => {
    expect(escapeCSVField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('converts numbers to quoted strings', () => {
    expect(escapeCSVField(42)).toBe('"42"');
  });

  it('handles strings with both quotes and commas', () => {
    expect(escapeCSVField('"hello",world')).toBe('"""hello"",world"');
  });

  // Hardening fix #23: keyword arrays with backslashes
  it('handles strings with backslashes', () => {
    const result = escapeCSVField('path\\to\\file');
    expect(result).toBe('"path\\to\\file"');
  });

  it('handles code content with special characters', () => {
    const code = 'function foo() {\n  return "bar";\n}';
    const result = escapeCSVField(code);
    expect(result).toContain('function foo()');
    expect(result).toContain('""bar""');
  });
});

// ─── escapeCSVNumber ─────────────────────────────────────────────────

describe('escapeCSVNumber', () => {
  it('returns default value for null', () => {
    expect(escapeCSVNumber(null)).toBe('-1');
  });

  it('returns default value for undefined', () => {
    expect(escapeCSVNumber(undefined)).toBe('-1');
  });

  it('returns custom default value', () => {
    expect(escapeCSVNumber(null, 0)).toBe('0');
  });

  it('returns string representation of number', () => {
    expect(escapeCSVNumber(42)).toBe('42');
  });

  it('handles zero', () => {
    expect(escapeCSVNumber(0)).toBe('0');
  });

  it('handles negative numbers', () => {
    expect(escapeCSVNumber(-5)).toBe('-5');
  });

  it('handles floating point', () => {
    expect(escapeCSVNumber(3.14)).toBe('3.14');
  });
});

// ─── sanitizeUTF8 ────────────────────────────────────────────────────

describe('sanitizeUTF8', () => {
  it('passes through clean strings unchanged', () => {
    expect(sanitizeUTF8('hello world')).toBe('hello world');
  });

  it('normalizes CRLF to LF', () => {
    expect(sanitizeUTF8('line1\r\nline2')).toBe('line1\nline2');
  });

  it('normalizes lone CR to LF', () => {
    expect(sanitizeUTF8('line1\rline2')).toBe('line1\nline2');
  });

  it('strips null bytes', () => {
    expect(sanitizeUTF8('hello\x00world')).toBe('helloworld');
  });

  it('strips control characters', () => {
    expect(sanitizeUTF8('hello\x01\x02\x03world')).toBe('helloworld');
  });

  it('preserves tabs', () => {
    expect(sanitizeUTF8('hello\tworld')).toBe('hello\tworld');
  });

  it('preserves newlines', () => {
    expect(sanitizeUTF8('hello\nworld')).toBe('hello\nworld');
  });

  it('strips lone surrogates', () => {
    expect(sanitizeUTF8('hello\uD800world')).toBe('helloworld');
  });

  it('strips BOM-like characters (FFFE/FFFF)', () => {
    expect(sanitizeUTF8('hello\uFFFEworld')).toBe('helloworld');
  });
});

// ─── isBinaryContent ─────────────────────────────────────────────────

describe('isBinaryContent', () => {
  it('returns false for empty string', () => {
    expect(isBinaryContent('')).toBe(false);
  });

  it('returns false for normal text', () => {
    expect(isBinaryContent('hello world\nline two')).toBe(false);
  });

  it('returns false for code content', () => {
    const code = 'function foo() {\n  return 42;\n}\n';
    expect(isBinaryContent(code)).toBe(false);
  });

  it('returns true when >10% non-printable characters', () => {
    // Create a string that's ~20% null bytes
    const binary = 'a'.repeat(80) + '\x00'.repeat(20);
    expect(isBinaryContent(binary)).toBe(true);
  });

  it('returns false when just under 10% threshold', () => {
    // 9% non-printable should not be binary
    const borderline = 'a'.repeat(91) + '\x01'.repeat(9);
    expect(isBinaryContent(borderline)).toBe(false);
  });

  it('only samples first 1000 characters', () => {
    // Binary content past 1000 chars should be ignored
    const text = 'a'.repeat(1000) + '\x00'.repeat(500);
    expect(isBinaryContent(text)).toBe(false);
  });
});
