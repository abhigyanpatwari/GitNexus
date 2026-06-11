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
import { emitJsScopeCaptures } from '../javascript/captures.js';

/**
 * Emit scope captures for a Vue SFC.
 *
 * Handles three call-site shapes:
 *
 *   1. **Full SFC content** (sequential path, <15 files): `sourceText`
 *      contains the whole `.vue` file with `<template>`, `<script>`, etc.
 *      `extractVueScript` extracts the script block and we delegate to
 *      `emitTsScopeCaptures` or `emitJsScopeCaptures` based on `lang`.
 *
 *   2. **Already-extracted script content** (worker-mode path, ≥15 files):
 *      the parse worker calls `extractVueScript` itself before calling
 *      `extractParsedFile`, so `sourceText` is already the bare script
 *      text with no `<script>` tags. The caller marks this explicitly via
 *      `sourceMeta.sourceKind === 'pre-extracted-script'`.
 *
 *   3. **Supporting TS/JS files** included in Vue scope-resolution runs:
 *      when `filePath` is not `.vue`, delegate straight to TypeScript captures.
 *
 * Returns an empty array for render-function-only SFCs (no `<script>` block).
 */
export function emitVueScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
  sourceMeta?: { sourceKind?: 'full-file' | 'pre-extracted-script'; setupLang?: string },
): readonly CaptureMatch[] {
  // Vue resolver may include supporting TS/JS files in the same run to
  // preserve cross-file import/type context for `.vue` callers. These are
  // already plain script files, so no SFC extraction is needed.
  if (!filePath.endsWith('.vue')) {
    return emitTsScopeCaptures(sourceText, filePath, cachedTree);
  }

  if (sourceMeta?.sourceKind === 'pre-extracted-script') {
    // Worker-mode path: the parse worker always uses TypeScript grammar for
    // .vue files. Lang-based grammar selection is a sequential-path feature.
    return emitTsScopeCaptures(sourceText, filePath, cachedTree);
  }

  const extracted = extractVueScript(sourceText);
  if (extracted === null) return [];

  // Select captures based on script lang attribute.
  // Use TS grammar unless ALL blocks explicitly request JS/JSX.
  // Mixed-lang: TS handles JS natively; JS grammar chokes on TS syntax.
  if (extracted.lang === 'js' || extracted.lang === 'jsx') {
    return emitJsScopeCaptures(extracted.scriptContent, filePath, cachedTree);
  }
  return emitTsScopeCaptures(extracted.scriptContent, filePath, cachedTree);
}
