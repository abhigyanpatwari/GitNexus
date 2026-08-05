import { describe, expect, it } from 'vitest';
import {
  goPackageDir,
  inferGoPackageName,
} from '../../../../src/core/ingestion/languages/go/package-clause.js';

/**
 * #2837. Both Go package-bucketing passes used to carry their own copy of
 *
 *     sourceText.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)
 *
 * whose `m` flag matches the first `package <ident>` line ANYWHERE in the file,
 * comment bodies included. The two rows marked "regression" below were measured
 * returning the decoy name against that expression; everything else is a
 * behaviour-preservation control, because a stricter resolver that rejected a
 * real-world header would be a worse bug than the one being fixed.
 */
describe('inferGoPackageName (#2837)', () => {
  it('reads a plain package clause', () => {
    expect(inferGoPackageName('package services\n\nfunc f() {}\n')).toBe('services');
  });

  it('reads past a build constraint', () => {
    expect(inferGoPackageName('//go:build linux\n\npackage services\n')).toBe('services');
  });

  it('reads past a line-comment doc block', () => {
    expect(inferGoPackageName('// Package services does things.\npackage services\n')).toBe(
      'services',
    );
  });

  // REGRESSION: measured as "legacy_notes" before the fix.
  it('ignores a package line inside a block comment', () => {
    const src = '/*\npackage legacy_notes kept for history\n*/\npackage services\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  // REGRESSION: measured as "helper" before the fix.
  it('ignores an indented package line inside a block comment', () => {
    const src = '/*\n  package helper old name\n*/\npackage services\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  it('reads past several comments on one line', () => {
    expect(inferGoPackageName('/* a */ /* b */ package services\n')).toBe('services');
  });

  it('reads past a byte-order mark and CRLF line endings', () => {
    expect(inferGoPackageName('﻿//go:build linux\r\n\r\npackage services\r\n')).toBe('services');
  });

  it('is not fooled by a package line inside a later raw string literal', () => {
    const src = 'package services\n\nconst tmpl = `\npackage other\n`\n';
    expect(inferGoPackageName(src)).toBe('services');
  });

  // Go separates tokens by any whitespace, so this is legal and tree-sitter
  // parses it without error. A stricter matcher would drop the file from BOTH
  // Go cross-file passes (#2843 review).
  it('accepts a newline between the keyword and the package name', () => {
    expect(inferGoPackageName('package\nmain\n\nfunc f() {}\n')).toBe('main');
  });

  it('accepts CR-only line endings', () => {
    expect(inferGoPackageName('//go:build linux\r\rpackage services\r')).toBe('services');
  });

  it('returns null when the first real token is not a package clause', () => {
    expect(inferGoPackageName('func main() {}\n')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(inferGoPackageName('')).toBeNull();
  });

  it('returns null for an unterminated block comment', () => {
    expect(inferGoPackageName('/* never closed\npackage services\n')).toBeNull();
  });

  it('returns null for a line comment running to EOF', () => {
    expect(inferGoPackageName('// only a comment')).toBeNull();
  });
});

describe('goPackageDir', () => {
  it('returns the containing directory', () => {
    expect(goPackageDir('internal/services/pick_service.go')).toBe('internal/services');
  });

  it('normalizes Windows separators', () => {
    expect(goPackageDir('internal\\services\\pick_service.go')).toBe('internal/services');
  });

  it('returns an empty string for a repo-root file', () => {
    expect(goPackageDir('main.go')).toBe('');
  });
});
