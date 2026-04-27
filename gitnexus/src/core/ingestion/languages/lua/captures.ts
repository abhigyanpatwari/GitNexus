/**
 * `emitScopeCaptures` for Lua.
 *
 * Drives the Lua scope query against `@tree-sitter-grammars/tree-sitter-lua`
 * and groups raw matches into `CaptureMatch[]` for the central extractor.
 *
 * Lua has no formal module system. The top-level chunk (file) is the module
 * scope. Tables assigned to names are the idiomatic namespace mechanism.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getLuaParser, getLuaScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';

export function emitLuaScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getLuaParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = getLuaParser().parse(sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getLuaScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      // Skip internal predicate captures (e.g. @_req, @_req2, @_sm, @_idx)
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    out.push(grouped);
  }

  return out;
}
