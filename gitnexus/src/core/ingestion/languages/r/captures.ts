import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getRParser, getRScopeQuery } from './query.js';
import { isRNonNamingScopeMatch } from './naming-argument.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/**
 * Emit R scope captures — a single tree-sitter query run against the R
 * grammar (see `query.ts` for the capture shapes and the rationale for each
 * one). No programmatic enrichment is needed: unlike C/Zig/Rust, R's
 * declarations carry no synthesized arity/parameter metadata, and heritage
 * sites resolve directly by name (no marker encoding, unlike Ruby's
 * `include`/`extend`/`prepend`).
 */
export function emitRScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getRParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getRScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // The scope query captures every candidate argument of setClass/library/require/
    // source; keep only the one that names the class or import.
    if (isRNonNamingScopeMatch(m.captures)) continue;
    const grouped: Record<string, Capture> = {};
    let hasRealCapture = false;
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      hasRealCapture = true;
    }
    if (!hasRealCapture) continue;
    out.push(grouped);
  }

  return out;
}
