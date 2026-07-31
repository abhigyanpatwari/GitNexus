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

    expect(lines[0]).toBe('#if os(macOS)');
    expect(lines[2]).toBe('#endif');
    expect(lines[4]).toBe(''.padEnd(lines[4]!.length, ' '));
    expect(lines[6]).toBe(''.padEnd(lines[6]!.length, ' '));
    expect(lines[8]).toBe(''.padEnd(lines[8]!.length, ' '));
    expect(lines[10]).toBe(''.padEnd(lines[10]!.length, ' '));
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

  it('keeps nested block comments out of string state while retaining comment blanking', () => {
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
    const rewrittenLines = preprocessSwiftConditionalDirectives(source).split('\n');

    expect(rewrittenLines[1]).toBe(''.padEnd(source.split('\n')[1]!.length, ' '));
    expect(rewrittenLines[3]).toBe(''.padEnd(source.split('\n')[3]!.length, ' '));
    expect(rewrittenLines[6]).toBe('  #if in-string');
  });
});
