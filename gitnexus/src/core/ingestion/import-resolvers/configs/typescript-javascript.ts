/**
 * TypeScript / JavaScript / Vue import resolution configs.
 * All use standard resolution — TS/JS with tsconfig path aliases,
 * Vue delegates to TypeScript's resolver.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';

export const typescriptImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.TypeScript,
  strategies: [createStandardStrategy(SupportedLanguages.TypeScript)],
};

export const javascriptImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.JavaScript,
  strategies: [createStandardStrategy(SupportedLanguages.JavaScript)],
};

// Vue SFCs are preprocessed into TypeScript upstream of import resolution,
// so the resolver intentionally runs as TypeScript. `language: Vue` here is
// documentation-only metadata (see `ImportResolutionConfig.language` JSDoc
// and ARCHITECTURE.md §Vue); it is not consumed by `createImportResolver`.
export const vueImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Vue,
  strategies: [createStandardStrategy(SupportedLanguages.TypeScript)],
};
