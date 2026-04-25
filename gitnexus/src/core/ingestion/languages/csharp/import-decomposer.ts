/**
 * Decompose a C# `using_directive` into a `CaptureMatch` carrying the
 * synthesized markers `@import.kind` / `@import.source` / `@import.name`
 * / `@import.alias` that `interpretCsharpImport` consumes.
 *
 * Unlike Python's decomposer this is 1:1 — each `using` produces exactly
 * one import. The split layer exists to expose the kind (namespace vs
 * alias vs static) without pushing raw-text parsing into `interpret.ts`.
 *
 *   using System;                           → namespace
 *   using System.Collections.Generic;       → namespace
 *   using Foo = System.Bar;                 → alias
 *   using static System.Math;               → static
 *   global using System.IO;                 → namespace (treated as file-scoped)
 *   using global::System.IO;                → namespace (global:: alias stripped)
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

type ImportKind = 'namespace' | 'alias' | 'static';

interface ImportSpec {
  readonly kind: ImportKind;
  /** Full dotted path (generics stripped): `System.Collections.Generic`. */
  readonly source: string;
  /** Local binding name — last source segment for namespace/static,
   *  the alias for alias imports. */
  readonly name: string;
  /** Present iff `kind === 'alias'`. */
  readonly alias?: string;
  /** Node to anchor the synthesized captures (range-wise). */
  readonly atNode: SyntaxNode;
}

export function splitUsingDirective(stmtNode: SyntaxNode): CaptureMatch | null {
  if (stmtNode.type !== 'using_directive') return null;
  const spec = parseUsingDirective(stmtNode);
  if (spec === null) return null;
  return buildImportMatch(stmtNode, spec);
}

function parseUsingDirective(node: SyntaxNode): ImportSpec | null {
  // tree-sitter-c-sharp's using_directive exposes named children
  // corresponding to the parts of the directive but omits keyword tokens
  // (`using`, `static`, `global`) from the named-child list. We inspect
  // the raw source text to detect the flavor — the grammar doesn't give
  // us a cleaner signal.
  const raw = node.text;

  // Named child layout:
  //   namespace form:  [pathNode]
  //   alias form:      [aliasIdNode, pathNode]         (name field = aliasId)
  //   static form:     [pathNode]                      (same as namespace)
  //   global using:    [pathNode]                      (same as namespace)
  const aliasField = node.childForFieldName('name');
  const children = node.namedChildren;
  if (children.length === 0) return null;

  // Alias form — the `name:` field is the alias identifier; the
  // remaining named child is the type/namespace path.
  if (aliasField !== null) {
    const pathNode = children.find((c) => c !== null && c.startIndex !== aliasField.startIndex) as
      | SyntaxNode
      | undefined;
    if (pathNode === undefined) return null;
    return {
      kind: 'alias',
      source: stripGenericArgs(unwrapGlobalAlias(pathNode.text)),
      name: aliasField.text,
      alias: aliasField.text,
      atNode: node,
    };
  }

  const pathNode = children[0];
  if (pathNode === null) return null;
  const source = stripGenericArgs(unwrapGlobalAlias(pathNode.text));
  if (source === '') return null;
  const lastSegment = source.split('.').pop() ?? source;

  // `using static X.Y;` — detect by scanning the raw text before the path.
  // `global using` behaves semantically as a file-scoped using for our
  // purposes, so it isn't a separate kind here.
  if (/^\s*(?:global\s+)?using\s+static\s/.test(raw)) {
    return { kind: 'static', source, name: '*', atNode: node };
  }

  return { kind: 'namespace', source, name: lastSegment, atNode: node };
}

/** Strip `global::` prefix — `global::System.IO` → `System.IO`. */
function unwrapGlobalAlias(text: string): string {
  return text.replace(/^global::/, '');
}

/** Strip generic type arguments — `Dictionary<string, int>` → `Dictionary`. */
function stripGenericArgs(text: string): string {
  const lt = text.indexOf('<');
  if (lt === -1) return text;
  return text.slice(0, lt);
}

function buildImportMatch(stmtNode: SyntaxNode, spec: ImportSpec): CaptureMatch {
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  if (spec.alias !== undefined) {
    m['@import.alias'] = syntheticCapture('@import.alias', spec.atNode, spec.alias);
  }
  return m;
}
