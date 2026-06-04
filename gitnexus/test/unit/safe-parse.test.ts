import { describe, it, expect, afterEach, vi } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

// Mock the logger so the throttled degraded-parse logs (emitted at `debug`,
// which the default capture destination filters out) are observable as plain
// spy calls. Each level is a vi.fn() we can count.
const debugSpy = vi.fn();
const warnSpy = vi.fn();
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: (...args: unknown[]) => debugSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    info: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

import {
  parseSourceSafe,
  parseHadErrors,
  getParseDiagnostics,
  ParseTimeoutError,
  resetDegradedParseCounter,
  _resetDegradedParseCounter,
} from '../../src/core/tree-sitter/safe-parse.js';

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
});

describe('parseSourceSafe — runaway-parse timeout (#1922)', () => {
  const ORIGINAL_BUDGET = process.env.GITNEXUS_PARSE_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.GITNEXUS_PARSE_TIMEOUT_MS;
    } else {
      process.env.GITNEXUS_PARSE_TIMEOUT_MS = ORIGINAL_BUDGET;
    }
  });

  // A large source paired with a sub-millisecond budget reliably trips the
  // tree-sitter timeout (it returns null mid-parse). 1ms · 1000 = 1000 micros.
  const pathological = (): string => buildSource(4 * 1024 * 1024);

  it('throws ParseTimeoutError when the parse exceeds its budget', () => {
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    const parser = makeParser();
    expect(() => parseSourceSafe(parser, pathological())).toThrow(ParseTimeoutError);
  });

  it('reset()s the parser on timeout so the SAME parser parses cleanly next', () => {
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '1';
    const parser = makeParser();
    expect(() => parseSourceSafe(parser, pathological())).toThrow(ParseTimeoutError);

    // Without reset() tree-sitter resumes the interrupted parse and would
    // either return null again or a corrupt tree. With a cleared budget +
    // reset(), a trivial follow-up parse on the SAME parser must succeed.
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '0';
    const tree = parseSourceSafe(parser, 'x = 1\n');
    expect(tree.rootNode.type).toBe('module');
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('does not throw and returns a tree when the budget is disabled (0)', () => {
    process.env.GITNEXUS_PARSE_TIMEOUT_MS = '0';
    const tree = parseSourceSafe(makeParser(), 'x = 1\n');
    expect(tree.rootNode.type).toBe('module');
  });
});

describe('parseSourceSafe — intrinsic error detection (#1922)', () => {
  afterEach(() => {
    _resetDegradedParseCounter();
  });

  it('returns the (degraded) tree for malformed input — never drops it', () => {
    // Unbalanced parens / dangling def → tree-sitter recovers into ERROR nodes
    // rather than throwing or returning null.
    const malformed = 'def broken(:\n    return (1 + \n';
    const tree = parseSourceSafe(makeParser(), malformed, undefined, undefined, 'broken.py');
    expect(tree).toBeDefined();
    expect(tree.rootNode.hasError).toBe(true);
    expect(parseHadErrors(tree)).toBe(true);
  });

  it('reports parseHadErrors=false for clean input', () => {
    const tree = parseSourceSafe(makeParser(), 'def ok():\n    return 1\n');
    expect(parseHadErrors(tree)).toBe(false);
  });
});

describe('parseSourceSafe — non-timeout errors propagate unchanged', () => {
  it('rethrows a non-ParseTimeoutError thrown by the underlying parser', () => {
    const boom = new Error('stub parser exploded');
    const stub = {
      // parseSourceSafe takes the direct-string path for short inputs and
      // calls parser.parse(...) — make that throw a plain Error.
      setTimeoutMicros: () => {},
      reset: () => {},
      parse: () => {
        throw boom;
      },
    } as unknown as Parser;

    expect(() => parseSourceSafe(stub, 'x = 1\n')).toThrow(boom);
    try {
      parseSourceSafe(stub, 'x = 1\n');
    } catch (err) {
      expect(err).toBe(boom);
      expect(err).not.toBeInstanceOf(ParseTimeoutError);
    }
  });
});

describe('parseSourceSafe — degraded-parse log throttle', () => {
  afterEach(() => {
    _resetDegradedParseCounter();
    debugSpy.mockClear();
    warnSpy.mockClear();
  });

  const malformed = 'def broken(:\n    return (1 + \n';

  it('logs the first 20 degraded parses then suppresses; reset restores logging', () => {
    _resetDegradedParseCounter();
    debugSpy.mockClear();

    const parser = makeParser();
    for (let i = 0; i < 25; i++) {
      const tree = parseSourceSafe(parser, malformed, undefined, undefined, `broken-${i}.py`);
      expect(parseHadErrors(tree)).toBe(true);
    }
    // First 20 logged, remaining 5 suppressed.
    expect(debugSpy).toHaveBeenCalledTimes(20);

    // resetDegradedParseCounter() rewinds the budget so logging resumes.
    resetDegradedParseCounter();
    debugSpy.mockClear();
    parseSourceSafe(parser, malformed, undefined, undefined, 'broken-after-reset.py');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('_resetDegradedParseCounter delegates to resetDegradedParseCounter', () => {
    _resetDegradedParseCounter();
    debugSpy.mockClear();
    const parser = makeParser();
    for (let i = 0; i < 21; i++) {
      parseSourceSafe(parser, malformed, undefined, undefined, `b-${i}.py`);
    }
    expect(debugSpy).toHaveBeenCalledTimes(20);
    _resetDegradedParseCounter();
    debugSpy.mockClear();
    parseSourceSafe(parser, malformed, undefined, undefined, 'b-reset.py');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });
});

describe('parseHadErrors / getParseDiagnostics — null-root safety', () => {
  it('treats a missing rootNode as "no errors" rather than throwing', () => {
    const noRoot = { rootNode: null } as unknown as Parser.Tree;
    expect(() => parseHadErrors(noRoot)).not.toThrow();
    expect(parseHadErrors(noRoot)).toBe(false);
    expect(getParseDiagnostics(noRoot)).toEqual({ hasError: false, isMissing: false });
  });

  it('still reads a present rootNode normally', () => {
    const tree = parseSourceSafe(makeParser(), 'x = 1\n');
    expect(getParseDiagnostics(tree)).toEqual({ hasError: false, isMissing: false });
  });
});
