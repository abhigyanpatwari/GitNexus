/**
 * Unit tests for C scope query + captures orchestrator.
 *
 * Pins the capture-tag vocabulary + range shape for every construct
 * the scope-resolution pipeline reads. Runs against tree-sitter-c
 * so it catches grammar drift before the integration parity gate does.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { emitCScopeCaptures } from '../../../../src/core/ingestion/languages/c/captures.js';
import {
  clearStaticNames,
  isStaticName,
} from '../../../../src/core/ingestion/languages/c/static-linkage.js';

function tagsFor(src: string, filePath = 'test.c'): string[][] {
  const matches = emitCScopeCaptures(src, filePath);
  return matches.map((m) => Object.keys(m).sort());
}

function findMatch(src: string, predicate: (tags: string[]) => boolean, filePath = 'test.c') {
  const matches = emitCScopeCaptures(src, filePath);
  return matches.find((m) => predicate(Object.keys(m)));
}

function allMatches(src: string, predicate: (tags: string[]) => boolean, filePath = 'test.c') {
  const matches = emitCScopeCaptures(src, filePath);
  return matches.filter((m) => predicate(Object.keys(m)));
}

describe('emitCScopeCaptures — scopes', () => {
  it('captures translation_unit as @scope.module', () => {
    const all = tagsFor('int x = 1;');
    expect(all.some((t) => t.includes('@scope.module'))).toBe(true);
  });

  it('captures struct_specifier as @scope.class', () => {
    const all = tagsFor('struct Point { int x; int y; };');
    expect(all.some((t) => t.includes('@scope.class'))).toBe(true);
  });

  it('captures union_specifier as @scope.class', () => {
    const all = tagsFor('union Data { int i; float f; };');
    expect(all.some((t) => t.includes('@scope.class'))).toBe(true);
  });

  it('captures function_definition as @scope.function', () => {
    const all = tagsFor('void foo(void) { }');
    expect(all.some((t) => t.includes('@scope.function'))).toBe(true);
  });

  it('captures block-level scopes (if, for, while, do, switch, case)', () => {
    const src = `
      void f(void) {
        if (1) { }
        for (;;) { }
        while (1) { }
        do { } while (0);
        switch (0) { case 0: break; }
      }
    `;
    const all = tagsFor(src);
    const blocks = all.filter((t) => t.includes('@scope.block'));
    // compound_statement + if + for + while + do + switch + case = at least 6 blocks
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });
});

describe('emitCScopeCaptures — struct declarations', () => {
  it('captures named struct with @declaration.struct', () => {
    const m = findMatch('struct User { int age; };', (t) => t.includes('@declaration.struct'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('User');
  });

  it('captures typedef struct with @declaration.struct (not typedef)', () => {
    const m = findMatch('typedef struct { int age; } User;', (t) =>
      t.includes('@declaration.struct'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('User');
  });

  it('suppresses @declaration.typedef when struct already captured same range', () => {
    const matches = emitCScopeCaptures('typedef struct { int age; } User;', 'test.c');
    const typedefs = matches.filter((m) => '@declaration.typedef' in m);
    expect(typedefs).toHaveLength(0);
  });
});

describe('emitCScopeCaptures — union declarations', () => {
  it('captures named union with @declaration.union', () => {
    const m = findMatch('union Data { int i; float f; };', (t) => t.includes('@declaration.union'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Data');
  });

  it('captures typedef union with @declaration.union', () => {
    const m = findMatch('typedef union { int i; float f; } Value;', (t) =>
      t.includes('@declaration.union'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Value');
  });
});

describe('emitCScopeCaptures — enum declarations', () => {
  it('captures enum with @declaration.enum', () => {
    const m = findMatch('enum Color { RED, GREEN, BLUE };', (t) => t.includes('@declaration.enum'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Color');
  });

  it('captures enum constants as @declaration.const', () => {
    const matches = allMatches('enum Color { RED, GREEN, BLUE };', (t) =>
      t.includes('@declaration.const'),
    );
    const names = matches.map((m) => m['@declaration.name'].text);
    expect(names).toContain('RED');
    expect(names).toContain('GREEN');
    expect(names).toContain('BLUE');
  });
});

describe('emitCScopeCaptures — function declarations', () => {
  it('captures function definition with @declaration.function', () => {
    const m = findMatch('int add(int a, int b) { return a + b; }', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('add');
  });

  it('captures function prototype (declaration) with @declaration.function', () => {
    const m = findMatch('int add(int a, int b);', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('add');
  });

  it('captures pointer-return function definition', () => {
    const m = findMatch('int *create(void) { return 0; }', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('create');
  });

  it('captures pointer-return function prototype', () => {
    const m = findMatch('char *get_name(void);', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('get_name');
  });
});

describe('emitCScopeCaptures — other declarations', () => {
  it('captures typedef as @declaration.typedef', () => {
    const m = findMatch('typedef int MyInt;', (t) => t.includes('@declaration.typedef'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('MyInt');
  });

  it('captures function pointer typedef as @declaration.typedef', () => {
    const m = findMatch('typedef void (*callback)(int, int);', (t) =>
      t.includes('@declaration.typedef'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('callback');
  });

  it('captures struct field as @declaration.field', () => {
    const m = findMatch('struct P { int x; };', (t) => t.includes('@declaration.field'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('x');
  });

  it('captures pointer struct field as @declaration.field', () => {
    const m = findMatch('struct N { struct N *next; };', (t) => t.includes('@declaration.field'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('next');
  });

  it('captures variable with initializer as @declaration.variable', () => {
    const m = findMatch('int x = 42;', (t) => t.includes('@declaration.variable'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('x');
  });

  it('captures macro as @declaration.macro', () => {
    const m = findMatch('#define MAX 100', (t) => t.includes('@declaration.macro'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('MAX');
  });

  it('captures function-like macro as @declaration.macro', () => {
    const m = findMatch('#define SQUARE(x) ((x) * (x))', (t) => t.includes('@declaration.macro'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('SQUARE');
  });
});

describe('emitCScopeCaptures — imports', () => {
  it('captures local #include as @import.statement with source', () => {
    const m = findMatch('#include "header.h"', (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('header.h');
    expect(m!['@import.kind'].text).toBe('wildcard');
  });

  it('captures system #include with @import.system tag', () => {
    const m = findMatch('#include <stdio.h>', (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.system']).toBeDefined();
  });

  it('captures nested path includes', () => {
    const m = findMatch('#include "utils/helpers.h"', (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('utils/helpers.h');
  });
});

describe('emitCScopeCaptures — references', () => {
  it('captures free call invocations', () => {
    const m = findMatch('void f(void) { foo(); }', (t) => t.includes('@reference.call.free'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('foo');
  });

  it('captures member call via pointer (ptr->func())', () => {
    const m = findMatch('void f(struct S *s) { s->method(); }', (t) =>
      t.includes('@reference.call.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('method');
  });

  it('captures field reads', () => {
    const m = findMatch('void f(struct S *s) { int x = s->field; }', (t) =>
      t.includes('@reference.read'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('field');
  });

  it('captures field writes (assignment)', () => {
    const m = findMatch('void f(struct S *s) { s->field = 1; }', (t) =>
      t.includes('@reference.write'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('field');
  });
});

describe('emitCScopeCaptures — type bindings', () => {
  it('captures parameter type annotations', () => {
    const m = findMatch('void f(int x) { }', (t) => t.includes('@type-binding.parameter'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('x');
  });

  it('captures variable type bindings', () => {
    const m = findMatch('void f(void) { int x = 1; }', (t) =>
      t.includes('@type-binding.assignment'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('x');
  });
});

describe('emitCScopeCaptures — arity metadata', () => {
  it('synthesizes parameter-count on function definitions', () => {
    const m = findMatch('int add(int a, int b) { return a + b; }', (t) =>
      t.includes('@declaration.parameter-count'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('2');
  });

  it('synthesizes parameter-types on function definitions', () => {
    const m = findMatch('int add(int a, float b) { return 0; }', (t) =>
      t.includes('@declaration.parameter-types'),
    );
    expect(m).toBeDefined();
    const types = JSON.parse(m!['@declaration.parameter-types'].text);
    expect(types).toEqual(['int', 'float']);
  });

  it('(void) parameter list yields zero parameters', () => {
    const m = findMatch('void f(void) { }', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('0');
    expect(m!['@declaration.required-parameter-count'].text).toBe('0');
  });

  it('variadic function has undefined parameter-count but defined required-parameter-count', () => {
    const m = findMatch('int printf(const char *fmt, ...) { return 0; }', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    // variadic → parameterCount is undefined (not emitted)
    expect(m!['@declaration.parameter-count']).toBeUndefined();
    expect(m!['@declaration.required-parameter-count'].text).toBe('1');
  });

  it('synthesizes arity on call references', () => {
    const m = findMatch(
      'void f(void) { add(1, 2); }',
      (t) => t.includes('@reference.call.free') && t.includes('@reference.arity'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.arity'].text).toBe('2');
  });

  it('zero-argument call has arity 0', () => {
    const m = findMatch(
      'void f(void) { init(); }',
      (t) => t.includes('@reference.call.free') && t.includes('@reference.arity'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.arity'].text).toBe('0');
  });
});

describe('emitCScopeCaptures — static storage class', () => {
  beforeEach(() => {
    clearStaticNames();
  });

  it('marks static function definitions as file-local', () => {
    emitCScopeCaptures('static int helper(void) { return 0; }', 'a.c');
    expect(isStaticName('a.c', 'helper')).toBe(true);
  });

  it('does not mark non-static function definitions as file-local', () => {
    emitCScopeCaptures('int helper(void) { return 0; }', 'a.c');
    expect(isStaticName('a.c', 'helper')).toBe(false);
  });

  it('marks static function prototypes as file-local', () => {
    emitCScopeCaptures('static int helper(int x);', 'a.c');
    expect(isStaticName('a.c', 'helper')).toBe(true);
  });

  it('static functions are scoped to their file', () => {
    emitCScopeCaptures('static int helper(void) { return 0; }', 'a.c');
    emitCScopeCaptures('int helper(void) { return 1; }', 'b.c');
    expect(isStaticName('a.c', 'helper')).toBe(true);
    expect(isStaticName('b.c', 'helper')).toBe(false);
  });

  it('static pointer-return functions are detected', () => {
    emitCScopeCaptures('static char *get_buffer(void) { return 0; }', 'a.c');
    expect(isStaticName('a.c', 'get_buffer')).toBe(true);
  });
});
