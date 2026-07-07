/**
 * Pins the FastAPI/route decorator argument capture in `PYTHON_QUERIES` (#2391).
 *
 * The parse worker branches on exactly these captures to decide a route's path:
 *   • `decorator.arg_str` present  → string-literal path (routePath = the content,
 *     or '' for the empty literal `""` which has no `string_content`);
 *   • `decorator.arg_expr` present → non-literal (identifier / `+`-concat) →
 *     resolved cross-file by the constant resolver;
 *   • neither                      → no capturable path arg (attribute access,
 *     no-arg decorator) → the worker skips it (never a phantom `POST /`).
 *
 * A regression in the query — e.g. dropping the empty-literal case or matching a
 * keyword argument instead of the first positional — silently mis-indexes routes,
 * so it must fail here first.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { PYTHON_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';

const parser = new Parser();
parser.setLanguage(Python);
const query = new Parser.Query(Python, PYTHON_QUERIES);

/** Capture name → node text, for the single decorator in `src`. */
function decoratorCaptures(src: string): Record<string, string> {
  const matches = query.matches(parser.parse(src).rootNode);
  const out: Record<string, string> = {};
  for (const m of matches) {
    const hasDecorator = m.captures.some((c) => c.name === 'decorator');
    if (!hasDecorator) continue;
    for (const c of m.captures) out[c.name] = c.node.text;
  }
  return out;
}

describe('PYTHON_QUERIES decorator arg capture (#2391)', () => {
  it('captures a string-literal path via decorator.arg (quote-free)', () => {
    const caps = decoratorCaptures('@router.get("/x")\ndef f(): pass\n');
    expect(caps['decorator.arg']).toBe('/x');
    expect(caps['decorator.arg_expr']).toBeUndefined();
  });

  it('captures the empty-literal path via arg_str with no arg content', () => {
    const caps = decoratorCaptures('@router.get("")\ndef f(): pass\n');
    expect(caps['decorator.arg_str']).toBe('""');
    expect(caps['decorator.arg']).toBeUndefined();
    expect(caps['decorator.arg_expr']).toBeUndefined();
  });

  it('captures a bare constant name via decorator.arg_expr', () => {
    const caps = decoratorCaptures('@router.post(API_V1_WIDGETS_GET)\ndef f(): pass\n');
    expect(caps['decorator.arg_expr']).toBe('API_V1_WIDGETS_GET');
    expect(caps['decorator.arg']).toBeUndefined();
  });

  it('captures a + concatenation via decorator.arg_expr', () => {
    const caps = decoratorCaptures('@router.put(API_V1 + "/widgets")\ndef f(): pass\n');
    expect(caps['decorator.arg_expr']).toBe('API_V1 + "/widgets"');
  });

  it('captures the FIRST positional arg, ignoring keyword args', () => {
    const strCaps = decoratorCaptures('@router.get("/x", response_model=Foo)\ndef f(): pass\n');
    expect(strCaps['decorator.arg']).toBe('/x');
    const exprCaps = decoratorCaptures('@router.post(NAME, status_code=201)\ndef f(): pass\n');
    expect(exprCaps['decorator.arg_expr']).toBe('NAME');
  });

  it('captures neither for an attribute-access arg (skip floor)', () => {
    const caps = decoratorCaptures('@router.get(settings.PATH)\ndef f(): pass\n');
    expect(caps['decorator.arg_str']).toBeUndefined();
    expect(caps['decorator.arg_expr']).toBeUndefined();
    expect(caps['decorator']).toContain('settings.PATH');
  });

  it('still matches a no-arg decorator (tool detection preserved)', () => {
    const caps = decoratorCaptures('@app.tool()\ndef f(): pass\n');
    expect(caps['decorator.name']).toBe('tool');
    expect(caps['decorator.arg_str']).toBeUndefined();
    expect(caps['decorator.arg_expr']).toBeUndefined();
  });
});
