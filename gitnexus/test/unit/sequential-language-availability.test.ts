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
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { processHeritage } from '../../src/core/ingestion/heritage-processor.js';
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
      if (previous === undefined) {
        delete process.env.GITNEXUS_VERBOSE;
      } else {
        process.env.GITNEXUS_VERBOSE = previous;
      }
    }
  });

  it('skips Swift files in processCalls (registry-primary: scope-resolution owns call resolution)', async () => {
    // Swift is registry-primary, so processCalls skips it via the
    // isRegistryPrimary gate (call-processor.ts) BEFORE the parser-availability
    // check — the registry-primary scope-resolution path owns its call edges
    // (#1951). The unavailable-parser mock is therefore moot: the file is skipped
    // (no loadLanguage) regardless. The legacy availability-skip path itself is
    // exercised by the Dart verbose test below (Dart is not registry-primary).
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
    cap = _captureLogger();
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    try {
      vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

      // Use Dart, a non-registry-primary language. call-processor gates
      // registry-primary languages (Swift, etc.) via the isRegistryPrimary
      // gate before the parser-availability skip counter, so a Dart file
      // exercises the skip/warn branch without forcing any language out of
      // registry-primary mode (Swift must stay scope-based).
      await processCalls(
        createKnowledgeGraph(),
        [{ path: 'App.dart', content: 'void demo() {}' }],
        createASTCache(),
        createResolutionContext(),
      );

      expect(
        cap
          .records()
          .some(
            (r) =>
              r.msg ===
              '[ingestion] Skipped 1 dart file(s) in call processing — dart parser not available.',
          ),
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.GITNEXUS_VERBOSE;
      } else {
        process.env.GITNEXUS_VERBOSE = previous;
      }
    }
  });

  it('skips Swift files in processHeritage (registry-primary: scope-resolution owns heritage)', async () => {
    // Swift is registry-primary, so processHeritage skips it via the
    // isRegistryPrimary gate (heritage-processor.ts) BEFORE the parser-availability
    // check — scope-resolution (#1951) owns its EXTENDS/IMPLEMENTS edges. The
    // unavailable-parser mock is therefore moot: the file is skipped (no
    // loadLanguage) regardless. The legacy availability-skip path itself is
    // exercised by the Dart verbose test below (Dart is not registry-primary).
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
    cap = _captureLogger();
    const previous = process.env.GITNEXUS_VERBOSE;
    process.env.GITNEXUS_VERBOSE = '1';
    try {
      vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

      // Use Dart, a non-registry-primary language. processHeritage skips
      // registry-primary languages (Swift, etc.) via the isRegistryPrimary gate
      // — scope-based resolution owns their inheritance (#1951) — BEFORE the
      // legacy parser-availability skip this test exercises. Dart still flows
      // through the legacy heritage path, so the skip/warn branch fires without
      // forcing any language out of registry-primary mode.
      await processHeritage(
        createKnowledgeGraph(),
        [{ path: 'App.dart', content: 'class Widget extends StatelessWidget {}' }],
        createASTCache(),
        createResolutionContext(),
      );

      expect(
        cap
          .records()
          .some(
            (r) =>
              r.msg ===
              '[ingestion] Skipped 1 dart file(s) in heritage processing — dart parser not available.',
          ),
      ).toBe(true);
    } finally {
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
      if (previous === undefined) {
        delete process.env.GITNEXUS_VERBOSE;
      } else {
        process.env.GITNEXUS_VERBOSE = previous;
      }
    }
  });
});
