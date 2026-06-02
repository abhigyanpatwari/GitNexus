/**
 * Decompose a Swift `import_declaration` into a `CaptureMatch` carrying
 * the synthesized markers `@import.kind` / `@import.source` /
 * `@import.name` / `@import.testable` that `interpretSwiftImport`
 * consumes.
 *
 * Swift imports are whole-module (no named members), so this is 1:1 —
 * one `import` produces exactly one import. The split layer exposes the
 * module name and the `@testable` flag without pushing raw-text parsing
 * into `interpret.ts`.
 *
 *   import Foundation        → kind=namespace, source=Foundation
 *   import Foo.Bar           → kind=namespace, source=Foo (SPM target),
 *                              name=Foo.Bar (full path, for reference)
 *   @testable import MyApp   → kind=namespace, source=MyApp, testable=1
 *
 * Verified against tree-sitter-swift 0.7.1:
 *   (import_declaration
 *     (modifiers (attribute (user_type (type_identifier))))?   ; @testable / @_exported
 *     (identifier (simple_identifier)+))                        ; one per dotted segment
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

interface SwiftImportSpec {
  /** SPM target name — the first dotted segment (`Foo` in `import Foo.Bar`). */
  readonly source: string;
  /** Full dotted module path (`Foo.Bar`). */
  readonly fullPath: string;
  /** True for `@testable import` (test-scope visibility; resolves identically). */
  readonly testable: boolean;
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
  let identifierNode: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    if (child.type === 'modifiers') {
      // Any attribute whose text mentions `testable` flips the flag.
      if (/\btestable\b/.test(child.text)) testable = true;
    } else if (child.type === 'identifier') {
      identifierNode = child;
    }
  }

  if (identifierNode === null) return null;

  // The module path is one or more simple_identifier children, one per
  // dotted segment. The SPM target is the FIRST segment.
  const segments: string[] = [];
  for (let i = 0; i < identifierNode.namedChildCount; i++) {
    const seg = identifierNode.namedChild(i);
    if (seg !== null && seg.type === 'simple_identifier') segments.push(seg.text);
  }
  if (segments.length === 0) {
    // Fall back to the raw identifier text (e.g. a grammar shape we didn't
    // anticipate). Split on `.` to recover the target segment.
    const raw = identifierNode.text.trim();
    if (raw === '') return null;
    const parts = raw.split('.');
    return { source: parts[0], fullPath: raw, testable, atNode: node };
  }

  return {
    source: segments[0],
    fullPath: segments.join('.'),
    testable,
    atNode: node,
  };
}

function buildImportMatch(stmtNode: SyntaxNode, spec: SwiftImportSpec): CaptureMatch {
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, 'namespace'),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.fullPath),
  };
  if (spec.testable) {
    m['@import.testable'] = syntheticCapture('@import.testable', spec.atNode, '1');
  }
  return m;
}
