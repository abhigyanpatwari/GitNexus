import { describe, expect, it } from 'vitest';
import {
  synthesizeGoReceiverBinding,
  synthesizeGoTypeBindings,
  emitGoScopeCaptures,
  interpretGoTypeBinding,
  normalizeGoTypeName,
} from '../../../../src/core/ingestion/languages/go/index.js';
import { getGoParser } from '../../../../src/core/ingestion/languages/go/query.js';

describe('Go receiver binding', () => {
  it('synthesizes receiver type binding for method', () => {
    const src = 'package main\ntype User struct{}\nfunc (u *User) Save() {}';
    const tree = getGoParser().parse(src);
    const methodNode = tree.rootNode.descendantsOfType('method_declaration')[0];
    const result = synthesizeGoReceiverBinding(methodNode as any)!;
    expect(result['@type-binding.self']).toBeDefined();
    expect(result['@type-binding.name']!.text).toBe('u');
    expect(result['@type-binding.type']!.text).toBe('User');
  });

  it('returns null for free function', () => {
    const src = 'package main\nfunc Save() {}';
    const tree = getGoParser().parse(src);
    const fnNode = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(synthesizeGoReceiverBinding(fnNode as any)).toBeNull();
  });
});

describe('Go type binding synthesis — 7 patterns', () => {
  it('synthesizes new() type binding', () => {
    const src = 'package main\nfunc main() {\n  user := new(User)\n}';
    const tree = getGoParser().parse(src);
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const newMatch = matches.find((m) => m['@type-binding.new']);
    expect(newMatch?.['@type-binding.name']?.text).toBe('user');
    expect(newMatch?.['@type-binding.type']?.text).toBe('User');
    const parsed = interpretGoTypeBinding(newMatch!);
    expect(parsed?.rawTypeName).toBe('User');
  });

  it('synthesizes make([]T) type binding', () => {
    const src = 'package main\nfunc main() {\n  sl := make([]User, 0)\n}';
    const tree = getGoParser().parse(src);
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    const makeMatch = matches.find((m) => m['@type-binding.make']);
    expect(makeMatch?.['@type-binding.name']?.text).toBe('sl');
    expect(makeMatch?.['@type-binding.type']?.text).toBe('User');
  });

  it('synthesizes make(map[K]V) type binding', () => {
    const src = 'package main\nfunc main() {\n  m := make(map[string]User)\n}';
    const tree = getGoParser().parse(src);
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    const makeMatch = matches.find((m) => m['@type-binding.make']);
    expect(makeMatch?.['@type-binding.name']?.text).toBe('m');
    expect(makeMatch?.['@type-binding.type']?.text).toBe('User');
  });

  it('supplements qualified type constructor: pkg.Foo{}', () => {
    const src = 'package main\nfunc main() {\n  u := models.User{}\n}';
    const matches = emitGoScopeCaptures(src, 'main.go');
    const qMatch = matches.find(
      (m) => m['@type-binding.constructor'] && m['@type-binding.type']?.text === 'models.User',
    );
    expect(qMatch).toBeDefined();
  });

  it('keeps multi-assignment constructor bindings aligned with RHS positions', () => {
    const src = 'package main\nfunc main() {\n  a, b := 42, X{}\n}';
    const bindings = emitGoScopeCaptures(src, 'main.go')
      .filter((m) => m['@type-binding.name'] !== undefined)
      .map((m) => ({
        name: m['@type-binding.name']!.text,
        type: m['@type-binding.type']!.text,
      }));

    expect(bindings).toContainEqual({ name: 'b', type: 'X' });
    expect(bindings).not.toContainEqual({ name: 'a', type: 'X' });
  });

  it('interprets assertion type binding', () => {
    const result = interpretGoTypeBinding({
      '@type-binding.assertion': {
        name: '@type-binding.assertion',
        text: 's.(User)',
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      },
      '@type-binding.name': {
        name: '@type-binding.name',
        text: 'user',
        range: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      },
      '@type-binding.type': {
        name: '@type-binding.type',
        text: 'User',
        range: { startLine: 1, startCol: 10, endLine: 1, endCol: 14 },
      },
    });
    expect(result?.rawTypeName).toBe('User');
    expect(result?.source).toBe('annotation');
  });

  it('normalizes pointer, slice, map, qualified, generic type names', () => {
    expect(normalizeGoTypeName('*User')).toBe('User');
    expect(normalizeGoTypeName('[]string')).toBe('string');
    expect(normalizeGoTypeName('map[string]int')).toBe('int');
    expect(normalizeGoTypeName('chan int')).toBe('int');
    expect(normalizeGoTypeName('func() error')).toBe('error');
    expect(normalizeGoTypeName('models.User')).toBe('User');
    expect(normalizeGoTypeName('List[User]')).toBe('List');
  });
});

describe('Go type binding — null guard (#1346, #1366)', () => {
  it('does not crash on make(chan T) — channel_type has no matching child', () => {
    const src = 'package main\nfunc main() {\n  ch := make(chan int)\n}';
    const tree = getGoParser().parse(src);
    // Before fix: .find() returned undefined, checked with !== null, crashed
    // accessing .type on undefined.
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    // make(chan T) is not handled (V1 limitation) — should produce no crash
    // and no make-binding, not crash the pipeline.
    const makeMatch = matches.find((m) => m['@type-binding.make']);
    expect(makeMatch).toBeUndefined();
  });

  it('does not crash on new() with no type arguments', () => {
    const src = 'package main\nfunc main() {\n  x := new(complex128)\n  _ = x\n}';
    const tree = getGoParser().parse(src);
    // complex128 is a builtin type_identifier — this should work normally,
    // but tests the path where .find() must not return undefined unchecked.
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    const newMatch = matches.find((m) => m['@type-binding.new']);
    expect(newMatch).toBeDefined();
    expect(newMatch?.['@type-binding.type']?.text).toBe('complex128');
  });

  it('does not crash on make with only generic type arguments', () => {
    const src = 'package main\nfunc main() {\n  ch := make(chan *User)\n}';
    const tree = getGoParser().parse(src);
    // chan *User: sliceOrMap is undefined (channel_type not in ['slice_type','map_type'])
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    expect(matches.find((m) => m['@type-binding.make'])).toBeUndefined();
  });

  it('does not crash on composite literal with embedded struct', () => {
    const src = `package main
type Base struct{ ID int }
type User struct{ Base }
func main() { u := User{Base: Base{ID: 1}} }`;
    const matches = emitGoScopeCaptures(src, 'main.go');
    // Should produce captures without crashing
    expect(matches.length).toBeGreaterThan(0);
  });

  it('does not crash on short var decl with function call (no typeBinding)', () => {
    const src = 'package main\nfunc main() {\n  result := DoSomething()\n}';
    const tree = getGoParser().parse(src);
    // RHS is a call_expression with no new/make — no typeBinding expected
    const matches = synthesizeGoTypeBindings(tree.rootNode as any);
    // Should not crash; may or may not produce bindings depending on the call
    expect(Array.isArray(matches)).toBe(true);
  });
});
