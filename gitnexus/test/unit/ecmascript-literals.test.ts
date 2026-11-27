import { describe, expect, it } from 'vitest';
import {
  canonicalModuleExportName,
  decodeStringLiteral,
} from '../../src/core/ingestion/utils/ecmascript-literals.js';

describe('ECMAScript literal decoding', () => {
  it.each([
    ['`a\r\nb\rc`', 'a\nb\nc'],
    ['"a\\\r\nb"', 'ab'],
    ["'a\\\u2028b'", 'ab'],
    [String.raw`'\x61\u0062\0\z'`, 'ab\0z'],
    [String.raw`'\b\f\n\r\t\v'`, '\b\f\n\r\t\v'],
  ])('decodes %j', (source, expected) => {
    expect(decodeStringLiteral(source)).toBe(expected);
  });

  it.each([
    '',
    'word',
    '"x\n"',
    "'\\'",
    String.raw`'\07'`,
    String.raw`'\1'`,
    String.raw`'\xFG'`,
    String.raw`'\u12G0'`,
    String.raw`'\u{'`,
    String.raw`'\u{}'`,
    String.raw`'\u{g}'`,
    String.raw`'\u{110000}'`,
  ])('refuses malformed literal %j', (source) => {
    expect(decodeStringLiteral(source)).toBeNull();
  });

  it.each([
    [String.raw`"\u{1F600}"`, String.fromCodePoint(0x1f600)],
    [String.raw`'\uD83D\uDE00'`, String.fromCodePoint(0x1f600)],
    ["'\\uD800'", null],
    ["'\\uDC00'", null],
    [String.raw`f\u006F\u{6F}`, 'foo'],
  ])('reads module name %j', (source, expected) => {
    expect(canonicalModuleExportName(source)).toBe(expected);
  });
});
