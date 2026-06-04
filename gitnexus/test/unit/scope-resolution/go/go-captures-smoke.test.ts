import { describe, expect, it } from 'vitest';
import { emitGoScopeCaptures } from '../../../../src/core/ingestion/languages/go/index.js';

const tagNames = (matches: readonly Record<string, unknown>[]) =>
  matches.flatMap((m) => Object.keys(m));

describe('Go scope captures — smoke', () => {
  it('emits grouped imports once per import spec', () => {
    const src = `
package main

import (
  "fmt"
  "os"
)
`;
    const matches = emitGoScopeCaptures(src, 'main.go');
    const imports = matches
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => m['@import.source']!.text);

    expect(imports).toEqual(['fmt', 'os']);
  });

  it('emits module, struct, interface, function, method, import, call, read, write captures', () => {
    const src = `
package main

import (
  "example.com/app/internal/models"
  util "example.com/app/internal/util"
)

type User struct { Name string }
type Saver interface { Save() }

func NewUser(name string) *User { return &User{Name: name} }

func (u *User) Save(prefix string) { util.Log(prefix); models.Touch() }

func main() {
  u := NewUser("alice")
  u.Save("hello")
  fmt.Println(u.Name)
  u.Name = "bob"
}
`;
    const matches = emitGoScopeCaptures(src, 'cmd/main.go');
    const tags = tagNames(matches);

    expect(tags).toContain('@scope.module');
    expect(tags).toContain('@scope.class');
    expect(tags).toContain('@scope.function');
    expect(tags).toContain('@declaration.struct');
    expect(tags).toContain('@declaration.interface');
    expect(tags).toContain('@declaration.function');
    expect(tags).toContain('@declaration.method');
    expect(tags).toContain('@import.statement');
    expect(tags).toContain('@reference.call.free');
    expect(tags).toContain('@reference.call.member');
    expect(tags).toContain('@reference.call.constructor');
    expect(tags).toContain('@reference.read');
    expect(tags).toContain('@reference.write');
  });

  // ── Edge shapes the #1915 captured-node refactor reasons about but no
  //    lang-resolution fixture exercises (issue #1848 follow-up U2). ──

  it('synthesizes a receiver for a method but not for a func_literal scope', () => {
    // Source has BOTH a real method and a closure. A weak "no @type-binding.self
    // anywhere" assertion would pass even if the method_declaration receiver
    // branch regressed (a closure-only fixture has none to lose); asserting the
    // method's receiver IS present catches that regression.
    const src = `
package main

type User struct{ Name string }

func (u *User) Save() { _ = u.Name }

func main() {
  f := func() int { return 1 }
  _ = f()
}
`;
    const matches = emitGoScopeCaptures(src, 'main.go');
    // The closure is still captured as a @scope.function...
    expect(matches.some((m) => m['@scope.function']?.text.startsWith('func()'))).toBe(true);
    // ...and the method's receiver self-binding is synthesized with its raw pointer shape...
    const selves = matches.filter((m) => m['@type-binding.self'] !== undefined);
    expect(selves).toHaveLength(1); // exactly one — from the method, not the closure
    expect(selves[0]!['@type-binding.name']?.text).toBe('u');
    expect(selves[0]!['@type-binding.type']?.text).toBe('*User');
  });

  it('does not drop a var-form type assertion binding', () => {
    // `var x int = e.(T)` anchors on a var_declaration, not a short_var_declaration,
    // so isRawMultiAssignTypeBinding must NOT filter it (old findNodeAtRange path
    // returned null -> false; the new anchor.type guard reproduces that).
    const src = `
package main

func main() {
  var x int = any(1).(int)
  _ = x
}
`;
    const assertion = emitGoScopeCaptures(src, 'main.go').find(
      (m) => m['@type-binding.assertion'] !== undefined,
    );
    expect(assertion).toBeDefined();
    expect(assertion!['@type-binding.name']?.text).toBe('x');
  });

  it('does not drop a var-form call-return binding', () => {
    const src = `
package main

func NewThing() int { return 1 }

func main() {
  var y = NewThing()
  _ = y
}
`;
    const callReturn = emitGoScopeCaptures(src, 'main.go').find(
      (m) => m['@type-binding.call-return'] !== undefined,
    );
    expect(callReturn).toBeDefined();
    expect(callReturn!['@type-binding.name']?.text).toBe('y');
  });

  it('resolves a single unparenthesized import the same as a grouped one', () => {
    // Exercises resolveImportNode's no-import_spec_list parent chain. NOTE: not
    // redundant with go-imports.test.ts, which calls splitGoImportStatement
    // directly and bypasses captures.ts / resolveImportNode.
    const single = emitGoScopeCaptures(
      `
package main

import "fmt"

func main() { fmt.Println() }
`,
      'main.go',
    );
    const sources = single
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => m['@import.source']!.text);
    expect(sources).toEqual(['fmt']);
  });

  it('captures a generic function declaration', () => {
    const src = `
package main

func Map[T any](x T) T { return x }
`;
    const decl = emitGoScopeCaptures(src, 'main.go').find(
      (m) => m['@declaration.function'] !== undefined,
    );
    expect(decl).toBeDefined();
    expect(decl!['@declaration.name']?.text).toBe('Map');
  });

  it('expands grouped named return types into separate return values', () => {
    const src = `
package main

type Pairer interface {
  Pair() (a, b int)
}
`;
    const matches = emitGoScopeCaptures(src, 'main.go');
    const pairDecl = matches.find(
      (m) => m['@declaration.method'] !== undefined && m['@declaration.name']?.text === 'Pair',
    );

    expect(pairDecl?.['@declaration.return-type']?.text).toBe('(int, int)');
  });

  it('captures interface method return signatures for structural matching', () => {
    const src = `
package main

type Shapes interface {
  Touch()
  Close() error
  Pair() (int, error)
  NamedPair() (a, b int)
}
`;
    const methods = emitGoScopeCaptures(src, 'main.go')
      .filter((m) => m['@declaration.method'] !== undefined)
      .map((m) => ({
        name: m['@declaration.name']?.text,
        returns: m['@declaration.return-type']?.text,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    expect(methods).toEqual([
      { name: 'Close', returns: 'error' },
      { name: 'NamedPair', returns: '(int, int)' },
      { name: 'Pair', returns: '(int, error)' },
      { name: 'Touch', returns: undefined },
    ]);
  });
});
