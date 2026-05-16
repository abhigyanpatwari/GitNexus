/**
 * Unit tests for C++ import decomposition, interpretation, and target resolution.
 */

import { describe, it, expect } from 'vitest';
import { getCppParser } from '../../../../src/core/ingestion/languages/cpp/query.js';
import {
  splitCppInclude,
  splitCppUsingDecl,
} from '../../../../src/core/ingestion/languages/cpp/import-decomposer.js';
import { interpretCppImport } from '../../../../src/core/ingestion/languages/cpp/interpret.js';
import { resolveCppImportTarget } from '../../../../src/core/ingestion/languages/cpp/import-target.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';

function parseNode(src: string, type: string): SyntaxNode | null {
  const tree = getCppParser().parse(src);
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child?.type === type) return child as SyntaxNode;
  }
  return null;
}

function capt(name: string, text: string) {
  return { name, text, range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 } };
}

// ── #include decomposition ──────────────────────────────────────────────────

describe('C++ include decomposition (splitCppInclude)', () => {
  it('decomposes local include "#include \\"foo.h\\""', () => {
    const node = parseNode('#include "foo.h"', 'preproc_include');
    expect(node).not.toBeNull();
    const match = splitCppInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('foo.h');
    expect(match!['@import.kind'].text).toBe('wildcard');
    expect(match!['@import.system']).toBeUndefined();
  });

  it('decomposes system include "#include <iostream>"', () => {
    const node = parseNode('#include <iostream>', 'preproc_include');
    expect(node).not.toBeNull();
    const match = splitCppInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('iostream');
    expect(match!['@import.system']).toBeDefined();
  });

  it('decomposes C++ header include "#include \\"utils/helpers.hpp\\""', () => {
    const node = parseNode('#include "utils/helpers.hpp"', 'preproc_include');
    expect(node).not.toBeNull();
    const match = splitCppInclude(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.source'].text).toBe('utils/helpers.hpp');
  });
});

// ── using declaration decomposition ─────────────────────────────────────────

describe('C++ using declaration decomposition (splitCppUsingDecl)', () => {
  it('decomposes "using namespace std;" as wildcard import', () => {
    const node = parseNode('using namespace std;', 'using_declaration');
    expect(node).not.toBeNull();
    const match = splitCppUsingDecl(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.kind'].text).toBe('wildcard');
    expect(match!['@import.source'].text).toBe('std');
    expect(match!['@import.using-namespace']).toBeDefined();
  });

  it('decomposes "using std::vector;" as named import', () => {
    const node = parseNode('using std::vector;', 'using_declaration');
    expect(node).not.toBeNull();
    const match = splitCppUsingDecl(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.kind'].text).toBe('named');
    expect(match!['@import.source'].text).toBe('std');
    expect(match!['@import.name'].text).toBe('vector');
  });

  it('decomposes nested namespace "using namespace foo::bar;"', () => {
    const node = parseNode('using namespace foo::bar;', 'using_declaration');
    expect(node).not.toBeNull();
    const match = splitCppUsingDecl(node!);
    expect(match).not.toBeNull();
    expect(match!['@import.kind'].text).toBe('wildcard');
    expect(match!['@import.source'].text).toBe('foo::bar');
  });
});

// ── Import interpretation ───────────────────────────────────────────────────

describe('C++ import interpretation (interpretCppImport)', () => {
  it('interprets local include as wildcard import', () => {
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'header.hpp'),
    });
    expect(result).toEqual({ kind: 'wildcard', targetRaw: 'header.hpp' });
  });

  it('returns null for system headers', () => {
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'iostream'),
      '@import.system': capt('@import.system', 'true'),
    });
    expect(result).toBeNull();
  });

  it('interprets named import (using std::vector)', () => {
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'named'),
      '@import.source': capt('@import.source', 'std'),
      '@import.name': capt('@import.name', 'vector'),
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('named');
    expect(result!.targetRaw).toBe('std');
  });

  it('returns null when @import.source is missing', () => {
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
    });
    expect(result).toBeNull();
  });
});

// ── Import target resolution ────────────────────────────────────────────────

describe('C++ import target resolution (resolveCppImportTarget)', () => {
  it('resolves .hpp header', () => {
    const result = resolveCppImportTarget('foo.hpp', 'main.cpp', new Set(['foo.hpp', 'bar.cpp']));
    expect(result).toBe('foo.hpp');
  });

  it('resolves .hxx header', () => {
    const result = resolveCppImportTarget('foo.hxx', 'main.cpp', new Set(['foo.hxx']));
    expect(result).toBe('foo.hxx');
  });

  it('prefers same-directory sibling', () => {
    const result = resolveCppImportTarget(
      'bar.hpp',
      'src/foo.cpp',
      new Set(['include/bar.hpp', 'src/bar.hpp']),
    );
    expect(result).toBe('src/bar.hpp');
  });

  it('resolves suffix match with depth tiebreak', () => {
    const result = resolveCppImportTarget('foo.h', 'main.cpp', new Set(['a/b/c/foo.h', 'z/foo.h']));
    expect(result).toBe('z/foo.h');
  });

  it('returns null for no match', () => {
    expect(resolveCppImportTarget('missing.hpp', 'main.cpp', new Set(['foo.h']))).toBeNull();
  });
});
