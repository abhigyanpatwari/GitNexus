/**
 * Per-language `ScopeResolver` registry — the lookup the generic
 * `scopeResolutionPhase` uses to pick the right resolver for each
 * migrated language.
 *
 * Adding a language is two lines: implement a `ScopeResolver` in
 * `languages/<lang>/scope-resolver.ts` and register it here. The
 * phase picks it up automatically — no workflow changes, no
 * per-language pipeline phase file.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { pythonScopeResolver } from '../../languages/python/scope-resolver.js';
import { csharpScopeResolver } from '../../languages/csharp/scope-resolver.js';
import { typescriptScopeResolver } from '../../languages/typescript/scope-resolver.js';
import { goScopeResolver } from '../../languages/go/scope-resolver.js';
import { javaScopeResolver } from '../../languages/java/scope-resolver.js';
import { cScopeResolver } from '../../languages/c/scope-resolver.js';
import { cppScopeResolver } from '../../languages/cpp/scope-resolver.js';
import { phpScopeResolver } from '../../languages/php/scope-resolver.js';
import { rustScopeResolver } from '../../languages/rust/scope-resolver.js';
import { javascriptScopeResolver } from '../../languages/javascript/scope-resolver.js';
import { kotlinScopeResolver } from '../../languages/kotlin/scope-resolver.js';
import { rubyScopeResolver } from '../../languages/ruby/scope-resolver.js';
import { cobolScopeResolver } from '../../languages/cobol/scope-resolver.js';
import { swiftScopeResolver } from '../../languages/swift/scope-resolver.js';
import { dartScopeResolver } from '../../languages/dart/scope-resolver.js';
import { vueScopeResolver } from '../../languages/vue/scope-resolver.js';

/** Map of `SupportedLanguages` → `ScopeResolver`. The scope-resolution phase
 *  iterates this map directly — every registered resolver runs. This is the
 *  single source of truth for which languages resolve via scope-resolution. */
export const SCOPE_RESOLVERS: ReadonlyMap<SupportedLanguages, ScopeResolver> = new Map<
  SupportedLanguages,
  ScopeResolver
>([
  [SupportedLanguages.Python, pythonScopeResolver],
  [SupportedLanguages.CSharp, csharpScopeResolver],
  [SupportedLanguages.TypeScript, typescriptScopeResolver],
  [SupportedLanguages.Go, goScopeResolver],
  [SupportedLanguages.Java, javaScopeResolver],
  [SupportedLanguages.C, cScopeResolver],
  [SupportedLanguages.CPlusPlus, cppScopeResolver],
  [SupportedLanguages.PHP, phpScopeResolver],
  [SupportedLanguages.Rust, rustScopeResolver],
  [SupportedLanguages.JavaScript, javascriptScopeResolver],
  [SupportedLanguages.Kotlin, kotlinScopeResolver],
  [SupportedLanguages.Ruby, rubyScopeResolver],
  [SupportedLanguages.Cobol, cobolScopeResolver],
  [SupportedLanguages.Swift, swiftScopeResolver],
  [SupportedLanguages.Dart, dartScopeResolver],
  [SupportedLanguages.Vue, vueScopeResolver],
]);
