/**
 * `emitScopeCaptures` for C#.
 *
 * Drives the C# scope query against tree-sitter-c-sharp and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Layers one
 * synthesized stream on top today:
 *
 *   1. **Decomposed using directives** — each `using_directive` is
 *      re-emitted with `@import.kind/source/name/alias` markers so
 *      `interpretCsharpImport` can recover the ParsedImport shape
 *      without re-parsing raw text (see `import-decomposer.ts`).
 *
 * Receiver-binding synthesis (`this` / `base` type anchors) and arity
 * metadata synthesis (Unit 5) layer on top later.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture } from '../../utils/ast-helpers.js';
import { splitUsingDirective } from './import-decomposer.js';
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

    // Decompose each `using_directive` so `interpretCsharpImport` sees
    // the kind/source/name/alias markers it consumes. Raw query match
    // only carries the @import.statement anchor.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode = findNodeAtRange(tree.rootNode, stmtCapture.range, 'using_directive');
      if (stmtNode !== null) {
        const decomposed = splitUsingDirective(stmtNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      // Defensive fallback: emit the raw match so the extractor at
      // least sees an anchor, even without markers.
      out.push(grouped);
      continue;
    }

    out.push(grouped);
  }

  return out;
}
