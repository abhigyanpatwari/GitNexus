/**
 * Synthesize `@reference.call.free` captures for FastAPI `Depends(callable)`
 * parameter defaults.
 *
 * `Depends(get_db)` passes `get_db` as a callable that the DI framework
 * calls on every request. The route handler is functionally a caller of
 * the dependency — impact analysis needs that edge.
 *
 * Tree-sitter can't express "the first argument of a call named Depends
 * inside a parameter default" in a single static query, so we synthesize
 * reference captures in code, mirroring the receiver-binding pattern.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Inspect a `function_definition` node's parameters for `Depends(callable)`
 * defaults. Returns one `@reference.call.free` CaptureMatch per dependency.
 */
export function synthesizeDependsReferences(fnNode: SyntaxNode): readonly CaptureMatch[] {
  const params = fnNode.childForFieldName('parameters');
  if (params === null) return [];

  const results: CaptureMatch[] = [];

  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (param === null) continue;

    if (param.type !== 'typed_default_parameter' && param.type !== 'default_parameter') {
      continue;
    }

    const defaultValue = param.childForFieldName('value') ?? param.childForFieldName('default');
    if (defaultValue === null) continue;

    const callNode = defaultValue.type === 'call' ? defaultValue : null;
    if (callNode === null) continue;

    const fnIdent = callNode.childForFieldName('function');
    if (fnIdent === null || fnIdent.type !== 'identifier' || fnIdent.text !== 'Depends') continue;

    const args = callNode.childForFieldName('arguments');
    if (args === null || args.namedChildCount === 0) continue;

    const firstArg = args.namedChild(0);
    if (firstArg === null) continue;

    if (firstArg.type === 'identifier') {
      results.push({
        '@reference.call.free': nodeToCapture('@reference.call.free', firstArg),
        '@reference.name': nodeToCapture('@reference.name', firstArg),
      });
      continue;
    }

    if (firstArg.type === 'attribute') {
      const attrName = firstArg.childForFieldName('attribute');
      const obj = firstArg.childForFieldName('object');
      if (attrName !== null && obj !== null) {
        results.push({
          '@reference.call.member': nodeToCapture('@reference.call.member', attrName),
          '@reference.name': nodeToCapture('@reference.name', attrName),
          '@reference.receiver': nodeToCapture('@reference.receiver', obj),
        });
      }
    }
  }

  return results;
}
