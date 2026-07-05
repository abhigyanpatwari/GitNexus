/**
 * Unit tests for C import decomposition, interpretation, and target resolution.
 */

import { describe, it, expect } from 'vitest';
import { getCParser } from '../../../../src/core/ingestion/languages/c/query.js';
import { splitCInclude } from '../../../../src/core/ingestion/languages/c/import-decomposer.js';
import { interpretCImport } from '../../../../src/core/ingestion/languages/c/interpret.js';
import { resolveCImportTarget } from '../../../../src/core/ingestion/languages/c/import-target.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';

function parseIncludeNode(src: string): SyntaxNode | null {
  const tree = getCParser().parse(src);
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child?.type === 'preproc_include') return child as SyntaxNode;
  }
  return null;
}

function capt(name: string, text: string) {
  return { name, text, range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 } };
}

describe('C import decomposition (splitCInclude)', () => {
  it('decomposes local include "#include \\"foo.h\\""', () => {
    const node = parseIncludeNode('#include "foo.h"');
    expect(node).not.toBeNull();
    const match = splitCInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('foo.h');
    expect(match!['@import.kind'].text).toBe('wildcard');
    expect(match!['@import.system']).toBeUndefined();
  });

  it('decomposes system include "#include <stdio.h>"', () => {
    const node = parseIncludeNode('#include <stdio.h>');
    expect(node).not.toBeNull();
    const match = splitCInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('stdio.h');
    expect(match!['@import.system']).toBeDefined();
  });

  it('decomposes nested path include', () => {
    const node = parseIncludeNode('#include "utils/helpers.h"');
    expect(node).not.toBeNull();
    const match = splitCInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('utils/helpers.h');
  });
});

describe('C import interpretation (interpretCImport)', () => {
  it('interprets local include as wildcard import', () => {
    const result = interpretCImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'header.h'),
    });
    expect(result).toEqual({ kind: 'wildcard', targetRaw: 'header.h' });
  });

  it('returns null for system headers', () => {
    const result = interpretCImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'stdio.h'),
      '@import.system': capt('@import.system', 'true'),
    });
    expect(result).toBeNull();
  });

  it('returns null when @import.source is missing', () => {
    const result = interpretCImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
    });
    expect(result).toBeNull();
  });
});

describe('C import target resolution (resolveCImportTarget)', () => {
  it('resolves exact match', () => {
    const result = resolveCImportTarget('foo.h', 'main.c', new Set(['foo.h', 'bar.h']));
    expect(result).toBe('foo.h');
  });

  it('resolves suffix match to shortest path', () => {
    const result = resolveCImportTarget(
      'foo.h',
      'main.c',
      new Set(['src/include/foo.h', 'include/foo.h', 'other/bar.h']),
    );
    expect(result).toBe('include/foo.h');
  });

  it('resolves nested include path with directory components', () => {
    const result = resolveCImportTarget(
      'utils/helpers.h',
      'main.c',
      new Set(['src/utils/helpers.h', 'lib/utils/helpers.h']),
    );
    // Both have same depth (3 components), so lexicographic tiebreak picks lib/
    expect(result).toBe('lib/utils/helpers.h');
  });

  it('returns null for empty target', () => {
    expect(resolveCImportTarget('', 'main.c', new Set(['foo.h']))).toBeNull();
  });

  it('returns null when no match found', () => {
    expect(resolveCImportTarget('missing.h', 'main.c', new Set(['foo.h']))).toBeNull();
  });

  it('is deterministic on depth ties — lexicographic tiebreak', () => {
    const files = new Set(['test/util/foo.h', 'src/util/foo.h']);
    const result1 = resolveCImportTarget('foo.h', 'main.c', files);
    const result2 = resolveCImportTarget('foo.h', 'main.c', files);
    expect(result1).toBe(result2);
    // Lexicographic: src/util/foo.h < test/util/foo.h
    expect(result1).toBe('src/util/foo.h');
  });

  it('prefers shallower path over lexicographic order', () => {
    const result = resolveCImportTarget('foo.h', 'main.c', new Set(['a/b/c/foo.h', 'z/foo.h']));
    expect(result).toBe('z/foo.h');
  });

  it('handles backslash paths (Windows)', () => {
    const result = resolveCImportTarget('foo.h', 'main.c', new Set(['include\\foo.h']));
    expect(result).toBe('include\\foo.h');
  });

  it('prefers same-directory sibling over deeper suffix match', () => {
    // src/foo.c includes "bar.h" — src/bar.h should win over include/bar.h
    const result = resolveCImportTarget(
      'bar.h',
      'src/foo.c',
      new Set(['include/bar.h', 'src/bar.h']),
    );
    expect(result).toBe('src/bar.h');
  });

  it('prefers same-directory sibling over shallower suffix match', () => {
    // deep/nested/main.c includes "foo.h" — deep/nested/foo.h wins over foo.h
    const result = resolveCImportTarget(
      'foo.h',
      'deep/nested/main.c',
      new Set(['foo.h', 'deep/nested/foo.h']),
    );
    expect(result).toBe('deep/nested/foo.h');
  });

  it('falls back to suffix match when no same-directory sibling exists', () => {
    const result = resolveCImportTarget('missing.h', 'src/foo.c', new Set(['lib/missing.h']));
    expect(result).toBe('lib/missing.h');
  });

  it('same-directory sibling with nested target path', () => {
    // src/foo.c includes "sub/bar.h" — src/sub/bar.h should win
    const result = resolveCImportTarget(
      'sub/bar.h',
      'src/foo.c',
      new Set(['other/sub/bar.h', 'src/sub/bar.h']),
    );
    expect(result).toBe('src/sub/bar.h');
  });
});
