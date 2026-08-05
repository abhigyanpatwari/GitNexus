/**
 * Lua scope-capture emitter (RFC #909 Ring 3).
 *
 * Minimal grouping: parse (or reuse the worker's cached AST) → run the scope
 * query → group each match's captures into a CaptureMatch keyed by `@name`.
 * No Ruby-style decomposition (Lua's require is captured directly in the query
 * as @import.statement + @import.source + @import.localName), no YARD, no
 * receiver synthesis — those are deferred (receiver/arity polish, Phase B3).
 *
 * Side effect: also runs the heritage + method-owner queries against the same
 * AST and stashes the pairs into the capture-side-channel map, so the main-
 * thread `emitLuaHeritageEdges` hook can emit EXTENDS + HAS_METHOD edges
 * WITHOUT re-reading or re-parsing the file (#1983 no-main-thread-re-parse).
 *
 * The central ScopeExtractor partitions the capture output by prefix
 * (@scope.* / @declaration.* / @import.* / @reference.*) and builds the scope
 * tree, declarations, imports, and reference sites that finalize turns into
 * CALLS + IMPORTS edges.
 */
import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getLuaParser, getLuaScopeQuery, getHeritageQuery, getMethodOwnerQuery } from './query.js';
import {
  setLuaHeritageFacts,
  type LuaExtendsPair,
  type LuaMethodOwnerPair,
} from './capture-side-channel.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

export function emitLuaScopeCaptures(
  sourceText: string,
  filePath: string,
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

  // Heritage pairs (middleclass EXTENDS + HAS_METHOD) — collected here in the
  // worker where the AST is live, snapshotted onto ParsedFile.captureSideChannel
  // by `collectLuaCaptureSideChannel`, consumed by `emitLuaHeritageEdges`.
  const extendsPairs: LuaExtendsPair[] = [];
  for (const m of getHeritageQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const child = stripQuotes(caps['child.name']?.text ?? '');
    const parent = caps['parent.name']?.text;
    if (child.length > 0 && parent !== undefined) {
      extendsPairs.push({ child, parent });
    }
  }
  const methodOwners: LuaMethodOwnerPair[] = [];
  for (const m of getMethodOwnerQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const owner = caps['method.owner']?.text;
    const method = caps['method.name']?.text;
    const defNode = caps['method.def'];
    if (owner === undefined || method === undefined || defNode === undefined) continue;
    methodOwners.push({ owner, method, defRow: defNode.startPosition.row });
  }
  if (extendsPairs.length > 0 || methodOwners.length > 0) {
    setLuaHeritageFacts(filePath, { kind: 'lua', extendsPairs, methodOwners });
  }

  return out;
}
