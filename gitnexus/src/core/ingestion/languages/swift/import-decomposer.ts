/**
 * Decompose a Swift `import_declaration` into a `CaptureMatch` carrying
 * the synthesized markers `@import.kind` / `@import.source` /
 * `@import.name` / `@import.testable` that `interpretSwiftImport`
 * consumes.
 *
 *   import Foundation              → kind=namespace, source=Foundation
 *   import Foo.Bar                 → kind=namespace, source=Foo
 *   import struct Foo.Bar          → kind=named, source=Foo, name=Bar
 *   @testable import MyApp         → kind=namespace, source=MyApp, testable=1
 *   @_exported import Foo          → kind=reexport, source=Foo, name=Foo
 *   @_exported import struct Foo.Bar → kind=reexport, source=Foo, name=Bar
 *
 * Import-kind (`struct`/`class`/…) is not a named tree-sitter child
 * (hidden `_import_kind` in 0.7.1). Read it from the statement text.
 * `@_exported` / `@testable` live on `modifiers`.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const IMPORT_KIND_TOKEN_RE = /^(struct|class|enum|protocol|func|let|var|typealias)\b/;

interface SwiftImportSpec {
  readonly source: string;
  readonly memberName: string;
  readonly fullPath: string;
  readonly testable: boolean;
  readonly exported: boolean;
  readonly importKind: string | null;
  readonly atNode: SyntaxNode;
}

export function splitSwiftImport(stmtNode: SyntaxNode): CaptureMatch | null {
  if (stmtNode.type !== 'import_declaration') return null;
  const spec = parseSwiftImport(stmtNode);
  if (spec === null) return null;
  return buildImportMatch(stmtNode, spec);
}

function parseSwiftImport(node: SyntaxNode): SwiftImportSpec | null {
  let testable = false;
  let exported = false;
  let identifierNode: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    if (child.type === 'modifiers') {
      if (swiftModifiersHaveAttribute(child.text, 'testable')) testable = true;
      if (swiftModifiersHaveAttribute(child.text, '_exported')) exported = true;
    } else if (child.type === 'identifier') {
      identifierNode = child;
    }
  }

  if (identifierNode === null) return null;

  const importKind = importKindFromClause(node, identifierNode);

  const segments: string[] = [];
  for (let i = 0; i < identifierNode.namedChildCount; i++) {
    const seg = identifierNode.namedChild(i);
    if (seg !== null && seg.type === 'simple_identifier') segments.push(seg.text);
  }
  if (segments.length === 0) {
    const raw = identifierNode.text.trim();
    if (raw === '') return null;
    segments.push(...raw.split('.'));
  }

  return {
    source: segments[0],
    memberName: segments.length > 1 ? segments[segments.length - 1] : segments[0],
    fullPath: segments.join('.'),
    testable,
    exported,
    importKind,
    atNode: node,
  };
}

function isSwiftIdentCont(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** First `word` outside comments and strings. Linear scan. */
function indexOfBareWord(text: string, word: string): number {
  let inString: '"' | "'" | null = null;
  let escape = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === '*' && next === '/') {
        blockCommentDepth--;
        i++;
      } else if (ch === '/' && next === '*') {
        blockCommentDepth++;
        i++;
      }
      continue;
    }
    if (inString !== null) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockCommentDepth = 1;
      i++;
      continue;
    }
    if (
      text.startsWith(word, i) &&
      !isSwiftIdentCont(text[i + word.length]) &&
      (i === 0 || !isSwiftIdentCont(text[i - 1]))
    ) {
      return i;
    }
  }
  return -1;
}

/** `@name` token in modifier text — not `_exported` / `testable` inside a string. */
function swiftModifiersHaveAttribute(text: string, name: 'testable' | '_exported'): boolean {
  let inString: '"' | "'" | null = null;
  let escape = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === '*' && next === '/') {
        blockCommentDepth--;
        i++;
      } else if (ch === '/' && next === '*') {
        blockCommentDepth++;
        i++;
      }
      continue;
    }
    if (inString !== null) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockCommentDepth = 1;
      i++;
      continue;
    }
    if (ch !== '@') continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text.startsWith(name, j) && !isSwiftIdentCont(text[j + name.length])) return true;
  }
  return false;
}

/** Kind token from the import clause only — skip `@available(..., message: "import struct")`. */
function importKindFromClause(node: SyntaxNode, identifierNode: SyntaxNode): string | null {
  const identRel = identifierNode.startIndex - node.startIndex;
  const before = identRel >= 0 ? node.text.slice(0, identRel) : node.text;
  const importAt = indexOfBareWord(before, 'import');
  const clause = importAt === -1 ? before : before.slice(importAt);
  return kindAfterImportKeyword(clause);
}

/** After `import`, skip whitespace and comments, then read a kind token. Linear: no nested-quantifier backtracking. */
function kindAfterImportKeyword(clause: string): string | null {
  const start = indexOfBareWord(clause, 'import');
  if (start === -1) return null;
  let i = start + 'import'.length;
  let skipped = false;
  while (i < clause.length) {
    const ch = clause[i];
    const next = clause[i + 1];
    if (/\s/.test(ch)) {
      skipped = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = clause.indexOf('\n', i + 2);
      if (nl === -1) return null;
      skipped = true;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < clause.length && depth > 0) {
        if (clause[i] === '/' && clause[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (clause[i] === '*' && clause[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) return null;
      skipped = true;
      continue;
    }
    break;
  }
  if (!skipped) return null;
  return IMPORT_KIND_TOKEN_RE.exec(clause.slice(i))?.[1] ?? null;
}

function bindingKind(spec: SwiftImportSpec): 'namespace' | 'named' | 'reexport' {
  if (spec.exported) return 'reexport';
  if (spec.importKind !== null && spec.fullPath.includes('.')) return 'named';
  return 'namespace';
}

function buildImportMatch(stmtNode: SyntaxNode, spec: SwiftImportSpec): CaptureMatch {
  const kind = bindingKind(spec);
  const nameText = kind === 'namespace' ? spec.fullPath : spec.memberName;
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, nameText),
  };
  if (spec.testable) {
    m['@import.testable'] = syntheticCapture('@import.testable', spec.atNode, '1');
  }
  return m;
}
