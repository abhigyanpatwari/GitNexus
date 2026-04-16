/**
 * C# import resolution config.
 * Namespace-based strategy via .csproj configs, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { csharpNamespaceStrategy } from '../csharp.js';

export const csharpImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.CSharp,
  strategies: [csharpNamespaceStrategy, createStandardStrategy(SupportedLanguages.CSharp)],
};
