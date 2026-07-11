import { describe, it, expect, afterEach, vi } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
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

const makeJavaParser = (): Parser => {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser;
};

const buildNullByteJavaSource = (paddingChars = 0): string => `public interface Demo {
  void before();
  /**${'x'.repeat(paddingChars)} @example paramsMap={"dataStyle":"\0"} */
  String batchGetStructure(java.util.Map<String, Object> paramsMap);
  void after0();
  void after1();
  void after2();
}
`;

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

describe('parseSourceSafe — embedded NUL recovery (#2426)', () => {
  afterEach(() => {
    debugSpy.mockClear();
    warnSpy.mockClear();
    resetDegradedParseCounter();
  });

  it.each([
    ['direct string', 0],
    ['callback', 17_000],
  ])('recovers all Java methods through the %s path', (_path, paddingChars) => {
    const source = buildNullByteJavaSource(paddingChars);
    const tree = parseSourceSafe(
      makeJavaParser(),
      source,
      undefined,
      undefined,
      'NullByteDemoService.java',
    );
    const methods = tree.rootNode.descendantsOfType('method_declaration');

    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(source.length);
    expect(methods.map((method) => method.childForFieldName('name')?.text)).toEqual([
      'before',
      'batchGetStructure',
      'after0',
      'after1',
      'after2',
    ]);
    expect(methods[2]?.childForFieldName('name')?.startIndex).toBe(source.indexOf('after0'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['direct string', 'short\0source'],
    ['callback', `${'x'.repeat(17_000)}\0source`],
  ])('never exposes a NUL to the %s parser input', (_path, source) => {
    let capturedInput: string | Parser.Input | undefined;
    const stub = {
      setTimeoutMicros: () => {},
      parse: (input: string | Parser.Input) => {
        capturedInput = input;
        return { rootNode: null } as unknown as Parser.Tree;
      },
    } as unknown as Parser;

    parseSourceSafe(stub, source);

    if (typeof capturedInput === 'string') {
      expect(capturedInput).not.toContain('\0');
      expect(capturedInput).toHaveLength(source.length);
    } else {
      expect(capturedInput).toBeTypeOf('function');
      let reconstructed = '';
      for (let index = 0; index < source.length; index += 16 * 1024) {
        const chunk = capturedInput?.(index, { row: 0, column: index });
        expect(chunk).not.toContain('\0');
        reconstructed += chunk ?? '';
      }
      expect(reconstructed).toHaveLength(source.length);
    }

    expect(warnSpy).toHaveBeenCalledWith(
      { nullByteCount: 1 },
      'replaced embedded NUL bytes before tree-sitter parsing',
    );
  });

  it('reports all replacements with the supplied file label', () => {
    const source = buildNullByteJavaSource().replace('after1', '\0after1');

    parseSourceSafe(makeJavaParser(), source, undefined, undefined, 'src/Demo.java');

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      { file: 'src/Demo.java', nullByteCount: 2 },
      'replaced embedded NUL bytes before tree-sitter parsing',
    );
  });

  it('keeps clean input on the existing path without a NUL warning', () => {
    const source = buildNullByteJavaSource().replace('\0', ' ');
    const tree = parseSourceSafe(makeJavaParser(), source, undefined, undefined, 'src/Demo.java');

    expect(tree.rootNode.hasError).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not consume the degraded-tree warning allowance', () => {
    parseSourceSafe(makeJavaParser(), buildNullByteJavaSource());
    const parser = makeParser();
    const malformed = 'def broken(:\n    return (1 + \n';

    for (let index = 0; index < 20; index += 1) {
      parseSourceSafe(parser, malformed);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(20);
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
