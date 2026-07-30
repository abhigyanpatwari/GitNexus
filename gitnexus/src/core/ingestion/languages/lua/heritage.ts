/**
 * Lua middleclass inheritance edges (EXTENDS).
 *
 * middleclass has no syntactic class body — `class("Name", Parent)` is a plain
 * call, and methods are file-top-level `function Name:method()`. So neither
 * lexical heritage nor lexical HAS_METHOD applies. This hook re-parses each
 * file for `class("Name", Parent)` calls and emits EXTENDS from the child Class
 * graph node to the parent Class graph node, resolving both via `nodeLookup`.
 *
 * Mirrors `emitRubyMixinEdges` (the only other `emitHeritageEdges` impl), but
 * reads the heritage pair straight from the AST rather than threading markers
 * through `parsedImports` — middleclass's single-arg form needs no marker
 * decomposition, and the parent is a bare identifier in the source.
 */
import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import { SupportedLanguages, type ParsedFile, type NodeLabel } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import { positionKey, type GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import { getLuaParser } from './query.js';

// `local Foo = class("Foo", Parent)` — the 2nd arg is a bare (variable name:).
// `class("Foo")` (no parent) does not match: this pattern requires the trailing
// variable, so parentless classes correctly emit no EXTENDS edge.
const HERITAGE_QUERY = `
(call
  function: (variable name: (identifier) @_class)
  arguments: (argument_list
    (expression_list
      (string) @child.name
      (variable name: (identifier) @parent.name)))
  (#eq? @_class "class")) @heritage
`;

// `function ClassName:method()` (colon) and `function ClassName.method()` (dot).
// The receiver (table) is captured as @method.owner; resolves to a Class node
// for HAS_METHOD. middleclass methods are file-top-level (not in a class body),
// so lexical HAS_METHOD cannot produce these.
const METHOD_OWNER_QUERY = `
(function_definition_statement
  name: (variable
    table: (identifier) @method.owner
    method: (identifier) @method.name)) @method.def

(function_definition_statement
  name: (variable
    table: (identifier) @method.owner
    field: (identifier) @method.name)) @method.def
`;

let _heritageQuery: Parser.Query | null = null;
function getHeritageQuery(): Parser.Query {
  if (_heritageQuery === null) {
    _heritageQuery = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
      HERITAGE_QUERY,
    );
  }
  return _heritageQuery;
}

let _methodOwnerQuery: Parser.Query | null = null;
function getMethodOwnerQuery(): Parser.Query {
  if (_methodOwnerQuery === null) {
    _methodOwnerQuery = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
      METHOD_OWNER_QUERY,
    );
  }
  return _methodOwnerQuery;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

export function emitLuaHeritageEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  // name → graphId (global, for parent resolution). First-wins; same-named
  // classes in different files are rare in middleclass codebases, and a
  // collision here only risks a wrong parent — acceptable for a 0.85-confidence
  // heuristic edge (better an imperfect EXTENDS than none).
  const graphIdByName = new Map<string, string>();
  // (filePath, name) → graphId (per-file, for child resolution).
  const graphIdByFileAndName = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const gid = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (gid === undefined) continue;
      const qn = def.qualifiedName ?? '';
      if (qn.length > 0) {
        graphIdByFileAndName.set(`${parsed.filePath}::${qn}`, gid);
        if (!graphIdByName.has(qn)) graphIdByName.set(qn, gid);
      }
    }
  }

  const emittedExtends = new Set<string>();
  const emittedHasMethod = new Set<string>();
  const parser = getLuaParser();
  const heritageQuery = getHeritageQuery();
  const methodOwnerQuery = getMethodOwnerQuery();
  for (const parsed of parsedFiles) {
    let src: string;
    try {
      src = readFileSync(parsed.filePath, 'utf8');
    } catch {
      continue;
    }
    let tree;
    try {
      tree = parser.parse(src);
    } catch {
      continue;
    }

    // ── EXTENDS: class("Name", Parent) ──────────────────────────────────────
    const heritageMatches = heritageQuery.matches(tree.rootNode);
    for (const m of heritageMatches) {
      const caps: Record<string, Parser.SyntaxNode> = {};
      for (const c of m.captures) caps[c.name] = c.node;
      const childName = stripQuotes(caps['child.name']?.text ?? '');
      const parentName = caps['parent.name']?.text;
      if (childName.length === 0 || parentName === undefined) continue;
      const childGid =
        graphIdByFileAndName.get(`${parsed.filePath}::${childName}`) ??
        graphIdByName.get(childName);
      const parentGid = graphIdByName.get(parentName);
      if (childGid === undefined || parentGid === undefined) continue;
      const edgeKey = `${childGid}->${parentGid}`;
      if (emittedExtends.has(edgeKey)) continue;
      emittedExtends.add(edgeKey);
      graph.addRelationship({
        id: generateId('EXTENDS', edgeKey),
        sourceId: childGid,
        targetId: parentGid,
        type: 'EXTENDS',
        confidence: 0.85,
        reason: 'lua-scope: middleclass inherits',
      });
    }

    // ── HAS_METHOD: function ClassName:method() / function ClassName.method() ─
    const methodMatches = methodOwnerQuery.matches(tree.rootNode);
    for (const m of methodMatches) {
      const caps: Record<string, Parser.SyntaxNode> = {};
      for (const c of m.captures) caps[c.name] = c.node;
      const ownerName = caps['method.owner']?.text;
      const methodName = caps['method.name']?.text;
      const defNode = caps['method.def'];
      if (ownerName === undefined || methodName === undefined || defNode === undefined) continue;
      const classGid =
        graphIdByFileAndName.get(`${parsed.filePath}::${ownerName}`) ??
        graphIdByName.get(ownerName);
      if (classGid === undefined) continue;
      // Resolve the Method graph node by position (0-based row + simple name).
      const methodGid = nodeLookup.get(
        positionKey(parsed.filePath, 'Method' as NodeLabel, defNode.startPosition.row, methodName),
      );
      if (methodGid === undefined) continue;
      const edgeKey = `${classGid}->${methodGid}`;
      if (emittedHasMethod.has(edgeKey)) continue;
      emittedHasMethod.add(edgeKey);
      graph.addRelationship({
        id: generateId('HAS_METHOD', edgeKey),
        sourceId: classGid,
        targetId: methodGid,
        type: 'HAS_METHOD',
        confidence: 0.85,
        reason: 'lua-scope: middleclass method owner',
      });
    }
  }
}
