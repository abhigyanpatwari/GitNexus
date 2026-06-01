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
 * Handles two call-site shapes:
 *
 *   1. **Full SFC content** (sequential path, <15 files): `sourceText`
 *      contains the whole `.vue` file with `<template>`, `<script>`, etc.
 *      `extractVueScript` extracts the script block and we delegate to
 *      `emitTsScopeCaptures` with that extracted content.
 *
 *   2. **Already-extracted script content** (worker-mode path, ≥15 files):
 *      the parse worker calls `extractVueScript` itself before calling
 *      `extractParsedFile`, so `sourceText` is already the bare TypeScript
 *      text with no `<script>` tags.  `extractVueScript` returns `null`
 *      here.  We detect this case by the absence of any SFC block-level
 *      markers (`<template`, `<style`) and delegate directly.
 *
 * Returns an empty array for render-function-only components (SFC without
 * a `<script>` block, which still have `<template>` or `<style>` markers).
 */
export function emitVueScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  const extracted = extractVueScript(sourceText);
  if (extracted !== null) {
    return emitTsScopeCaptures(extracted.scriptContent, filePath, cachedTree);
  }
  // extractVueScript returned null: either a render-function-only SFC (has
  // <template> / <style> but no <script>) or already-extracted script text.
  // Distinguish by looking for SFC block-level tags in the raw source.
  const hasSfcMarkers = /<(?:template|style)\b/i.test(sourceText);
  if (hasSfcMarkers) {
    // Real SFC with no script block — genuinely nothing to capture.
    return [];
  }
  // Pre-extracted script content from the parse worker — delegate directly.
  return emitTsScopeCaptures(sourceText, filePath, cachedTree);
}
