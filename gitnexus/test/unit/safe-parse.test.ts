import { describe, it, expect, afterEach } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { parseSourceSafe, ParseTimeoutError } from '../../src/core/tree-sitter/safe-parse.js';

const makeParser = (): Parser => {
  const p = new Parser();
  p.setLanguage(Python);
  return p;
};

const buildSource = (chars: number, lineLen = 80): string => {
  const line = 'x = 1' + ' '.repeat(Math.max(0, lineLen - 6)) + '\n';
  const lines = Math.ceil(chars / line.length);
  return line.repeat(lines).slice(0, chars);
};

describe('parseSourceSafe', () => {
  it('parses small ASCII sources via the direct path', () => {
    const tree = parseSourceSafe(makeParser(), 'x = 1\n');
    expect(tree.rootNode.type).toBe('module');
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('parses sources at the direct/callback boundary (16 KiB)', () => {
    const src = buildSource(16 * 1024);
    const tree = parseSourceSafe(makeParser(), src);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(src.length);
  });

  it('parses sources just above the boundary via the callback path', () => {
    const src = buildSource(16 * 1024 + 1);
    const tree = parseSourceSafe(makeParser(), src);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(src.length);
  });

  it('parses sources at and around the 32 767-char Windows crash boundary', () => {
    for (const len of [32_766, 32_767, 32_768]) {
      const src = buildSource(len);
      const tree = parseSourceSafe(makeParser(), src);
      expect(tree.rootNode.hasError, `len=${len}`).toBe(false);
      expect(tree.rootNode.endIndex, `len=${len}`).toBe(src.length);
    }
  });

  it('parses a single line longer than the chunk size (no newlines)', () => {
    const src = '"' + 'a'.repeat(20_000) + '"\n';
    const tree = parseSourceSafe(makeParser(), src);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(src.length);
  });

  it('parses sources with CRLF line endings near a chunk boundary', () => {
    const line = 'x = 1' + ' '.repeat(75) + '\r\n';
    const src = line.repeat(Math.ceil(20_000 / line.length));
    const tree = parseSourceSafe(makeParser(), src);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(src.length);
  });

  it('parses a large all-non-ASCII source identically to the direct path', () => {
    const small = '# ' + '漢'.repeat(50) + '\n';
    const direct = makeParser().parse(small);
    const safe = parseSourceSafe(makeParser(), small);
    expect(safe.rootNode.toString()).toBe(direct.rootNode.toString());

    const large = ('# ' + '漢'.repeat(8_000) + '\n').repeat(3);
    const tree = parseSourceSafe(makeParser(), large);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(large.length);
  });

  describe('GITNEXUS_PARSE_TIMEOUT_MICROS opt-in', () => {
    const ORIGINAL = process.env.GITNEXUS_PARSE_TIMEOUT_MICROS;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.GITNEXUS_PARSE_TIMEOUT_MICROS;
      else process.env.GITNEXUS_PARSE_TIMEOUT_MICROS = ORIGINAL;
    });

    it('is a no-op when the env var is unset (backward compatible)', () => {
      delete process.env.GITNEXUS_PARSE_TIMEOUT_MICROS;
      const tree = parseSourceSafe(makeParser(), 'x = 1\n');
      expect(tree.rootNode.hasError).toBe(false);
    });

    it('throws ParseTimeoutError when parsing exceeds the configured timeout', () => {
      // 1 microsecond is below any real parse latency — tree-sitter aborts
      // immediately and returns null, which the wrapper converts to a throw.
      process.env.GITNEXUS_PARSE_TIMEOUT_MICROS = '1';
      const src = buildSource(64 * 1024);
      expect(() => parseSourceSafe(makeParser(), src)).toThrowError(ParseTimeoutError);
    });

    it('resets the parser timeout after each call so reuse is unaffected', () => {
      const parser = makeParser();
      process.env.GITNEXUS_PARSE_TIMEOUT_MICROS = '1';
      expect(() => parseSourceSafe(parser, buildSource(64 * 1024))).toThrow();
      delete process.env.GITNEXUS_PARSE_TIMEOUT_MICROS;
      const tree = parseSourceSafe(parser, 'x = 1\n');
      expect(tree.rootNode.hasError).toBe(false);
    });
  });
});
