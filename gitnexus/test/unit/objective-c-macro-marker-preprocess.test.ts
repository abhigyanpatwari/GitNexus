import { describe, expect, it } from 'vitest';
import { preprocessObjectiveCMacroMarkers } from '../../src/core/ingestion/languages/objective-c/macro-marker-preprocess.js';

describe('preprocessObjectiveCMacroMarkers', () => {
  it('elides bare file-scope markers and preserves positions', () => {
    const source = [
      '#define RCT_EXTERN_C_BEGIN',
      '#define RCT_EXTERN_C_END',
      'RCT_EXTERN_C_BEGIN',
      'typedef struct RCTMethodInfo {',
      '  const char *const jsName;',
      '} RCTMethodInfo;',
      'RCT_EXTERN_C_END',
      '@protocol RCTBridgeModule <NSObject>',
      '- (void)run;',
      '@end',
      '',
    ].join('\r\n');

    const normalized = preprocessObjectiveCMacroMarkers(source, 'RCTBridgeModule.h');

    expect(normalized).toHaveLength(source.length);
    expect(normalized.split('\r\n')).toHaveLength(source.split('\r\n').length);
    expect(normalized).toContain('#define RCT_EXTERN_C_BEGIN');
    expect(normalized).toContain('@protocol RCTBridgeModule <NSObject>');
    expect(normalized).toContain(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
    expect(normalized).toContain(' '.repeat('RCT_EXTERN_C_END'.length));
    expect(preprocessObjectiveCMacroMarkers(normalized, 'RCTBridgeModule.h')).toBe(normalized);
  });

  it('leaves non-marker syntax, strings, and comments untouched', () => {
    const source = [
      'void marker(void) {',
      '  RCT_EXTERN_C_BEGIN',
      '}',
      'RCT_EXTERN_C_END()',
      'RCT_EXTERN_C_END;',
      '#define RCT_EXTERN_C_END',
      '#define RCT_MARKER_SEQUENCE \\',
      'RCT_EXTERN_C_END',
      'const char *value = "RCT_EXTERN_C_END";',
      '// RCT_EXTERN_C_END',
      '/*',
      'RCT_EXTERN_C_END',
      '*/',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroMarkers(source, 'Example.m')).toBe(source);
  });

  it('does not rewrite markers inside a continued line comment', () => {
    const source = [
      '// The following token remains part of this comment \\',
      'RCT_EXTERN_C_END',
      'RCT_EXTERN_C_BEGIN',
      '',
    ].join('\n');

    const normalized = preprocessObjectiveCMacroMarkers(source, 'CommentedMarker.h');

    expect(normalized).toHaveLength(source.length);
    expect(normalized).toContain('RCT_EXTERN_C_END');
    expect(normalized.split('\n')[2]).toBe(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
  });

  it('recognizes form feed and vertical tab as preprocessing whitespace', () => {
    const source = [
      '\f#define RCT_EXTERN_C_BEGIN',
      '\v#define RCT_EXTERN_C_END',
      '\fRCT_EXTERN_C_BEGIN',
      '\vRCT_EXTERN_C_END',
      '@protocol RCTBridgeModule <NSObject>',
      '@end',
      '',
    ].join('\n');

    const normalized = preprocessObjectiveCMacroMarkers(source, 'WhitespaceMarkers.h');

    expect(normalized).toHaveLength(source.length);
    expect(normalized).toContain('\f#define RCT_EXTERN_C_BEGIN');
    expect(normalized).toContain('\v#define RCT_EXTERN_C_END');
    expect(normalized.split('\n')[2]).toBe(' '.repeat('\fRCT_EXTERN_C_BEGIN'.length));
    expect(normalized.split('\n')[3]).toBe(' '.repeat('\vRCT_EXTERN_C_END'.length));
    expect(normalized).toContain('@protocol RCTBridgeModule <NSObject>');
  });

  it('preserves directives preceded by comments', () => {
    const source = [
      '/**/ #define RCT_MARKER_SEQUENCE \\',
      'RCT_EXTERN_C_END',
      '/* leading comment',
      ' */ #define RCT_SECOND_SEQUENCE \\',
      'RCT_EXTERN_C_BEGIN',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroMarkers(source, 'CommentDirective.h')).toBe(source);
  });

  it('does not rewrite markers inside a multiline function-like macro invocation', () => {
    const source = ['SOME_MACRO(', 'RCT_EXTERN_C_END', ')', 'RCT_EXTERN_C_BEGIN', ''].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'MultilineMacro.m');

    expect(normalized.split('\n')[1]).toBe('RCT_EXTERN_C_END');
    expect(normalized.split('\n')[3]).toBe(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
  });

  it('does not treat directive replacement braces as file-scope nesting', () => {
    const source = ['#define WRAP {', 'RCT_EXTERN_C_BEGIN', 'RCT_EXTERN_C_END', ''].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'DirectiveBrace.h');

    expect(normalized.split('\n')[0]).toBe('#define WRAP {');
    expect(normalized.split('\n')[1]).toBe(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
    expect(normalized.split('\n')[2]).toBe(' '.repeat('RCT_EXTERN_C_END'.length));
  });

  it('does not rewrite markers inside a block comment opened on a directive line', () => {
    const source = ['#define X /*', 'RCT_EXTERN_C_BEGIN', '*/', 'RCT_EXTERN_C_END', ''].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'DirectiveComment.h');

    expect(normalized.split('\n')[1]).toBe('RCT_EXTERN_C_BEGIN');
    expect(normalized.split('\n')[3]).toBe(' '.repeat('RCT_EXTERN_C_END'.length));
  });

  it('requires a valid identifier start for a bare marker', () => {
    const source = ['123_RCT_EXTERN_C_END', 'RCT_EXTERN_C_END', ''].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'NumericMarker.h');

    expect(normalized.split('\n')[0]).toBe('123_RCT_EXTERN_C_END');
    expect(normalized.split('\n')[1]).toBe(' '.repeat('RCT_EXTERN_C_END'.length));
  });

  it('does not rewrite an object-like macro continued from a spliced statement', () => {
    const source = ['int value = \\', 'FEATURE_VALUE', ';', 'RCT_EXTERN_C_BEGIN', ''].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'SplicedStatement.m');

    expect(normalized.split('\n')[1]).toBe('FEATURE_VALUE');
    expect(normalized.split('\n')[3]).toBe(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
  });

  it('does not rewrite bare macros inside @interface / @protocol / @implementation', () => {
    const source = [
      '@interface Widget',
      'DECLARE_WIDGET_MEMBERS',
      '@end',
      '@protocol WidgetDelegate',
      'DECLARE_WIDGET_DELEGATE',
      '@end',
      '@implementation Widget',
      'DECLARE_WIDGET_IVARS',
      '@end',
      'RCT_EXTERN_C_BEGIN',
      '',
    ].join('\n');
    const normalized = preprocessObjectiveCMacroMarkers(source, 'Widget.h');
    const lines = normalized.split('\n');

    expect(lines[1]).toBe('DECLARE_WIDGET_MEMBERS');
    expect(lines[4]).toBe('DECLARE_WIDGET_DELEGATE');
    expect(lines[7]).toBe('DECLARE_WIDGET_IVARS');
    expect(lines[9]).toBe(' '.repeat('RCT_EXTERN_C_BEGIN'.length));
  });
});
