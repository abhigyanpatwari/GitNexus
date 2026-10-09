/**
 * Vue SFC scope captures (RFC #909 Ring 3, issue #940).
 *
 * Extracts the `<script>` / `<script setup>` block from the SFC source
 * and delegates to the script language's scope emitter. The parse worker's
 * structural tree uses TypeScript; explicit JS/JSX scripts are parsed with
 * their own scope grammar inside the worker.
 *
 * Template expressions are intentionally out-of-scope: component-
 * reference CALLS edges are already emitted by the legacy template
 * extractor in the parse worker and would be double-counted here.
 *
 * Lexical capture positions stay relative to the extracted script block,
 * matching the cached tree. Declaration graph-position metadata carries
 * the separate offset used by the structure phase's graph-node positions.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { extractVueScript } from '../../vue-sfc-extractor.js';
import { emitTsScopeCaptures } from '../typescript/captures.js';
import { emitJsScopeCaptures } from '../javascript/captures.js';

const DECLARATION_ANCHORS = [
  '@declaration.function',
  '@declaration.method',
  '@declaration.class',
  '@declaration.interface',
  '@declaration.enum',
  '@declaration.type_alias',
  '@declaration.namespace',
  '@declaration.property',
  '@declaration.variable',
  '@declaration.const',
] as const;

/** Preserve lexical coordinates while exposing the structure phase's position. */
function withGraphPositions(
  matches: readonly CaptureMatch[],
  lineOffset: number,
): readonly CaptureMatch[] {
  return matches.map((match) => {
    const anchor = DECLARATION_ANCHORS.map((name) => match[name]).find(
      (capture) => capture !== undefined,
    );
    if (anchor === undefined) return match;
    const startLine = anchor.range.startLine + lineOffset;
    const startCol = anchor.range.startCol;
    return {
      ...match,
      '@declaration.graph-position': {
        name: '@declaration.graph-position',
        text: '',
        range: { startLine, startCol, endLine: startLine, endCol: startCol },
      },
    };
  });
}

/**
 * Emit scope captures for a Vue SFC.
 *
 * Handles three call-site shapes:
 *
 *   1. **Full SFC content** (direct extraction): `sourceText`
 *      contains the whole `.vue` file with `<template>`, `<script>`, etc.
 *      `extractVueScript` extracts the script block and we delegate to
 *      `emitTsScopeCaptures` or `emitJsScopeCaptures` based on `lang`.
 *
 *   2. **Already-extracted script content** (worker path):
 *      the parse worker calls `extractVueScript` itself before calling
 *      `extractParsedFile`, so `sourceText` is already the bare script
 *      text with no `<script>` tags. The caller marks this explicitly via
 *      `sourceMeta.sourceKind === 'pre-extracted-script'` and preserves the
 *      extracted language in `sourceMeta.scriptLanguage`.
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
  sourceMeta?: {
    sourceKind?: 'full-file' | 'pre-extracted-script';
    scriptLanguage?: string;
    lineOffset?: number;
  },
): readonly CaptureMatch[] {
  // Vue resolver may include supporting TS/JS files in the same run to
  // preserve cross-file import/type context for `.vue` callers. These are
  // already plain script files, so no SFC extraction is needed.
  if (!filePath.endsWith('.vue')) {
    return emitTsScopeCaptures(sourceText, filePath, cachedTree);
  }

  if (sourceMeta?.sourceKind === 'pre-extracted-script') {
    const isJavaScript = sourceMeta.scriptLanguage === 'js' || sourceMeta.scriptLanguage === 'jsx';
    const emit = isJavaScript ? emitJsScopeCaptures : emitTsScopeCaptures;
    // The worker's structural tree is TypeScript. Native Tree versions without
    // getLanguage() cannot prove grammar compatibility, so never give that
    // tree to the JavaScript query. This parse stays inside the worker.
    return withGraphPositions(
      emit(sourceText, filePath, isJavaScript ? undefined : cachedTree),
      sourceMeta.lineOffset ?? 0,
    );
  }

  const extracted = extractVueScript(sourceText);
  if (extracted === null) return [];

  // Select captures based on script lang attribute.
  // Use TS grammar unless ALL blocks explicitly request JS/JSX.
  // Mixed-lang: TS handles JS natively; JS grammar chokes on TS syntax.
  if (extracted.lang === 'js' || extracted.lang === 'jsx') {
    return withGraphPositions(
      emitJsScopeCaptures(extracted.scriptContent, filePath, cachedTree),
      extracted.lineOffset,
    );
  }
  return withGraphPositions(
    emitTsScopeCaptures(extracted.scriptContent, filePath, cachedTree),
    extracted.lineOffset,
  );
}
