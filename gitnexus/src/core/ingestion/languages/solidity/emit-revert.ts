/**
 * Emit constructor-form call captures for `emit Event(...)` and `revert Error(...)`.
 *
 * Events and custom errors are indexed as Class-like symbols; constructor-form
 * CALLS (with `constructorCallTargetsClass`) link to those Class nodes.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import {
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

export function synthesizeEmitAndRevert(root: SyntaxNode, out: CaptureMatch[]): void {
  walkNamedTree(root, (node) => {
    if (node.type !== 'emit_statement' && node.type !== 'revert_statement') return;

    // First named child is the event/error identifier when present.
    // Bare `revert;` / `revert("msg")` may have string_literal first — skip those.
    const first = node.namedChild(0);
    if (!first) return;
    if (first.type !== 'identifier') return;

    const arity = Math.max(0, node.namedChildCount - 1);
    out.push({
      '@reference.call.constructor': nodeToCapture('@reference.call.constructor', first),
      '@reference.name': nodeToCapture('@reference.name', first),
      '@reference.arity': syntheticCapture('@reference.arity', first, String(arity)),
    });
  });
}
