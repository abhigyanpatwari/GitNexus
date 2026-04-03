/**
 * Language Provider Registry — compile-time exhaustive provider table.
 *
 * To add a new language:
 * 1. Add enum member to SupportedLanguages
 * 2. Create `languages/<lang>.ts` exporting a LanguageProvider
 * 3. Add one line to the `providers` table below
 * 4. Run `tsc --noEmit` to verify
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';

import { typescriptProvider, javascriptProvider } from './typescript.js';
import { pythonProvider } from './python.js';
import { javaProvider } from './java.js';
import { kotlinProvider } from './kotlin.js';
import { goProvider } from './go.js';
import { rustProvider } from './rust.js';
import { csharpProvider } from './csharp.js';
import { cProvider, cppProvider } from './c-cpp.js';
import { phpProvider } from './php.js';
import { rubyProvider } from './ruby.js';
import { swiftProvider } from './swift.js';
import { dartProvider } from './dart.js';
import { vueProvider } from './vue.js';
import { cobolProvider } from './cobol.js';

export const providers = {
  [SupportedLanguages.JavaScript]: javascriptProvider,
  [SupportedLanguages.TypeScript]: typescriptProvider,
  [SupportedLanguages.Python]: pythonProvider,
  [SupportedLanguages.Java]: javaProvider,
  [SupportedLanguages.Kotlin]: kotlinProvider,
  [SupportedLanguages.Go]: goProvider,
  [SupportedLanguages.Rust]: rustProvider,
  [SupportedLanguages.CSharp]: csharpProvider,
  [SupportedLanguages.C]: cProvider,
  [SupportedLanguages.CPlusPlus]: cppProvider,
  [SupportedLanguages.PHP]: phpProvider,
  [SupportedLanguages.Ruby]: rubyProvider,
  [SupportedLanguages.Swift]: swiftProvider,
  [SupportedLanguages.Dart]: dartProvider,
  [SupportedLanguages.Vue]: vueProvider,
  [SupportedLanguages.Cobol]: cobolProvider,
} satisfies Record<SupportedLanguages, LanguageProvider>;

/** Get provider by language enum (always succeeds for SupportedLanguages). */
export function getProvider(language: SupportedLanguages): LanguageProvider {
  return providers[language];
}

/** Pre-built extension → provider lookup (built once at module load). */
const extensionMap = new Map<string, LanguageProvider>();
for (const provider of Object.values(providers)) {
  for (const ext of provider.extensions) {
    extensionMap.set(ext, provider);
  }
}

/** Look up a language provider from a file path by extension.
 *  Returns null if the file extension is not recognized. */
export function getProviderForFile(filePath: string): LanguageProvider | null {
  const lastDot = filePath.lastIndexOf('.');
  const ext = lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : '';
  const basename = filePath.slice(filePath.lastIndexOf('/') + 1);
  return extensionMap.get(ext) ?? extensionMap.get(basename) ?? null;
}

/** Pre-computed list of providers that have implicit import wiring (e.g., Swift).
 *  Built once at module load — avoids iterating all 13 providers per call. */
export const providersWithImplicitWiring = Object.values(providers).filter(
  (
    p,
  ): p is LanguageProvider & {
    implicitImportWirer: NonNullable<LanguageProvider['implicitImportWirer']>;
  } => p.implicitImportWirer != null,
);
