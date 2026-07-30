/**
 * Lua scope-capture emitter (RFC #909 Ring 3).
 *
 * Minimal grouping: parse (or reuse the worker's cached AST) → run the scope
 * query → group each match's captures into a CaptureMatch keyed by `@name`.
 * No Ruby-style decomposition (Lua's require is captured directly in the query
 * as @import.statement + @import.source), no YARD, no receiver synthesis —
 * those are deferred (receiver/arity polish, Phase B3).
 *
 * The central ScopeExtractor partitions the output by capture prefix
 * (@scope.* / @declaration.* / @import.* / @reference.*) and builds the scope
 * tree, declarations, imports, and reference sites that finalize turns into
 * CALLS + IMPORTS edges.
 */
import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getLuaParser, getLuaScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

export function emitLuaScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
  } else {
    tree = parseSourceSafe(getLuaParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const out: CaptureMatch[] = [];
  for (const match of getLuaScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const c of match.captures) {
      const tag = '@' + c.name;
      // Skip tree-sitter predicate captures (e.g. @_req used by #eq?).
      if (tag.startsWith('@_')) continue;
      if (grouped[tag] === undefined) grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    // middleclass `class("Name", ...)`: strip surrounding quotes from the name
    // so the Class node is named `BattleSkill`, not `"BattleSkill"`. tree-sitter-lua's
    // string node has no content child, so .text carries the quotes.
    const nameCap = grouped['@declaration.name'];
    if (grouped['@declaration.class'] !== undefined && nameCap !== undefined) {
      const stripped = nameCap.text.replace(/^["']|["']$/g, '');
      if (stripped !== nameCap.text) {
        grouped['@declaration.name'] = { ...nameCap, text: stripped };
      }
    }
    out.push(grouped);
  }
  return out;
}
