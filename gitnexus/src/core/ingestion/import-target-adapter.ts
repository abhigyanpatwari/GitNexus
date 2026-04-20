/**
 * Bridge between CLI-package per-language `ImportResolverFn`s and the
 * shared `FinalizeHooks.resolveImportTarget` contract
 * (RFC §5.2; Ring 2 PKG #922).
 *
 * The shared finalize algorithm (#915) asks one question:
 *
 *     resolveImportTarget(targetRaw, fromFile, workspaceIndex): string | null
 *
 * The CLI already has 16 language-specific resolvers satisfying a
 * richer signature:
 *
 *     ImportResolverFn(rawImportPath, filePath, resolveCtx): ImportResult
 *
 * This module builds a dispatch adapter — one FinalizeHook implementation
 * that looks up the file's language from its path and delegates to the
 * right per-language resolver. Callers package per-language resolvers +
 * a shared `ResolveCtx` into an opaque `ImportTargetWorkspace` and pass
 * it as `workspaceIndex` to `finalizeScopeModel`.
 *
 * ## What's deliberately NOT here
 *
 *   - **Re-implementation of any per-language resolver.** We wrap the
 *     existing `importResolver` field on each `LanguageProvider` — the
 *     same code path the legacy DAG uses today.
 *   - **Dynamic-import handling.** The shared finalize algorithm short-
 *     circuits `ParsedImport { kind: 'dynamic-unresolved' }` before
 *     calling `resolveImportTarget`, so the adapter never sees those.
 *   - **`importPathPreprocessor`.** Preprocessing belongs inside the
 *     provider's `interpretImport` hook (which writes the final
 *     `ParsedImport.targetRaw`). By the time finalize passes a
 *     `targetRaw` to this adapter, it is the string the provider wants
 *     resolved verbatim.
 */

import {
  getLanguageFromFilename,
  type SupportedLanguages,
  type WorkspaceIndex,
} from 'gitnexus-shared';
import type { ImportResolverFn, ImportResult, ResolveCtx } from './import-resolvers/types.js';
import type { LanguageProvider } from './language-provider.js';

/** A single language's resolver bundled with the context it needs. */
export interface LanguageResolverEntry {
  readonly resolver: ImportResolverFn;
  readonly ctx: ResolveCtx;
}

/**
 * The opaque `workspaceIndex` shape recognized by
 * `resolveImportTargetAcrossLanguages`. Built once per ingestion run via
 * `buildImportTargetWorkspace`, threaded through `finalizeScopeModel`.
 */
export interface ImportTargetWorkspace {
  readonly perLanguage: ReadonlyMap<SupportedLanguages, LanguageResolverEntry>;
}

/**
 * Build the workspace index from a map of language → provider. Providers
 * whose `importResolver` is absent are silently skipped (no language will
 * ever hit that branch at dispatch time).
 *
 * The `resolveCtx` is shared across all languages. Callers assemble it
 * once per run (the existing pipeline already does this for the legacy
 * DAG) and hand it to both the legacy resolution path and this factory.
 */
export function buildImportTargetWorkspace(
  providers: ReadonlyMap<SupportedLanguages, LanguageProvider>,
  resolveCtx: ResolveCtx,
): ImportTargetWorkspace {
  const perLanguage = new Map<SupportedLanguages, LanguageResolverEntry>();
  for (const [lang, provider] of providers) {
    if (provider.importResolver === undefined) continue;
    perLanguage.set(lang, { resolver: provider.importResolver, ctx: resolveCtx });
  }
  return { perLanguage };
}

/**
 * The FinalizeHooks-compatible implementation. Dispatches on `fromFile`'s
 * extension → per-language resolver. Returns the first resolved file,
 * or `null` if the resolver returns `null` or doesn't know about the
 * language.
 *
 * Picks the first entry of `files[]` for both `'files'` and `'package'`
 * result kinds — the legacy pipeline uses the whole array, but the
 * shared `finalize()` hook contract is single-file. If the workspace
 * later needs richer semantics (split-target packages), this is the
 * single site to extend.
 */
export function resolveImportTargetAcrossLanguages(
  targetRaw: string,
  fromFile: string,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const workspace = workspaceIndex as ImportTargetWorkspace | undefined;
  if (workspace === undefined || workspace.perLanguage === undefined) return null;

  const lang = getLanguageFromFilename(fromFile);
  if (lang === null) return null;

  const entry = workspace.perLanguage.get(lang);
  if (entry === undefined) return null;

  let result: ImportResult;
  try {
    result = entry.resolver(targetRaw, fromFile, entry.ctx);
  } catch {
    // Existing resolvers can throw on malformed inputs (e.g., Python
    // relative paths above the workspace root). Swallow — the shared
    // algorithm treats a null here as `linkStatus: 'unresolved'`, which
    // is the right fallback.
    return null;
  }
  if (result === null) return null;

  // Both `files` and `package` variants expose a `files` array; the
  // package variant also carries `dirSuffix` which we ignore at the
  // FinalizeHook boundary (single-file contract). Legacy consumers
  // continue to see the full result via `importResolver` directly.
  const first = result.files[0];
  return first ?? null;
}
