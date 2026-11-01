import { describe, expect, it } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { interpretRImport } from '../../src/core/ingestion/languages/r/interpret.js';

// `@import.source` holds the argument's text verbatim, quotes included, so an empty
// string literal is `""` (length 2), not a zero-length capture.

const range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
const capture = (name: string, text: string): Capture => ({ name, range, text });
const match = (source: string, wildcard = false): CaptureMatch => ({
  '@import.source': capture('@import.source', source),
  ...(wildcard ? { '@import.wildcard': capture('@import.wildcard', 'library') } : {}),
});

describe('interpretRImport', () => {
  it.each([['""'], ["''"]])('rejects the empty string literal %s', (literal) => {
    expect(interpretRImport(match(literal))).toBeNull();
    expect(interpretRImport(match(literal, true))).toBeNull();
  });

  it('rejects a capture with no source', () => {
    expect(interpretRImport({})).toBeNull();
  });

  it('keeps the quotes in targetRaw for a non-empty source', () => {
    expect(interpretRImport(match('"util.R"'))).toEqual({
      kind: 'side-effect',
      targetRaw: '"util.R"',
    });
    expect(interpretRImport(match('"pkg"', true))).toEqual({
      kind: 'wildcard',
      targetRaw: '"pkg"',
    });
  });

  it('accepts an unquoted source such as library(pkg)', () => {
    expect(interpretRImport(match('pkg', true))).toEqual({ kind: 'wildcard', targetRaw: 'pkg' });
  });
});
