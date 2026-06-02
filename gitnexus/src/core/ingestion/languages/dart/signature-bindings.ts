/**
 * Synthesize parameter-type and return-type bindings for a Dart function /
 * method. Mirror of `languages/swift/signature-bindings.ts`:
 *
 *   - Parameter bindings (`@type-binding.parameter`) are anchored on the
 *     `function_body` node so they land in the (synthesized) Function scope
 *     — the receiver of `param.method()` resolves against the param's type.
 *   - The return-type binding (`@type-binding.return`) is anchored on the
 *     declaration node and carries the function name → return type; the
 *     `bindingScopeFor` hook hoists it to the Module scope so callers (and
 *     `propagateImportedReturnTypes`) see `var u = getUser(); u.m()` resolve.
 *
 * Reuses `dartMethodConfig.extractParameters/extractName/extractReturnType`,
 * which descend the `method_signature`/`declaration` wrapper internally.
 */

import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';

function buildBindingMatch(
  anchor: SyntaxNode,
  sourceTag: '@type-binding.parameter' | '@type-binding.return',
  name: string,
  typeText: string,
): CaptureMatch {
  return {
    [sourceTag]: nodeToCapture(sourceTag, anchor),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchor, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchor, typeText),
  };
}

/**
 * `declNode` is the declaration wrapper. `bodyNode` is the resolved sibling
 * `function_body` (or `null` for a bodyless/abstract declaration, in which
 * case only the return binding is emitted).
 */
export function synthesizeDartSignatureBindings(
  declNode: SyntaxNode,
  bodyNode: SyntaxNode | null,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  if (bodyNode !== null) {
    const params = dartMethodConfig.extractParameters?.(declNode) ?? [];
    for (const p of params) {
      if (p.type === null || p.name === '') continue;
      out.push(buildBindingMatch(bodyNode, '@type-binding.parameter', p.name, p.type));
    }
  }

  const returnType = dartMethodConfig.extractReturnType?.(declNode);
  const funcName = dartMethodConfig.extractName?.(declNode);
  if (
    funcName !== undefined &&
    funcName !== '' &&
    returnType !== undefined &&
    returnType !== '' &&
    returnType !== 'void' &&
    returnType !== 'dynamic'
  ) {
    out.push(buildBindingMatch(declNode, '@type-binding.return', funcName, returnType));
  }

  return out;
}
