import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createParserForLanguage, getLanguageFromFilename, parseSourceSafeSpy } = vi.hoisted(() => ({
  createParserForLanguage: vi.fn(),
  getLanguageFromFilename: vi.fn((filePath: string) =>
    filePath.endsWith('.py') ? 'python' : 'typescript',
  ),
  parseSourceSafeSpy: vi.fn(),
}));

vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  createParserForLanguage,
  isLanguageAvailable: vi.fn().mockReturnValue(true),
  resolveLanguageKey: vi.fn((language: string, filePath?: string) =>
    language === 'typescript' && filePath?.endsWith('.tsx') ? 'typescript:tsx' : language,
  ),
}));

vi.mock('../../src/core/tree-sitter/safe-parse.js', async () => {
  const { buildSafeParseMock } = await import('../helpers/parse-source-safe-mock.js');
  return buildSafeParseMock(parseSourceSafeSpy);
});

vi.mock('gitnexus-shared', () => ({
  getLanguageFromFilename,
}));

describe('ensureAndParse', () => {
  beforeEach(() => {
    vi.resetModules();
    createParserForLanguage.mockReset();
    getLanguageFromFilename.mockClear();
  });

  it('reuses the parser for the same grammar key across interleaved languages', async () => {
    const tsParse = vi
      .fn()
      .mockReturnValueOnce({ lang: 'ts', content: 'first' })
      .mockReturnValueOnce({ lang: 'ts', content: 'second' });
    const pyParse = vi.fn().mockReturnValue({ lang: 'py', content: 'middle' });

    createParserForLanguage.mockImplementation(async (language: string, filePath?: string) => {
      if (language === 'typescript') return { parse: tsParse, key: filePath };
      if (language === 'python') return { parse: pyParse, key: filePath };
      throw new Error(`unexpected language ${language}`);
    });

    const { ensureAndParse } = await import('../../src/core/embeddings/ast-utils.js');

    const tsFirst = await ensureAndParse('const one = 1;', 'first.ts');
    const pyMiddle = await ensureAndParse('value = 1', 'middle.py');
    const tsSecond = await ensureAndParse('const two = 2;', 'second.ts');

    expect(tsFirst).toEqual({ lang: 'ts', content: 'first' });
    expect(pyMiddle).toEqual({ lang: 'py', content: 'middle' });
    expect(tsSecond).toEqual({ lang: 'ts', content: 'second' });
    expect(createParserForLanguage).toHaveBeenCalledTimes(2);
    expect(tsParse).toHaveBeenCalledTimes(2);
    expect(pyParse).toHaveBeenCalledTimes(1);
  });

  it('uses separate parser instances for .ts and .tsx', async () => {
    const tsParse = vi.fn().mockReturnValue({ lang: 'ts' });
    const tsxParse = vi.fn().mockReturnValue({ lang: 'tsx' });

    createParserForLanguage.mockImplementation(async (_language: string, filePath?: string) => {
      if (filePath?.endsWith('.tsx')) return { parse: tsxParse };
      return { parse: tsParse };
    });

    const { ensureAndParse } = await import('../../src/core/embeddings/ast-utils.js');

    await ensureAndParse('const value = 1;', 'plain.ts');
    await ensureAndParse('export const View = <div />;', 'view.tsx');
    await ensureAndParse('const other = 2;', 'other.ts');

    expect(createParserForLanguage).toHaveBeenCalledTimes(2);
    expect(tsParse).toHaveBeenCalledTimes(2);
    expect(tsxParse).toHaveBeenCalledTimes(1);
  });

  // Windows SIGSEGV regression: ensureAndParse must route through parseSourceSafe
  // so >32 767-char inputs do not crash the process. Direct parser.parse(content)
  // on strings that size SIGSEGVs on Windows; the spy assertion is what catches
  // a bypass since parser.parse(40 000 chars) succeeds on Linux/macOS.
  it('routes >32 767-char input through parseSourceSafe', async () => {
    parseSourceSafeSpy.mockClear();

    const fakeParse = vi.fn().mockReturnValue({ rootNode: { type: 'module' } });
    createParserForLanguage.mockResolvedValue({ parse: fakeParse });

    const { ensureAndParse } = await import('../../src/core/embeddings/ast-utils.js');

    const largeInput = 'const x = 1;\n'.repeat(4000); // ~52 000 chars
    expect(largeInput.length).toBeGreaterThan(40_000);

    const result = await ensureAndParse(largeInput, 'big.ts');

    expect(parseSourceSafeSpy).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});
