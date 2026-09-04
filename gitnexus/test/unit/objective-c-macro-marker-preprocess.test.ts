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
});
