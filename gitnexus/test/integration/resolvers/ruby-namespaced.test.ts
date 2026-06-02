/**
 * Regression tests for Ruby namespaced class/module definitions (issue #1933 F62).
 *
 * The existing query captures (class) and (module) with name: (constant) only —
 * missing namespaced forms like class Foo::Bar and module Baz::Qux where the
 * name field is a scope_resolution node.
 */
// NOTE: Tests are capture-level only. Graph-node modeling for namespaced
// class/module definitions is a tracked follow-up — the scope-extractor
// doesn't yet handle scope_resolution names end-to-end.
import { describe, it, expect } from 'vitest';
import { emitRubyScopeCaptures } from '../../../src/core/ingestion/languages/ruby/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

describe('Ruby namespaced class/module definitions (F62) — capture-level', () => {
  it('class Foo::Bar captures @declaration.class with tail constant (Bar)', () => {
    const src = `class Foo::Bar
  def bar_method; end
end
`;
    const matches = emitRubyScopeCaptures(src, 'test.rb') as CaptureMatch[];
    const classDecls = matches.filter((m) => m['@declaration.class']);
    expect(classDecls.length).toBe(1);
    expect(classDecls[0]['@declaration.name'].text).toBe('Bar');
  });

  it('module Baz::Qux captures @declaration.trait with tail constant (Qux)', () => {
    const src = `module Baz::Qux
  def qux_method; end
end
`;
    const matches = emitRubyScopeCaptures(src, 'test.rb') as CaptureMatch[];
    const moduleDecls = matches.filter((m) => m['@declaration.trait']);
    expect(moduleDecls.length).toBe(1);
    expect(moduleDecls[0]['@declaration.name'].text).toBe('Qux');
  });

  it('nested chain Outer::Middle::Inner resolves to tail constant (Inner)', () => {
    const src = `class Outer::Middle::Inner
  def inner_method; end
end
`;
    const matches = emitRubyScopeCaptures(src, 'test.rb') as CaptureMatch[];
    const classDecls = matches.filter((m) => m['@declaration.class']);
    expect(classDecls.length).toBe(1);
    expect(classDecls[0]['@declaration.name'].text).toBe('Inner');
  });

  it('bare class Foo still works alongside namespaced class', () => {
    const src = `
class Foo
  def foo_method; end
end

class Foo::Bar
  def bar_method; end
end
`;
    const matches = emitRubyScopeCaptures(src, 'test.rb') as CaptureMatch[];
    const classDecls = matches.filter((m) => m['@declaration.class']);
    expect(classDecls.length).toBe(2);
    const names = classDecls.map((m) => m['@declaration.name'].text).sort();
    expect(names).toEqual(['Bar', 'Foo']);
  });

  it('bare module Baz still works alongside namespaced module', () => {
    const src = `
module Baz
  def baz_method; end
end

module Baz::Qux
  def qux_method; end
end
`;
    const matches = emitRubyScopeCaptures(src, 'test.rb') as CaptureMatch[];
    const moduleDecls = matches.filter((m) => m['@declaration.trait']);
    expect(moduleDecls.length).toBe(2);
    const names = moduleDecls.map((m) => m['@declaration.name'].text).sort();
    expect(names).toEqual(['Baz', 'Qux']);
  });
});
