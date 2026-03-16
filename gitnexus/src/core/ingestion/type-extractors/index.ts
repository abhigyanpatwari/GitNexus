/**
 * Per-language type extraction configurations.
 * Assembled here into a dispatch map keyed by SupportedLanguages.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { LanguageTypeConfig } from './types.js';

import { typeConfig as typescriptConfig } from './typescript.js';
import { javaTypeConfig, kotlinTypeConfig } from './jvm.js';
import { typeConfig as csharpConfig } from './csharp.js';
import { typeConfig as goConfig } from './go.js';
import { typeConfig as rustConfig } from './rust.js';
import { typeConfig as pythonConfig } from './python.js';
import { typeConfig as swiftConfig } from './swift.js';
import { typeConfig as cCppConfig } from './c-cpp.js';
import { typeConfig as phpConfig } from './php.js';
import { typeConfig as rubyConfig } from './ruby.js';

export const typeConfigs = {
  [SupportedLanguages.JavaScript]: typescriptConfig,
  [SupportedLanguages.TypeScript]: typescriptConfig,
  [SupportedLanguages.Java]: javaTypeConfig,
  [SupportedLanguages.Kotlin]: kotlinTypeConfig,
  [SupportedLanguages.CSharp]: csharpConfig,
  [SupportedLanguages.Go]: goConfig,
  [SupportedLanguages.Rust]: rustConfig,
  [SupportedLanguages.Python]: pythonConfig,
  [SupportedLanguages.Swift]: swiftConfig,
  [SupportedLanguages.C]: cCppConfig,
  [SupportedLanguages.CPlusPlus]: cCppConfig,
  [SupportedLanguages.PHP]: phpConfig,
  [SupportedLanguages.Ruby]: rubyConfig,
} satisfies Record<SupportedLanguages, LanguageTypeConfig>;

export type { LanguageTypeConfig, TypeBindingExtractor, ParameterExtractor, ConstructorBindingScanner } from './types.js';
export { 
  TYPED_PARAMETER_TYPES,
  extractSimpleTypeName,
  extractGenericTypeArgs,
  extractVarName,
  findChildByType,
  extractRubyConstructorAssignment
} from './shared.js';
