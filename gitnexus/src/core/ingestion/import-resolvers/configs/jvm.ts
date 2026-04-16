/**
 * Java / Kotlin import resolution configs.
 * JVM-specific wildcard/member strategy, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { javaJvmStrategy, kotlinJvmStrategy } from '../jvm.js';

export const javaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Java,
  strategies: [javaJvmStrategy, createStandardStrategy(SupportedLanguages.Java)],
};

export const kotlinImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Kotlin,
  strategies: [kotlinJvmStrategy, createStandardStrategy(SupportedLanguages.Kotlin)],
};
