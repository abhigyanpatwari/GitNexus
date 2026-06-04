import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import * as parserLoader from '../../src/core/tree-sitter/parser-loader.js';

import { _captureLogger } from '../../src/core/logger.js';
import type { LoggerCapture } from '../../src/core/logger.js';
describe('sequential native parser availability', () => {
  // Hoisted so a stray live capture from a failed warn test can always be
  // torn down in afterEach — otherwise a single assertion failure cascades
  // into `_captureLogger: a previous capture is still active` (logger.ts).
  let cap: LoggerCapture | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cap?.restore();
    cap = undefined;
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
    cap = _captureLogger();
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    try {
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

      expect(
        cap
          .records()
          .some(
            (r) =>
              r.msg ===
              '[ingestion] Skipped 1 swift file(s) in import processing — swift parser not available.',
          ),
      ).toBe(true);
    } finally {
      // Always restore the live capture here (in addition to the afterEach
      // safety net) so a failing assertion above cannot leak it into the
      // next test as an "a previous capture is still active" cascade.
      cap.restore();
      cap = undefined;
      if (previous === undefined) {
        delete process.env.GITNEXUS_VERBOSE;
      } else {
        process.env.GITNEXUS_VERBOSE = previous;
      }
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
    cap = _captureLogger();
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    try {
      vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

      await processParsing(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
        createSymbolTable(),
        createASTCache(),
      );

      expect(
        cap
          .records()
          .some(
            (r) =>
              r.msg ===
              '[ingestion] Skipped 1 swift file(s) in parsing processing — swift parser not available.',
          ),
      ).toBe(true);
    } finally {
      // Always restore the live capture here (in addition to the afterEach
      // safety net) so a failing assertion above cannot leak it into the
      // next test as an "a previous capture is still active" cascade.
      cap.restore();
      cap = undefined;
      if (previous === undefined) {
        delete process.env.GITNEXUS_VERBOSE;
      } else {
        process.env.GITNEXUS_VERBOSE = previous;
      }
    }
  });
});
