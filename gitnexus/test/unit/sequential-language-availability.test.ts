import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  loadParser: vi.fn(async () => ({
    parse: vi.fn(),
    getLanguage: vi.fn(),
  })),
  loadLanguage: vi.fn(async () => undefined),
  isLanguageAvailable: vi.fn(() => true),
}));

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { processImports } from '../../src/core/ingestion/import-processor.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { processHeritage } from '../../src/core/ingestion/heritage-processor.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import * as parserLoader from '../../src/core/tree-sitter/parser-loader.js';

describe('sequential native parser availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips Swift files in processImports when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processImports(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'import Foundation' }],
        createASTCache(),
        createResolutionContext(),
        undefined,
        '/tmp/repo',
        ['App.swift'],
      ),
    ).resolves.toBeUndefined();

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processImports skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processImports(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'import Foundation' }],
      createASTCache(),
      createResolutionContext(),
      undefined,
      '/tmp/repo',
      ['App.swift'],
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in import processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.GITNEXUS_VERBOSE;
    } else {
      process.env.GITNEXUS_VERBOSE = previous;
    }
  });

  it('skips Swift files in processCalls when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processCalls(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'func demo() {}' }],
        createASTCache(),
        createResolutionContext(),
      ),
    ).resolves.toEqual([]);

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processCalls skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processCalls(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'func demo() {}' }],
      createASTCache(),
      createResolutionContext(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in call processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.GITNEXUS_VERBOSE;
    } else {
      process.env.GITNEXUS_VERBOSE = previous;
    }
  });

  it('skips Swift files in processHeritage when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processHeritage(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
        createASTCache(),
        createResolutionContext(),
      ),
    ).resolves.toBeUndefined();

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processHeritage skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processHeritage(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
      createASTCache(),
      createResolutionContext(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in heritage processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.GITNEXUS_VERBOSE;
    } else {
      process.env.GITNEXUS_VERBOSE = previous;
    }
  });

  it('skips Swift files in processParsing when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processParsing(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
        createSymbolTable(),
        createASTCache(),
      ),
    ).resolves.toBeNull();

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processParsing skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processParsing(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
      createSymbolTable(),
      createASTCache(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in parsing processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.GITNEXUS_VERBOSE;
    } else {
      process.env.GITNEXUS_VERBOSE = previous;
    }
  });
});
