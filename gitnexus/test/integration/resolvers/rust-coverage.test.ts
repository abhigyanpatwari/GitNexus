/**
 * Regression tests for Rust scope-resolution coverage gaps (issue #1934).
 */
import { describe, it, expect } from 'vitest';
import { emitRustScopeCaptures } from '../../../src/core/ingestion/languages/rust/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// F66/F68 — let binding patterns (identifier-only, works with let mut x)
// ---------------------------------------------------------------------------

describe('F66/F68 — let binding pattern shapes', () => {
  it('bare identifier let binding emits @declaration.variable', () => {
    const src = `fn f() { let x = 1; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
    expect(vars[0]['@declaration.name'].text).toBe('x');
  });

  it('let mut x emits @declaration.variable', () => {
    const src = `fn f() { let mut x = 1; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
    expect(vars[0]['@declaration.name'].text).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// F71 — union declarations
// ---------------------------------------------------------------------------

describe('F71 — union declaration', () => {
  it('union item emits @scope.class and @declaration.struct', () => {
    const src = `union MyUnion { x: i32, y: f64 }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const scopes = matches.filter((m) => m['@scope.class']);
    expect(scopes.length).toBe(1);
    const decls = matches.filter((m) => m['@declaration.struct']);
    expect(decls.length).toBe(1);
    expect(decls[0]['@declaration.name'].text).toBe('MyUnion');
  });
});

// ---------------------------------------------------------------------------
// F72 — macro invocations
// ---------------------------------------------------------------------------

describe('F72 — macro invocations', () => {
  it('macro_invocation with bare identifier emits @reference.macro', () => {
    const src = `fn f() { println!("hi"); }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const macroRefs = matches.filter((m) => m['@reference.macro']);
    const macroNames = macroRefs.map((m) => m['@reference.name']?.text);
    expect(macroNames).toContain('println');
  });

  it('vec! macro emits @reference.macro', () => {
    const src = `fn f() { let v = vec![1, 2, 3]; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const macroRefs = matches.filter((m) => m['@reference.macro']);
    const macroNames = macroRefs.map((m) => m['@reference.name']?.text);
    expect(macroNames).toContain('vec');
  });
});
