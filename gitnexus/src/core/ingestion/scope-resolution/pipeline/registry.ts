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

/** Map of `SupportedLanguages` → `ScopeResolver`. The phase iterates
 *  this map intersected with `MIGRATED_LANGUAGES` (the per-language
 *  flag set) so adding a resolver here without flipping the flag is
 *  safe — the resolver sits idle until the language is migrated. */
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
]);
