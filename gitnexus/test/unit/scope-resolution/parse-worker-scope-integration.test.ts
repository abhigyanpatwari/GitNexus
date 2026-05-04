/**
 * Unit tests for `extractParsedFile` — the parse-worker → ScopeExtractor
 * bridge (RFC #909 Ring 2 PKG #920).
 *
 * The goal is to pin three invariants:
 *
 *   1. When a provider does NOT implement `emitScopeCaptures`, the helper
 *      returns `undefined` silently. This is the state of every language
 *      today — `ParseWorkerResult.parsedFiles` stays empty and the legacy
 *      DAG continues unaffected.
 *   2. When a provider DOES implement the hook, the helper threads its
 *      output through `ScopeExtractor.extract` and returns a `ParsedFile`.
 *   3. Exceptions from either the hook or the extractor are caught
 *      locally. The helper returns `undefined` — scope-extraction
 *      failures must NEVER break legacy parsing on the same file.
 */

import { describe, it, expect } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';

// ─── Capture helpers ────────────────────────────────────────────────────────

const cap = (
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  text = '',
): Capture => ({ name, range: { startLine, startCol, endLine, endCol }, text });

const moduleScopeMatch = (): CaptureMatch => ({
  '@scope.module': cap('@scope.module', 1, 0, 100, 0),
});

/**
 * Build a `LanguageProvider` whose shape is only as narrow as
 * `extractParsedFile` reads. Tests cast to the full provider type since
 * `extractParsedFile` is typed against `LanguageProvider` (not the narrow
 * `ScopeExtractorHooks`); the real worker always has a full provider.
 */
function fakeProvider(
  hooks: Partial<Pick<LanguageProvider, 'emitScopeCaptures' | 'resolveScopeKind'>>,
): LanguageProvider {
  return hooks as unknown as LanguageProvider;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('extractParsedFile', () => {
  describe('provider has NOT migrated (no emitScopeCaptures)', () => {
    it('returns undefined — silent no-op for legacy languages', () => {
      const provider = fakeProvider({}); // no hook
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeUndefined();
    });

    it('never calls the scope extractor when the hook is absent — cannot throw', () => {
      // If the extractor was wrongly invoked, it would complain about the
      // missing Module scope for empty captures. This test proves the
      // short-circuit actually fires.
      const provider = fakeProvider({});
      expect(() => extractParsedFile(provider, '', 'x.ts')).not.toThrow();
    });
  });

  describe('provider HAS migrated', () => {
    it('returns undefined without warning for whitespace-only source', () => {
      const warnings: string[] = [];
      let called = false;
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          called = true;
          throw new Error('should not inspect empty source');
        },
      });

      for (const src of ['', ' \n\t']) {
        const result = extractParsedFile(provider, src, 'pkg/__init__.py', (msg) => {
          warnings.push(msg);
        });
        expect(result).toBeUndefined();
      }

      expect(called).toBe(false);
      expect(warnings).toEqual([]);
    });

    it('threads emitScopeCaptures output through ScopeExtractor', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => [moduleScopeMatch()],
      });
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeDefined();
      expect(result!.filePath).toBe('src/file.ts');
      expect(result!.scopes).toHaveLength(1);
      expect(result!.scopes[0]!.kind).toBe('Module');
    });

    it('forwards the correct arguments to emitScopeCaptures', () => {
      let seenText: string | undefined;
      let seenPath: string | undefined;
      let seenTree: unknown;
      const cachedTree = { rootNode: {} };
      const provider = fakeProvider({
        emitScopeCaptures: (text, path, tree) => {
          seenText = text;
          seenPath = path;
          seenTree = tree;
          return [moduleScopeMatch()];
        },
      });
      extractParsedFile(provider, 'the real text', 'deep/path/file.ts', undefined, cachedTree);
      expect(seenText).toBe('the real text');
      expect(seenPath).toBe('deep/path/file.ts');
      expect(seenTree).toBe(cachedTree);
    });
  });

  describe('error resilience — never breaks legacy parsing', () => {
    it('returns undefined when emitScopeCaptures throws', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('routes errors through the onWarn callback when provided', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'path/to/file.ts', (msg) => {
        warnings.push(msg);
      });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('path/to/file.ts');
      expect(warnings[0]).toContain('provider boom');
    });

    it('returns undefined when ScopeExtractor throws (missing Module scope)', () => {
      // Emits a Class scope but no Module — extractor throws; helper
      // swallows and returns undefined. Legacy parsing on the same file
      // continues unaffected by this failure.
      const provider = fakeProvider({
        emitScopeCaptures: () => [{ '@scope.class': cap('@scope.class', 5, 0, 10, 0) }],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('returns undefined when ScopeExtractor throws on malformed captures (overlap)', () => {
      // Siblings with overlapping ranges trip the ScopeTreeInvariantError
      // from #912. The helper catches it and returns undefined.
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
          { '@scope.function': cap('@scope.function', 15, 0, 25, 0) }, // overlap
        ],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });
  });
});
