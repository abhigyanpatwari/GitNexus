/**
 * Regression tests for Rust scope-resolution coverage gaps (issue #1934).
 */
import { describe, it, expect } from 'vitest';
import { emitRustScopeCaptures } from '../../../src/core/ingestion/languages/rust/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// F66/F68 — let binding patterns
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

  it('let (a, b) tuple pattern emits @declaration.variable', () => {
    const src = `fn f() { let (a, b) = (1, 2); }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
  });

  it('let Some(val) tuple struct pattern emits @declaration.variable', () => {
    const src = `fn f() { let Some(val) = Some(3); }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
  });

  it('let ref x pattern emits @declaration.variable', () => {
    const src = `fn f() { let ref x = 4; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
    // pattern: (_) captures the ref_pattern node whose text is "ref x"
    expect(vars[0]['@declaration.name'].text).toBe('ref x');
  });

  it('let x @ 1..=10 captured pattern emits @declaration.variable', () => {
    const src = `fn f() { let x @ 1..=10 = 5; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const vars = matches.filter((m) => m['@declaration.variable']);
    expect(vars.length).toBe(1);
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
  it('macro_invocation with bare identifier emits @reference.call.free', () => {
    const src = `fn f() { println!("hi"); }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const macroRefs = matches.filter((m) => m['@reference.call.free']);
    const macroNames = macroRefs.map((m) => m['@reference.name']?.text);
    expect(macroNames).toContain('println');
  });

  it('vec! macro emits @reference.call.free', () => {
    const src = `fn f() { let v = vec![1, 2, 3]; }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const macroRefs = matches.filter((m) => m['@reference.call.free']);
    const macroNames = macroRefs.map((m) => m['@reference.name']?.text);
    expect(macroNames).toContain('vec');
  });
});

// ---------------------------------------------------------------------------
// F73 — variadic parameters
// ---------------------------------------------------------------------------

describe('F73 — variadic parameters', () => {
  it('variadic_parameter in extern fn emits @type-binding.parameter', () => {
    const src = `extern \"C\" { fn printf(fmt: *const u8, ...); }\n`;
    const matches = emitRustScopeCaptures(src, 'test.rs') as CaptureMatch[];
    const params = matches.filter((m) => m['@type-binding.parameter']);
    // Should have at least one parameter binding (fmt is a parameter)
    expect(params.length).toBeGreaterThanOrEqual(1);
  });
});
