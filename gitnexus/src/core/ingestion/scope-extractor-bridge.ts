/**
 * Bridge between a language provider's `emitScopeCaptures` hook and the
 * `ScopeExtractor` (RFC #909 Ring 2 PKG #920).
 *
 * Extracted into its own module so it can be imported by test code
 * without pulling in `parse-worker.ts` — which has a top-level
 * `parentPort!.on('message', ...)` call that assumes a worker-thread
 * context and throws on direct import.
 *
 * The bridge:
 *
 *   1. Short-circuits when the provider has NOT implemented
 *      `emitScopeCaptures`. Returns `undefined`; zero work done. This is
 *      the state of every language today — `ParsedFile` production stays
 *      dormant until a language migrates.
 *   2. Invokes the hook + feeds its output to `ScopeExtractor.extract`.
 *   3. **Swallows exceptions from either side.** A failure here returns
 *      `undefined` and emits a warning via `onWarn`; legacy parsing on
 *      the same file continues unaffected by the scope-extraction miss.
 *      Scope-based resolution is the new path under construction — it
 *      must not destabilize the legacy DAG.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { extract as extractScope } from './scope-extractor.js';
import type { LanguageProvider } from './language-provider.js';

/** Callback used to report scope-extraction warnings to the host (worker or direct). */
export type ScopeBridgeWarn = (message: string) => void;

/**
 * Produce a `ParsedFile` for the given file, or `undefined` when the
 * provider hasn't migrated / the extractor throws. Never propagates
 * exceptions.
 */
export function extractParsedFile(
  provider: LanguageProvider,
  sourceText: string,
  filePath: string,
  onWarn?: ScopeBridgeWarn,
  cachedTree?: unknown,
): ParsedFile | undefined {
  if (provider.emitScopeCaptures === undefined) return undefined;
  try {
    const captures = provider.emitScopeCaptures(sourceText, filePath, cachedTree);
    return extractScope(captures, filePath, provider);
  } catch (err) {
    const message = `scope extraction failed for ${filePath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (onWarn !== undefined) onWarn(message);
    else console.warn(message);
    return undefined;
  }
}
