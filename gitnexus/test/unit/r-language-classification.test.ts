import { describe, expect, it } from 'vitest';
import { LanguageClassifications, isProductionLanguage } from 'gitnexus-shared';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

// docs/languages/r-provider.md describes R as an experimental provider. The classification
// map is type-forced to contain R but nothing else asserts its value, so a silent
// promotion to 'production' (a governance change) would otherwise go unnoticed.
describe('R language classification', () => {
  it('classifies R as experimental', () => {
    expect(LanguageClassifications[SupportedLanguages.R]).toBe('experimental');
  });

  it('does not treat R as a production language', () => {
    expect(isProductionLanguage(SupportedLanguages.R)).toBe(false);
  });
});
