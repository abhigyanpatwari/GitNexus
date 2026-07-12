/**
 * Decompose a Solidity `import_directive` into one CaptureMatch per
 * imported binding.
 *
 * Forms (tree-sitter-solidity@1.1.0):
 *
 *   import "./Foo.sol";                      → wildcard
 *   import "./Foo.sol" as Foo;               → namespace
 *   import * as Foo from "./Foo.sol";        → namespace
 *   import Foo from "./Foo.sol";             → named
 *   import Foo as F from "./Foo.sol";        → alias
 *   import {Foo, Bar as B} from "./Foo.sol"; → named / alias (one match each)
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

function stripQuotes(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').trim();
}

function hasFromClause(stmtNode: SyntaxNode): boolean {
  for (let i = 0; i < stmtNode.childCount; i++) {
    const child = stmtNode.child(i);
    if (child !== null && !child.isNamed && child.type === 'from') return true;
  }
  return false;
}

function hasStarImport(stmtNode: SyntaxNode): boolean {
  for (let i = 0; i < stmtNode.childCount; i++) {
    const child = stmtNode.child(i);
    if (child !== null && !child.isNamed && child.type === '*') return true;
  }
  return false;
}

/** After an `import_origin` identifier, detect optional `as Alias`. */
function aliasAfterOrigin(origin: SyntaxNode): SyntaxNode | null {
  let n = origin.nextSibling;
  while (n !== null && !n.isNamed && n.type !== 'as') n = n.nextSibling;
  if (n === null || n.type !== 'as') return null;
  let a = n.nextSibling;
  while (a !== null && !a.isNamed) a = a.nextSibling;
  return a !== null && a.type === 'identifier' ? a : null;
}

/**
 * Untagged identifier children that are neither `import_origin` nor
 * `import_alias` field values (used by `import Foo from` / path `as` forms).
 */
function untaggedIdentifiers(stmtNode: SyntaxNode): SyntaxNode[] {
  const fieldIds = new Set<number>();
  const mark = (nodes: readonly SyntaxNode[]) => {
    for (const n of nodes) fieldIds.add(n.id);
  };
  if (typeof stmtNode.childrenForFieldName === 'function') {
    mark(stmtNode.childrenForFieldName('import_origin'));
    mark(stmtNode.childrenForFieldName('import_alias'));
  } else {
    const origin = stmtNode.childForFieldName('import_origin');
    const alias = stmtNode.childForFieldName('import_alias');
    if (origin) fieldIds.add(origin.id);
    if (alias) fieldIds.add(alias.id);
  }

  const out: SyntaxNode[] = [];
  for (let i = 0; i < stmtNode.namedChildCount; i++) {
    const child = stmtNode.namedChild(i);
    if (child === null || child.type !== 'identifier') continue;
    if (fieldIds.has(child.id)) continue;
    out.push(child);
  }
  return out;
}

function buildMatch(
  stmtNode: SyntaxNode,
  kind: string,
  source: string,
  opts: { name?: string; alias?: string; atNode?: SyntaxNode } = {},
): CaptureMatch {
  const at = opts.atNode ?? stmtNode;
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', at, kind),
    '@import.source': syntheticCapture('@import.source', at, source),
  };
  if (opts.name !== undefined) {
    m['@import.name'] = syntheticCapture('@import.name', at, opts.name);
  }
  if (opts.alias !== undefined) {
    m['@import.alias'] = syntheticCapture('@import.alias', at, opts.alias);
  }
  return m;
}

export function splitSolidityImportDirective(stmtNode: SyntaxNode): CaptureMatch[] {
  if (stmtNode.type !== 'import_directive') return [];

  const sourceNode = stmtNode.childForFieldName('source');
  if (sourceNode === null) return [];
  const source = stripQuotes(sourceNode.text);
  if (source === '') return [];

  const origins =
    typeof stmtNode.childrenForFieldName === 'function'
      ? stmtNode.childrenForFieldName('import_origin')
      : (() => {
          const one = stmtNode.childForFieldName('import_origin');
          return one ? [one] : [];
        })();

  // `import {Foo, Bar as B} from "..."` — one match per origin.
  if (origins.length > 0) {
    return origins.map((origin) => {
      const aliasNode = aliasAfterOrigin(origin);
      if (aliasNode !== null) {
        return buildMatch(stmtNode, 'alias', source, {
          name: origin.text,
          alias: aliasNode.text,
          atNode: origin,
        });
      }
      return buildMatch(stmtNode, 'named', source, {
        name: origin.text,
        atNode: origin,
      });
    });
  }

  const aliasField = stmtNode.childForFieldName('import_alias');
  const untagged = untaggedIdentifiers(stmtNode);
  const fromClause = hasFromClause(stmtNode);

  // `import * as Foo from "..."`
  if (fromClause && hasStarImport(stmtNode) && aliasField !== null) {
    return [
      buildMatch(stmtNode, 'namespace', source, {
        name: source,
        alias: aliasField.text,
        atNode: aliasField,
      }),
    ];
  }

  // `import Foo as F from "..."`
  if (fromClause && aliasField !== null && untagged.length >= 1) {
    const nameNode = untagged[0]!;
    return [
      buildMatch(stmtNode, 'alias', source, {
        name: nameNode.text,
        alias: aliasField.text,
        atNode: nameNode,
      }),
    ];
  }

  // `import Foo from "..."`
  if (fromClause && untagged.length >= 1) {
    const nameNode = untagged[0]!;
    return [
      buildMatch(stmtNode, 'named', source, {
        name: nameNode.text,
        atNode: nameNode,
      }),
    ];
  }

  // `import "..." as Foo;` — path alias → namespace handle
  if (!fromClause && untagged.length >= 1) {
    const aliasNode = untagged[0]!;
    return [
      buildMatch(stmtNode, 'namespace', source, {
        name: source,
        alias: aliasNode.text,
        atNode: aliasNode,
      }),
    ];
  }

  // `import "...";` — whole-file wildcard
  return [buildMatch(stmtNode, 'wildcard', source, { atNode: sourceNode })];
}
