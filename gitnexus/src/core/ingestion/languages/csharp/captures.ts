/**
 * `emitScopeCaptures` for C#.
 *
 * Drives the C# scope query against tree-sitter-c-sharp and groups
 * raw matches into `CaptureMatch[]` for the central extractor.
 *
 * Unit 1 shape: pure pass-through — each tree-sitter match becomes
 * one grouped `CaptureMatch`. Import decomposition (Unit 2),
 * receiver-type-binding synthesis (Unit 3), and arity metadata
 * synthesis (Unit 5) layer on top later.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getCsharpParser, getCsharpScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';

export function emitCsharpScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller (parse phase's scopeTreeCache)
  // already produced a Tree for this source. Cache miss = re-parse,
  // same as before. The cachedTree parameter is typed as `unknown` at
  // the LanguageProvider contract layer; cast here at the use site.
  let tree = cachedTree as ReturnType<ReturnType<typeof getCsharpParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = getCsharpParser().parse(sourceText);
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getCsharpScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter strips the leading
    // `@`; we put it back so the central extractor's prefix lookups
    // (`@scope.`, `@declaration.`, …) work.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    out.push(grouped);
  }

  return out;
}
