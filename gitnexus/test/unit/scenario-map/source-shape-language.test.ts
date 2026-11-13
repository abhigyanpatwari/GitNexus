import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { EXT_LANG, languageOf } from '../../../tools/scenario-map/facet/source-shape.js';

describe('source-shape language detection: R', () => {
  it('names R from a SupportedLanguages reference', () => {
    expect(languageOf('run(SupportedLanguages.R, src)', 'test/unit/x.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
  });

  it('names R from a file-name literal, in either extension case', () => {
    expect(languageOf('write(f)', 'test/unit/x.test.ts', ['R/a.R'])).toBe(SupportedLanguages.R);
    expect(languageOf('write(f)', 'test/unit/x.test.ts', ['script.r'])).toBe(SupportedLanguages.R);
    expect(EXT_LANG.get('R')).toBe(SupportedLanguages.R);
  });

  it('names R from the test path, and leaves unrelated paths alone', () => {
    expect(languageOf('run()', 'gitnexus/test/unit/r-lexical-names.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
    expect(languageOf('run()', 'gitnexus/test/unit/scope-resolution/r/x.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
    expect(languageOf('run()', 'gitnexus/test/unit/receiver.test.ts', [])).toBeNull();
  });
});
