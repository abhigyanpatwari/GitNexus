import { describe, expect, it } from 'vitest';
import { preprocessSwiftConditionalDirectives } from '../../src/core/ingestion/languages/swift/conditional-directive-preprocess.js';

describe('Swift conditional-directive preprocessing', () => {
  it('blanks only indented conditional directives, including conditions and comments', () => {
    const source = [
      '#if os(macOS)',
      'class TopLevel {}',
      '#endif',
      'class Outer {',
      '  #if os(iOS) // platform branch',
      '  enum A { case x }',
      '\t#elseif DEBUG && canImport(UIKit) // fallback',
      '  enum B { case y }',
      '  #else',
      '  enum C { case z }',
      '  #endif // end branch',
      '}',
    ].join('\n');

    const rewritten = preprocessSwiftConditionalDirectives(source);
    const lines = rewritten.split('\n');
    const sourceLines = source.split('\n');

    expect(lines[0]).toBe('#if os(macOS)');
    expect(lines[2]).toBe('#endif');
    // Widths come from the SOURCE line, so a wrong-length blank still fails.
    for (const line of [4, 6, 8, 10]) {
      expect(lines[line]).toBe(''.padEnd(sourceLines[line]!.length, ' '));
    }
    expect(lines[5]).toBe('  enum A { case x }');
    expect(lines[11]).toBe('}');
  });

  it('preserves JavaScript string length and newline count', () => {
    const source = '#if DEBUG\nclass Outer {\n  #else\n}\n#endif\n';
    const rewritten = preprocessSwiftConditionalDirectives(source);

    expect(rewritten).toHaveLength(source.length);
    expect(rewritten.match(/\n/g)?.length ?? 0).toBe(source.match(/\n/g)?.length ?? 0);
    expect(rewritten.slice(0, '#if DEBUG'.length)).toBe('#if DEBUG');
  });

  it('returns directive-free Swift source unchanged', () => {
    const source = 'class Plain {\n  var value: Int = 0\n  func read() -> Int { value }\n}\n';

    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('preserves CRLF line endings and offsets', () => {
    const source = 'class Outer {\r\n\t#if os(iOS)\r\n\tenum A { case x }\r\n\t#endif\r\n}\r\n';
    const rewritten = preprocessSwiftConditionalDirectives(source);

    expect(rewritten).toHaveLength(source.length);
    expect(rewritten.match(/\r\n/g)?.length ?? 0).toBe(source.match(/\r\n/g)?.length ?? 0);
    expect(rewritten.indexOf('enum A')).toBe(source.indexOf('enum A'));
    expect(rewritten).toContain('          \r\n');
    expect(rewritten).toContain('      \r\n');
    expect(rewritten).toContain('\tenum A { case x }\r\n');
  });

  it('leaves regular and raw multiline string interiors byte-identical', () => {
    const source = [
      'struct Strings {',
      '  let regular = """',
      '  #if os(iOS)',
      '  #elseif DEBUG',
      '  #else',
      '  #endif',
      '  """',
      '  #if REAL_DIRECTIVE',
      '  let between = true',
      '  #endif',
      '  let raw = #"""',
      '  #if raw(iOS)',
      '  #elseif raw(DEBUG)',
      '  #else',
      '  #endif',
      '  """#',
      '  let doubleRaw = ##"""',
      '  #if double-raw-string-data',
      '  #endif',
      '  """##',
      '}',
    ].join('\n');

    const rewritten = preprocessSwiftConditionalDirectives(source);
    const sourceLines = source.split('\n');
    const rewrittenLines = rewritten.split('\n');

    expect(rewritten).toHaveLength(source.length);
    for (const line of [2, 3, 4, 5, 11, 12, 13, 14, 17, 18]) {
      expect(rewrittenLines[line]).toBe(sourceLines[line]);
    }
    for (const line of [7, 9]) {
      expect(rewrittenLines[line]).toBe(''.padEnd(sourceLines[line]!.length, ' '));
    }
  });

  it('does not let an unterminated multiline string blank later lines', () => {
    const source = ['let text = """', '  #if this-is-string-data', '  still string data'].join(
      '\n',
    );

    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('leaves non-conditional hash directives untouched', () => {
    const source = [
      'class Directives {',
      '  #warning("warning")',
      '  #error("error")',
      '  #available(iOS 17, *)',
      '  #selector(getter: Directives.value)',
      '  #if DEBUG',
      '  #endif',
      '}',
    ].join('\n');
    const rewritten = preprocessSwiftConditionalDirectives(source);

    expect(rewritten.split('\n').slice(1, 5)).toEqual(source.split('\n').slice(1, 5));
    expect(rewritten.split('\n')[5]).toBe(''.padEnd(source.split('\n')[5]!.length, ' '));
    expect(rewritten.split('\n')[6]).toBe(''.padEnd(source.split('\n')[6]!.length, ' '));
  });

  it('keeps nested block comments out of string state and never blanks inside them', () => {
    const source = [
      '/*',
      '  #if in-comment',
      '  /* nested comment */',
      '  #endif',
      '*/',
      'let text = """',
      '  #if in-string',
      '"""',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[1]).toBe(sourceLines[1]);
    expect(rewrittenLines[3]).toBe(sourceLines[3]);
    expect(rewrittenLines[6]).toBe('  #if in-string');
  });

  it('keeps a block-comment terminator that shares its line with a directive', () => {
    const source = [
      'class Foo {',
      '  /* temporarily disabled:',
      '  #if DEBUG',
      '  func f() {}',
      '  #endif */',
      '  func g() {}',
      '}',
    ].join('\n');

    // Blanking `  #endif */` would un-terminate the comment and swallow `g()`.
    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('blanks a column-zero directive nested inside a class body', () => {
    const source = [
      'class Outer {',
      '  enum A { case x }',
      '#if os(iOS)',
      '  enum B { case y }',
      '#endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[2]).toBe(''.padEnd(sourceLines[2]!.length, ' '));
    expect(rewrittenLines[4]).toBe(''.padEnd(sourceLines[4]!.length, ' '));
    expect(rewrittenLines[1]).toBe(sourceLines[1]);
  });

  it('leaves an indented directive that is still at file scope intact', () => {
    const source = ['  #if DEBUG', '  struct Debugged {}', '  #endif', ''].join('\n');

    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('recognizes non-ASCII indentation and a leading byte-order mark', () => {
    const source = ['class Outer {', ' #if os(iOS)', '  enum A { case x }', '　#endif', '}'].join(
      '\n',
    );
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[1]).toBe(''.padEnd(sourceLines[1]!.length, ' '));
    expect(rewrittenLines[3]).toBe(''.padEnd(sourceLines[3]!.length, ' '));

    const bomSource = `﻿class Outer {\n  #if os(iOS)\n  enum A { case x }\n  #endif\n}\n`;
    const bomLines = preprocessSwiftConditionalDirectives(bomSource).split('\n');
    expect(bomLines[1]).toBe(''.padEnd('  #if os(iOS)'.length, ' '));
  });

  it('treats a bare carriage return as a line terminator', () => {
    const source = 'class Outer {\r  #if os(iOS)\r  enum A { case x }\r  #endif\r}\r';
    const rewritten = preprocessSwiftConditionalDirectives(source);

    expect(rewritten).toHaveLength(source.length);
    expect(rewritten.split('\r')[1]).toBe(''.padEnd('  #if os(iOS)'.length, ' '));
    expect(rewritten.split('\r')[2]).toBe('  enum A { case x }');
  });

  it('refuses to blank a group whose branches split a declaration header', () => {
    const source = [
      'class NetworkClient {',
      '  #if swift(>=5.5)',
      '  func fetch() async {',
      '  #else',
      '  func fetch() {',
      '  #endif',
      '    perform()',
      '  }',
      '}',
      'struct SessionStore {}',
    ].join('\n');

    // Both branch bodies open a brace and only one closes; blanking would leave
    // `NetworkClient` unterminated and re-parent `SessionStore` under it.
    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('blanks nested balanced groups at every level', () => {
    const source = [
      'class Outer {',
      '  #if os(iOS)',
      '  func inner() {',
      '    #if DEBUG',
      '    log()',
      '    #endif',
      '  }',
      '  #endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    for (const line of [1, 3, 5, 7]) {
      expect(rewrittenLines[line]).toBe(''.padEnd(sourceLines[line]!.length, ' '));
    }
    expect(rewrittenLines[4]).toBe(sourceLines[4]);
  });

  it('lets an unbalanced nested group also block its enclosing group', () => {
    const source = [
      'class Outer {',
      '  #if os(iOS)',
      '  func inner() {',
      '    #if DEBUG',
      '    if x {',
      '    #else',
      '    if y {',
      '    #endif',
      '      log()',
      '    }',
      '  }',
      '  #endif',
      '}',
    ].join('\n');

    // Both `if` branches survive blanking, so the enclosing branch is +1 too.
    // Conservative propagation degrades the whole nest to pre-fix behavior.
    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });

  it('does not wedge on an escaped triple quote inside a multiline string', () => {
    const source = [
      'class Outer {',
      '  let text = """',
      '  escaped \\""" still string data',
      '  #if in-string',
      '  """',
      '  #if REAL_DIRECTIVE',
      '  func after() {}',
      '  #endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[3]).toBe(sourceLines[3]);
    expect(rewrittenLines[5]).toBe(''.padEnd(sourceLines[5]!.length, ' '));
    expect(rewrittenLines[7]).toBe(''.padEnd(sourceLines[7]!.length, ' '));
  });

  it('closes a plain multiline string whose terminator is followed by a pound', () => {
    const source = [
      'class Outer {',
      '  let text = """',
      '  body',
      '  """#hashAfterClose',
      '  #if REAL_DIRECTIVE',
      '  func after() {}',
      '  #endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[4]).toBe(''.padEnd(sourceLines[4]!.length, ' '));
    expect(rewrittenLines[6]).toBe(''.padEnd(sourceLines[6]!.length, ' '));
  });

  it('closes a raw multiline string terminated by extra pounds', () => {
    const source = [
      'class Outer {',
      '  let raw = #"""',
      '  body',
      '  """##',
      '  #if REAL_DIRECTIVE',
      '  func after() {}',
      '  #endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[4]).toBe(''.padEnd(sourceLines[4]!.length, ' '));
    expect(rewrittenLines[6]).toBe(''.padEnd(sourceLines[6]!.length, ' '));
  });

  it('does not let an extended regex literal open a phantom block comment', () => {
    const source = [
      'class Outer {',
      '  let pattern = #/a/*b/#',
      '  #if REAL_DIRECTIVE',
      '  func after() {}',
      '  #endif',
      '}',
    ].join('\n');
    const sourceLines = source.split('\n');
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[2]).toBe(''.padEnd(sourceLines[2]!.length, ' '));
    expect(rewrittenLines[4]).toBe(''.padEnd(sourceLines[4]!.length, ' '));
  });

  it('stays linear on a long run of bare pound signs', () => {
    // The pre-fix scanner re-walked the whole run at every index: ~10.6s for
    // n=64000. The bound is a per-test timeout rather than a measured
    // elapsed-time assertion; the fixed scanner runs this in ~1ms.
    const source = `class Outer {\n  let s = ${'#'.repeat(64000)}\n  #if REAL_DIRECTIVE\n  func after() {}\n  #endif\n}\n`;
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[2]).toBe(''.padEnd('  #if REAL_DIRECTIVE'.length, ' '));
    expect(rewrittenLines[4]).toBe(''.padEnd('  #endif'.length, ' '));
  }, 2000);

  it('preserves JavaScript length on a directive carrying non-ASCII comment text', () => {
    const source = ['class Outer {', '  #if os(iOS) // 日本語 🔥', '  #endif', '}'].join('\n');
    const sourceLines = source.split('\n');
    const rewritten = preprocessSwiftConditionalDirectives(source);

    // UTF-16 length is preserved; UTF-8 byte length is not (56 -> 48).
    // Documented as safe because no consumer slices the original bytes by
    // `startIndex` — node-tree-sitter reports UTF-16 code-unit indices.
    expect(rewritten).toHaveLength(source.length);
    expect(rewritten.split('\n')[1]).toBe(''.padEnd(sourceLines[1]!.length, ' '));
    expect(Buffer.byteLength(source, 'utf8')).toBe(56);
    expect(Buffer.byteLength(rewritten, 'utf8')).toBe(48);
  });

  it('is idempotent', () => {
    const source = ['class Outer {', '  #if os(iOS)', '  enum A { case x }', '  #endif', '}'].join(
      '\n',
    );
    const once = preprocessSwiftConditionalDirectives(source);

    expect(preprocessSwiftConditionalDirectives(once)).toBe(once);
  });

  it('leaves an unmatched directive untouched', () => {
    const source = ['class Outer {', '  #endif', '  #if NEVER_CLOSED', '}'].join('\n');

    expect(preprocessSwiftConditionalDirectives(source)).toBe(source);
  });
});
