/**
 * Unit tests for C++ scope query + captures orchestrator.
 *
 * Pins the capture-tag vocabulary + range shape for every construct
 * the scope-resolution pipeline reads. Runs against tree-sitter-cpp.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { emitCppScopeCaptures } from '../../../../src/core/ingestion/languages/cpp/captures.js';
import {
  clearFileLocalNames,
  isFileLocal,
} from '../../../../src/core/ingestion/languages/cpp/file-local-linkage.js';

function tagsFor(src: string, filePath = 'test.cpp'): string[][] {
  const matches = emitCppScopeCaptures(src, filePath);
  return matches.map((m) => Object.keys(m).sort());
}

function findMatch(src: string, predicate: (tags: string[]) => boolean, filePath = 'test.cpp') {
  const matches = emitCppScopeCaptures(src, filePath);
  return matches.find((m) => predicate(Object.keys(m)));
}

function allMatches(src: string, predicate: (tags: string[]) => boolean, filePath = 'test.cpp') {
  const matches = emitCppScopeCaptures(src, filePath);
  return matches.filter((m) => predicate(Object.keys(m)));
}

// ── Scopes ──────────────────────────────────────────────────────────────────

describe('emitCppScopeCaptures — scopes', () => {
  it('captures translation_unit as @scope.module', () => {
    const all = tagsFor('int x = 1;');
    expect(all.some((t) => t.includes('@scope.module'))).toBe(true);
  });

  it('captures class_specifier as @scope.class', () => {
    const all = tagsFor('class Foo { int x; };');
    expect(all.some((t) => t.includes('@scope.class'))).toBe(true);
  });

  it('captures struct_specifier as @scope.class', () => {
    const all = tagsFor('struct Point { int x; int y; };');
    expect(all.some((t) => t.includes('@scope.class'))).toBe(true);
  });

  it('captures namespace_definition as @scope.namespace', () => {
    const all = tagsFor('namespace foo { int x; }');
    expect(all.some((t) => t.includes('@scope.namespace'))).toBe(true);
  });

  it('captures function_definition as @scope.function', () => {
    const all = tagsFor('void foo() { }');
    expect(all.some((t) => t.includes('@scope.function'))).toBe(true);
  });

  it('captures lambda_expression as @scope.function', () => {
    const all = tagsFor('auto f = [](int x) { return x; };');
    expect(all.some((t) => t.includes('@scope.function'))).toBe(true);
  });

  it('captures block-level scopes (if, for, while, do, switch, case, try, catch)', () => {
    const src = `
      void f() {
        if (true) { }
        for (int i = 0; i < 10; i++) { }
        while (true) { }
        do { } while (false);
        switch (0) { case 0: break; }
        try { } catch (...) { }
      }
    `;
    const all = tagsFor(src);
    const blocks = all.filter((t) => t.includes('@scope.block'));
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });

  it('captures for_range_loop as @scope.block', () => {
    const src = `
      #include <vector>
      void f() {
        std::vector<int> v;
        for (auto& x : v) { }
      }
    `;
    const all = tagsFor(src);
    const blocks = all.filter((t) => t.includes('@scope.block'));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Declarations — classes / structs ────────────────────────────────────────

describe('emitCppScopeCaptures — class declarations', () => {
  it('captures named class with @declaration.class', () => {
    const m = findMatch('class Foo { int x; };', (t) => t.includes('@declaration.class'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Foo');
  });

  it('captures named struct with @declaration.struct', () => {
    const m = findMatch('struct Point { int x; int y; };', (t) =>
      t.includes('@declaration.struct'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Point');
  });

  it('captures template class with @declaration.class', () => {
    const m = findMatch('template <typename T> class Container { T val; };', (t) =>
      t.includes('@declaration.class'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Container');
  });
});

// ── Declarations — namespaces ───────────────────────────────────────────────

describe('emitCppScopeCaptures — namespace declarations', () => {
  it('captures named namespace with @declaration.namespace', () => {
    const m = findMatch('namespace foo { int x; }', (t) => t.includes('@declaration.namespace'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('foo');
  });

  it('anonymous namespace has no @declaration.namespace (only @scope.namespace)', () => {
    const matches = allMatches('namespace { int x; }', (t) => t.includes('@declaration.namespace'));
    // Anonymous namespace should NOT produce a @declaration.namespace
    expect(matches.length).toBe(0);
  });
});

// ── Declarations — functions / methods ──────────────────────────────────────

describe('emitCppScopeCaptures — function declarations', () => {
  it('captures function definition with @declaration.function', () => {
    const m = findMatch('void foo() {}', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('foo');
  });

  it('captures function with pointer return as @declaration.function', () => {
    const m = findMatch('int* create() {}', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('create');
  });

  it('captures out-of-class method (qualified_identifier) as @declaration.method', () => {
    const m = findMatch('void Foo::bar() {}', (t) => t.includes('@declaration.method'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('bar');
  });

  it('captures destructor as @declaration.method', () => {
    const m = findMatch('void Foo::~Foo() {}', (t) => t.includes('@declaration.method'));
    expect(m).toBeDefined();
    // destructor_name includes the ~
    expect(m!['@declaration.name'].text).toContain('~');
  });

  it('captures inline method (field_identifier) as @declaration.method', () => {
    const src = 'class Foo { void bar() {} };';
    const m = findMatch(src, (t) => t.includes('@declaration.method'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('bar');
  });

  it('captures function prototype as @declaration.function', () => {
    const m = findMatch('void foo();', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('foo');
  });

  it('captures template function as @declaration.function', () => {
    const m = findMatch('template <typename T> void foo(T x) {}', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('foo');
  });
});

// ── Declarations — fields ───────────────────────────────────────────────────

describe('emitCppScopeCaptures — field declarations', () => {
  it('captures plain field', () => {
    const m = findMatch('class Foo { int val; };', (t) => t.includes('@declaration.field'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('val');
  });

  it('captures pointer field', () => {
    const m = findMatch('class Foo { int* ptr; };', (t) => t.includes('@declaration.field'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('ptr');
  });

  it('captures reference field', () => {
    const m = findMatch('class Foo { int& ref; };', (t) => t.includes('@declaration.field'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('ref');
  });
});

// ── Declarations — variables ────────────────────────────────────────────────

describe('emitCppScopeCaptures — variable declarations', () => {
  it('captures variable with initializer', () => {
    const m = findMatch('int x = 42;', (t) => t.includes('@declaration.variable'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('x');
  });
});

// ── Declarations — enums ────────────────────────────────────────────────────

describe('emitCppScopeCaptures — enum declarations', () => {
  it('captures enum with @declaration.enum', () => {
    const m = findMatch('enum Color { Red, Green, Blue };', (t) => t.includes('@declaration.enum'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Color');
  });

  it('captures enum constants with @declaration.const', () => {
    const matches = allMatches('enum Color { Red, Green, Blue };', (t) =>
      t.includes('@declaration.const'),
    );
    expect(matches.length).toBe(3);
    const names = matches.map((m) => m['@declaration.name'].text).sort();
    expect(names).toEqual(['Blue', 'Green', 'Red']);
  });
});

// ── Declarations — typedef / alias ──────────────────────────────────────────

describe('emitCppScopeCaptures — typedef/alias declarations', () => {
  it('captures typedef as @declaration.typedef', () => {
    const m = findMatch('typedef int MyInt;', (t) => t.includes('@declaration.typedef'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('MyInt');
  });

  it('captures using alias as @declaration.typedef', () => {
    const m = findMatch('using MyInt = int;', (t) => t.includes('@declaration.typedef'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('MyInt');
  });
});

// ── Declarations — macros ───────────────────────────────────────────────────

describe('emitCppScopeCaptures — macro declarations', () => {
  it('captures #define as @declaration.macro', () => {
    const m = findMatch('#define MAX 100', (t) => t.includes('@declaration.macro'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('MAX');
  });

  it('captures #define function as @declaration.macro', () => {
    const m = findMatch('#define ADD(a,b) ((a)+(b))', (t) => t.includes('@declaration.macro'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('ADD');
  });
});

// ── Imports ─────────────────────────────────────────────────────────────────

describe('emitCppScopeCaptures — imports', () => {
  it('captures #include local as wildcard import', () => {
    const m = findMatch('#include "foo.h"', (t) => t.includes('@import.source'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('foo.h');
    expect(m!['@import.kind'].text).toBe('wildcard');
    expect(m!['@import.system']).toBeUndefined();
  });

  it('captures #include system with system marker', () => {
    const m = findMatch('#include <iostream>', (t) => t.includes('@import.source'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('iostream');
    expect(m!['@import.system']).toBeDefined();
  });

  it('captures using namespace as wildcard import', () => {
    const m = findMatch('using namespace std;', (t) => t.includes('@import.using-namespace'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('std');
    expect(m!['@import.kind'].text).toBe('wildcard');
  });

  it('captures using declaration as named import', () => {
    const m = findMatch('using std::vector;', (t) => t.includes('@import.name'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('std');
    expect(m!['@import.name'].text).toBe('vector');
    expect(m!['@import.kind'].text).toBe('named');
  });
});

// ── References ──────────────────────────────────────────────────────────────

describe('emitCppScopeCaptures — references', () => {
  it('captures free call', () => {
    const src = 'void f() { foo(); }';
    const m = findMatch(src, (t) => t.includes('@reference.call.free'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('foo');
  });

  it('captures member call (obj.method())', () => {
    const src = 'void f() { obj.method(); }';
    const m = findMatch(src, (t) => t.includes('@reference.call.member'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('method');
  });

  it('captures member call (ptr->method())', () => {
    const src = 'void f() { ptr->method(); }';
    const m = findMatch(src, (t) => t.includes('@reference.call.member'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('method');
  });

  it('captures qualified call (Namespace::func())', () => {
    const src = 'void f() { Foo::bar(); }';
    const m = findMatch(src, (t) => t.includes('@reference.call.qualified'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('bar');
  });

  it('captures field read', () => {
    const src = 'void f() { int x = obj.val; }';
    const m = findMatch(src, (t) => t.includes('@reference.read'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('val');
  });

  it('captures field write', () => {
    const src = 'void f() { obj.val = 42; }';
    const m = findMatch(src, (t) => t.includes('@reference.write'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('val');
  });
});

// ── Type bindings ───────────────────────────────────────────────────────────

describe('emitCppScopeCaptures — type bindings', () => {
  it('captures parameter type binding', () => {
    const src = 'void foo(int x) {}';
    const m = findMatch(src, (t) => t.includes('@type-binding.parameter'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('x');
  });

  it('captures variable type binding', () => {
    const src = 'int x = 42;';
    const m = findMatch(src, (t) => t.includes('@type-binding.assignment'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('x');
  });
});

// ── Arity enrichment ────────────────────────────────────────────────────────

describe('emitCppScopeCaptures — arity enrichment', () => {
  it('enriches function declaration with parameter count', () => {
    const m = findMatch('void foo(int x, int y) {}', (t) =>
      t.includes('@declaration.parameter-count'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('2');
  });

  it('enriches zero-parameter function', () => {
    const m = findMatch('void foo() {}', (t) => t.includes('@declaration.parameter-count'));
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('0');
  });

  it('detects default parameters (required < total)', () => {
    const m = findMatch('void foo(int x, int y = 5) {}', (t) =>
      t.includes('@declaration.required-parameter-count'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.required-parameter-count'].text).toBe('1');
    expect(m!['@declaration.parameter-count'].text).toBe('2');
  });

  it('enriches call reference with arity', () => {
    const src = 'void f() { foo(1, 2, 3); }';
    const m = findMatch(src, (t) => t.includes('@reference.arity'));
    expect(m).toBeDefined();
    expect(m!['@reference.arity'].text).toBe('3');
  });
});

// ── Static / anonymous namespace detection ──────────────────────────────────

describe('emitCppScopeCaptures — file-local linkage', () => {
  beforeEach(() => {
    clearFileLocalNames();
  });

  it('detects static function as file-local', () => {
    emitCppScopeCaptures('static void helper() {}', 'test.cpp');
    expect(isFileLocal('test.cpp', 'helper')).toBe(true);
  });

  it('does not mark non-static function as file-local', () => {
    emitCppScopeCaptures('void helper() {}', 'test.cpp');
    expect(isFileLocal('test.cpp', 'helper')).toBe(false);
  });

  it('detects function in anonymous namespace as file-local', () => {
    emitCppScopeCaptures('namespace { void helper() {} }', 'test.cpp');
    expect(isFileLocal('test.cpp', 'helper')).toBe(true);
  });

  it('does not mark function in named namespace as file-local', () => {
    emitCppScopeCaptures('namespace foo { void helper() {} }', 'test.cpp');
    expect(isFileLocal('test.cpp', 'helper')).toBe(false);
  });
});
