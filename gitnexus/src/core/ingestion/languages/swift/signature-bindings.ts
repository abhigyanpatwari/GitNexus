/**
 * Synthesize parameter-type and function return-type `@type-binding.*`
 * captures for a Swift function-like node.
 *
 * Why synthesized rather than queried: Swift's tree-sitter grammar reuses
 * the field name `name:` for the function name, each parameter's label,
 * each parameter's type, AND the function's return type. A tree-sitter
 * query with two `name:` fields cross-assigns those captures and produces
 * garbage bindings (e.g. `save: save`). Reading the node via the existing
 * `swiftMethodConfig.extractParameters` / `extractReturnType` extractors
 * — which already handle the grammar correctly for the legacy parse path
 * — yields the right name→type pairs. This mirrors how receiver and arity
 * metadata are synthesized in `captures.ts` instead of queried.
 *
 *   - **Parameter bindings** anchor inside the function body so the
 *     binding lands in the Function scope: `func f(u: User) { u.save() }`
 *     → `u: User` visible in f's body.
 *   - **Return-type binding** anchors at the function node and carries
 *     `@type-binding.return`, which `swiftBindingScopeFor` hoists to the
 *     Module scope so `propagateImportedReturnTypes` mirrors it across
 *     files and callers see `let u = getUser(); u.save()`.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { swiftMethodConfig } from '../../method-extractors/configs/swift.js';

const NAMED_FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'protocol_function_declaration',
]);

export function synthesizeSwiftSignatureBindings(fnNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  // ── Parameter bindings (anchor in the body for Function-scope landing) ──
  const params = swiftMethodConfig.extractParameters?.(fnNode) ?? [];
  if (params.length > 0) {
    const bodyNode = fnNode.childForFieldName('body');
    // Anchor params inside the body when present; for bodyless protocol
    // requirements there is no Function scope to bind locals into, so skip.
    if (bodyNode !== null) {
      for (const p of params) {
        if (p.type === null || p.name === '') continue;
        out.push(buildBindingMatch(bodyNode, '@type-binding.parameter', p.name, p.type));
      }
    }
  }

  // ── Return-type binding (function name → return type, hoisted to Module) ──
  // Only named functions have a name to bind; init/deinit have no return.
  if (NAMED_FUNCTION_NODE_TYPES.has(fnNode.type)) {
    const funcName = swiftMethodConfig.extractName?.(fnNode);
    const returnType = swiftMethodConfig.extractReturnType?.(fnNode);
    if (
      funcName !== undefined &&
      funcName !== '' &&
      returnType !== undefined &&
      returnType !== ''
    ) {
      out.push(buildBindingMatch(fnNode, '@type-binding.return', funcName, returnType));
    }
  }

  return out;
}

function buildBindingMatch(
  anchorNode: SyntaxNode,
  sourceTag: '@type-binding.parameter' | '@type-binding.return',
  name: string,
  typeText: string,
): CaptureMatch {
  const m: Record<string, Capture> = {
    [sourceTag]: nodeToCapture(sourceTag, anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeText),
  };
  return m;
}
