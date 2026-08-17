import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('Objective-C parser-loader failure path', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../src/core/logger.js');
    vi.doUnmock('../../src/core/tree-sitter/vendored-grammars.js');
  });

  it('reports a clean unavailable Objective-C grammar with an actionable diagnostic', async () => {
    const errorLog = vi.fn();
    const warnLog = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        error: errorLog,
        warn: warnLog,
      },
    }));
    vi.doMock('../../src/core/tree-sitter/vendored-grammars.js', () => ({
      requireVendoredGrammar: (name: string) => {
        if (name === 'tree-sitter-objc') throw new Error('synthetic missing objc grammar');
        return {};
      },
    }));

    const { getLanguageGrammar, isGrammarRuntimeSkipped, isLanguageAvailable } = await import(
      '../../src/core/tree-sitter/parser-loader.js'
    );

    expect(isLanguageAvailable(SupportedLanguages.ObjectiveC)).toBe(false);
    expect(isGrammarRuntimeSkipped(SupportedLanguages.ObjectiveC)).toBe(false);
    expect(() => getLanguageGrammar(SupportedLanguages.ObjectiveC)).toThrow(
      /Unsupported language: objective-c/,
    );
    expect(warnLog).not.toHaveBeenCalled();
    expect(String(errorLog.mock.calls[0]?.[0] ?? '')).toMatch(
      /Objective-C parsing disabled[\s\S]*tree-sitter-objc[\s\S]*synthetic missing objc grammar/,
    );
  });
});
