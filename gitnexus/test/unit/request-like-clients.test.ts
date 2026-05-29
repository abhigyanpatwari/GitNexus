import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { isRequestLikeClientLanguage } from '../../src/core/ingestion/request-like-clients.js';

describe('request-like client helpers', () => {
  it('limits request-like import scans to JavaScript-family languages', () => {
    expect(isRequestLikeClientLanguage(SupportedLanguages.JavaScript)).toBe(true);
    expect(isRequestLikeClientLanguage(SupportedLanguages.TypeScript)).toBe(true);
    expect(isRequestLikeClientLanguage(SupportedLanguages.Vue)).toBe(true);

    expect(isRequestLikeClientLanguage(SupportedLanguages.Java)).toBe(false);
    expect(isRequestLikeClientLanguage(SupportedLanguages.Python)).toBe(false);
    expect(isRequestLikeClientLanguage(SupportedLanguages.Go)).toBe(false);
  });
});
