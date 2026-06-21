/**
 * Tests for F70 — struct literal constructor calls (issue #1934).
 */
import { describe, it, expect } from 'vitest';
import { emitRustScopeCaptures } from '../../../src/core/ingestion/languages/rust/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

describe('F70 — struct literal constructor calls', () => {
  it('bare struct Foo {} captures Foo as @reference.name', () => {
    const src = `fn f() { let _ = Foo { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    expect(ctors.length).toBe(1);
    expect(ctors[0]['@reference.name'].text).toBe('Foo');
  });

  it('scoped struct foo::bar::Baz {} captures Baz (not the full path)', () => {
    const src = `fn f() { let _ = foo::bar::Baz { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(ctors.length).toBe(1);
    expect(names).toContain('Baz');
    // Guard against regressing to the old wildcard, which captured the path.
    expect(names).not.toContain('foo::bar::Baz');
  });

  it('turbofish struct Foo::<i32> {} captures Foo (not Foo::<i32>)', () => {
    const src = `fn f() { let _ = Foo::<i32> { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(ctors.length).toBe(1);
    expect(names).toContain('Foo');
    expect(names).not.toContain('Foo::<i32>');
  });

  it('scoped + turbofish struct foo::Bar::<i32> {} captures Bar', () => {
    const src = `fn f() { let _ = foo::Bar::<i32> { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(ctors.length).toBe(1);
    expect(names).toContain('Bar');
    expect(names).not.toContain('foo::Bar::<i32>');
  });

  it('crate-scoped struct crate::Foo {} captures Foo', () => {
    const src = `fn f() { let _ = crate::Foo { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(ctors.length).toBe(1);
    expect(names).toContain('Foo');
  });
});
