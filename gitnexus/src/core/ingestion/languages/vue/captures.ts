/**
 * Vue SFC scope captures (RFC #909 Ring 3, issue #940).
 *
 * Extracts the `<script>` / `<script setup>` block from the SFC source
 * and delegates to `emitTsScopeCaptures`.  The parse-worker builds the
 * cached tree from the extracted script content using the TypeScript
 * grammar (see `[SupportedLanguages.Vue]: TypeScript.typescript` in
 * `parse-worker.ts`), so passing that tree here keeps grammar identity
 * consistent and avoids a redundant re-parse.
 *
 * Template expressions are intentionally out-of-scope: component-
 * reference CALLS edges are already emitted by the legacy template
 * extractor in the parse worker and would be double-counted here.
 *
 * Position note: all capture positions are relative to the *extracted*
 * script block, not the full .vue file.  This is consistent with the
 * cached tree and with how the scope model uses positions (only for
 * scope-containment walks within a single file), so no offset
 * translation is required for graph-edge correctness.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { extractVueScript } from '../../vue-sfc-extractor.js';
import { emitTsScopeCaptures } from '../typescript/captures.js';

/**
 * Emit scope captures for a Vue SFC.
 *
 * Returns an empty array when the file has no `<script>` / `<script
 * setup>` block (e.g. render-function-only components).
 */
export function emitVueScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  const extracted = extractVueScript(sourceText);
  if (extracted === null) return [];
  return emitTsScopeCaptures(extracted.scriptContent, filePath, cachedTree);
}
