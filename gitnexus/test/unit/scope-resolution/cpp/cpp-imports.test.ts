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
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { cppScopeResolver } from '../../../../src/core/ingestion/languages/cpp/scope-resolver.js';
import { finalizeScopeModel } from '../../../../src/core/ingestion/finalize-orchestrator.js';
import { populateCppUsingBindings } from '../../../../src/core/ingestion/languages/cpp/using-bindings.js';
import { findCallableBindingsAndAdlBlocker } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';

it('merges same-file local overloads with a named using at its declaration position', () => {
  const parsed = extractParsedFile(
    cppScopeResolver.languageProvider,
    `namespace imported { void choose(int) {} }
void choose(double) {}
void before() { choose(1.0); }
using imported::choose;
void after() { choose(1.0); }
void inner() { using imported::choose; choose(1.0); }
`,
    'overloads.cpp',
  )!;
  cppScopeResolver.populateOwners(parsed);
  const indexes = finalizeScopeModel([parsed]);
  populateCppUsingBindings([parsed], indexes);
  for (const [line, expected] of [
    [3, ['def:overloads.cpp#2:0:Function:choose']],
    [5, ['def:overloads.cpp#1:21:Function:choose', 'def:overloads.cpp#2:0:Function:choose']],
    [6, ['def:overloads.cpp#1:21:Function:choose']],
  ] as const) {
    const scope = parsed.scopes.find((s) => s.kind === 'Block' && s.range.startLine === line)!;
    expect(
      findCallableBindingsAndAdlBlocker(scope.id, 'choose', indexes, {
        position: { startLine: line, startCol: line === 6 ? 40 : 16 },
      })
        .callables.map((def) => def.nodeId)
        .sort(),
    ).toEqual(expected);
  }
});

function parseNode(src: string, type: string): SyntaxNode | null {
  const tree = getCppParser().parse(src);
  const stack: SyntaxNode[] = [tree.rootNode as SyntaxNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child as SyntaxNode);
    }
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
  it('keeps an inline method using-declaration separate from class member using', () => {
    const node = parseNode(
      'struct Worker { void run() { using helpers::work; work(); } };',
      'using_declaration',
    );
    expect(node).not.toBeNull();
    expect(splitCppUsingDecl(node!)?.['@import.name']?.text).toBe('work');
  });

  it('does not treat a class-scope member using-declaration as an import', () => {
    const node = parseNode('struct Derived : Base { using Base::run; };', 'using_declaration');
    expect(node).not.toBeNull();
    expect(splitCppUsingDecl(node!)).toBeNull();
  });

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

  it('keeps every namespace segment in a qualified named using', () => {
    const node = parseNode('using foo::bar::work;', 'using_declaration');
    const match = splitCppUsingDecl(node!);
    expect(match?.['@import.source']?.text).toBe('foo::bar');
    expect(match?.['@import.name']?.text).toBe('work');
  });
});

// ── Import interpretation ───────────────────────────────────────────────────

describe('C++ import interpretation (interpretCppImport)', () => {
  it.each(['using namespace helpers;', 'using helpers::work;'])(
    'does not interpret %s as a header dependency',
    (source) => {
      const node = parseNode(source, 'using_declaration');
      const captures = splitCppUsingDecl(node!);
      expect(captures).not.toBeNull();
      expect(interpretCppImport(captures!)).toBeNull();
    },
  );

  it('interprets local include as wildcard import', () => {
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'header.hpp'),
    });
    // isSystem is false for quoted #include "..." (no @import.system capture).
    expect(result).toEqual({ kind: 'wildcard', targetRaw: 'header.hpp', isSystem: false });
  });

  it('interprets system header as wildcard with isSystem:true', () => {
    // The interpreter no longer returns null for system headers — it returns a
    // ParsedImport with isSystem:true. The resolver (cppScopeResolver) is the
    // layer that refuses to suffix-match system headers against workspace files.
    const result = interpretCppImport({
      '@import.kind': capt('@import.kind', 'wildcard'),
      '@import.source': capt('@import.source', 'iostream'),
      '@import.system': capt('@import.system', 'true'),
    });
    expect(result).toEqual({ kind: 'wildcard', targetRaw: 'iostream', isSystem: true });
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
