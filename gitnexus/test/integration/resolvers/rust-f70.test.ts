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

  it('scoped struct foo::bar::Baz {} captures Baz as @reference.name', () => {
    const src = `fn f() { let _ = foo::bar::Baz { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(names).toContain('Baz');
  });

  it('turbofish struct Foo::<i32> {} captures Foo as @reference.name', () => {
    const src = `fn f() { let _ = Foo::<i32> { x: 1 }; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const ctors = matches.filter((m) => m['@reference.call.constructor']);
    const names = ctors.map((m) => m['@reference.name']?.text);
    expect(names).toContain('Foo');
  });
});
