/**
 * Unit tests for import-resolution.ts
 *
 * Coverage notes:
 * - `preprocessImportPath` is tested directly below (no tree-sitter required for most paths).
 * - Rust scoped grouped import logic (`resolveRustImportDispatch`) requires a live file system
 *   and ResolveCtx — that path is covered by test/integration/resolvers/rust.test.ts.
 * - PHP `use function` / `use const` filtering (via `extractPhpNamedBindings`) requires
 *   tree-sitter PHP nodes — covered by test/integration/resolvers/php.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { preprocessImportPath } from '../../../src/core/ingestion/import-processor.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// ---------------------------------------------------------------------------
// Minimal SyntaxNode stub — only the fields preprocessImportPath touches.
// For non-Kotlin languages preprocessImportPath never reads the node, so an
// empty stub satisfies the type requirement without loading tree-sitter.
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<{ childCount: number; child: (i: number) => any }> = {}): any {
  return {
    childCount: overrides.childCount ?? 0,
    child: overrides.child ?? (() => null),
  };
}

// ---------------------------------------------------------------------------
// preprocessImportPath — universal cleaning behaviour
// ---------------------------------------------------------------------------

describe('preprocessImportPath', () => {
  describe('quote and bracket stripping', () => {
    it('strips double quotes from a bare module path', () => {
      const node = makeNode();
      expect(preprocessImportPath('"foo"', node, getProvider(SupportedLanguages.TypeScript))).toBe(
        'foo',
      );
    });

    it('strips single quotes from a bare module path', () => {
      const node = makeNode();
      expect(
        preprocessImportPath("'bar/baz'", node, getProvider(SupportedLanguages.JavaScript)),
      ).toBe('bar/baz');
    });

    it('strips angle brackets from a C-style include path', () => {
      const node = makeNode();
      expect(preprocessImportPath('<stdio.h>', node, getProvider(SupportedLanguages.C))).toBe(
        'stdio.h',
      );
    });

    it('strips mixed quote and angle bracket characters', () => {
      const node = makeNode();
      // Pathological input — all stripped characters removed
      expect(
        preprocessImportPath('"<hello>"', node, getProvider(SupportedLanguages.TypeScript)),
      ).toBe('hello');
    });
  });

  describe('null returns for invalid inputs', () => {
    it('returns null for an empty string (after cleaning)', () => {
      const node = makeNode();
      // Only quote characters — cleaned result is empty string
      expect(
        preprocessImportPath('""', node, getProvider(SupportedLanguages.TypeScript)),
      ).toBeNull();
    });

    it('returns null for a string containing control characters', () => {
      const node = makeNode();
      // \x01 is a control character that passes the length check but fails the regex guard
      expect(
        preprocessImportPath('foo\x01bar', node, getProvider(SupportedLanguages.Rust)),
      ).toBeNull();
    });

    it('returns null for a string containing a null byte', () => {
      const node = makeNode();
      expect(
        preprocessImportPath('foo\x00bar', node, getProvider(SupportedLanguages.Go)),
      ).toBeNull();
    });

    it('returns null for a path exceeding 2048 characters', () => {
      const node = makeNode();
      const longPath = 'a'.repeat(2049);
      expect(
        preprocessImportPath(longPath, node, getProvider(SupportedLanguages.Python)),
      ).toBeNull();
    });

    it('accepts a path of exactly 2048 characters', () => {
      const node = makeNode();
      const maxPath = 'a'.repeat(2048);
      expect(preprocessImportPath(maxPath, node, getProvider(SupportedLanguages.Python))).toBe(
        maxPath,
      );
    });
  });

  describe('Kotlin wildcard pass-through', () => {
    it('delegates to appendKotlinWildcard when language is Kotlin — no wildcard child', () => {
      // Node with no children -> appendKotlinWildcard returns the path unchanged
      const node = makeNode({ childCount: 0 });
      const result = preprocessImportPath(
        'com.example.models',
        node,
        getProvider(SupportedLanguages.Kotlin),
      );
      // Without a wildcard_import child the path is returned as-is
      expect(result).toBe('com.example.models');
    });

    it('delegates to appendKotlinWildcard when language is Kotlin — wildcard_import child present', () => {
      // Simulate a node that has a wildcard_import child at index 0
      const wildcardChild = { type: 'wildcard_import' };
      const node = makeNode({
        childCount: 1,
        child: (i: number) => (i === 0 ? wildcardChild : null),
      });
      const result = preprocessImportPath(
        'com.example.models',
        node,
        getProvider(SupportedLanguages.Kotlin),
      );
      // appendKotlinWildcard appends .* when the wildcard_import child is found
      expect(result).toBe('com.example.models.*');
    });
  });

  describe('non-Kotlin languages are returned unchanged (after cleaning)', () => {
    it('returns the cleaned path for Rust without modification', () => {
      const node = makeNode();
      expect(
        preprocessImportPath('"crate::models"', node, getProvider(SupportedLanguages.Rust)),
      ).toBe('crate::models');
    });

    it('returns the cleaned path for PHP without modification', () => {
      const node = makeNode();
      expect(
        preprocessImportPath('"App\\\\Models\\\\User"', node, getProvider(SupportedLanguages.PHP)),
      ).toBe('App\\\\Models\\\\User');
    });
  });
});

// ---------------------------------------------------------------------------
// Rust scoped grouped import logic (resolveRustImportDispatch)
// ---------------------------------------------------------------------------
// The dispatch function requires a live ResolveCtx with file lists — unit
// testing it without a file system would duplicate the integration fixtures.
// The following comment documents what the integration tests verify:
//
//   test/integration/resolvers/rust.test.ts covers:
//   - Top-level grouped:  use {crate::a, crate::b}
//   - Scoped grouped:     use crate::models::{User, Repo}
//   - Alias stripping:    use crate::models::{User, Repo as R} -> resolves User + Repo
//   - Prefix fallback:    when no individual items resolve, resolves the prefix path
//
// The ::{  detection and alias-stripping logic lives in resolveRustImportDispatch()
// at import-resolution.ts lines 328-344.

// ---------------------------------------------------------------------------
// PHP use function / use const filtering (extractPhpNamedBindings)
// ---------------------------------------------------------------------------
// extractPhpNamedBindings requires live tree-sitter PHP SyntaxNode objects.
// The filtering of `use function` and `use const` declarations is covered by:
//
//   test/integration/resolvers/php.test.ts
//
// which runs the full ingestion pipeline over PHP fixture repositories and
// asserts that function/const use-declarations do not produce spurious IMPORTS
// edges to non-existent class files.
