import type { NameClaim } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** Preserve untyped declarations using the existing captured scope identities. */
export function collectKotlinNameClaims(
  root: SyntaxNode,
  scopeNodes: ReadonlySet<number>,
  typedLoopVariables: ReadonlySet<number>,
): ReadonlyMap<number, readonly NameClaim[]> {
  const claims = new Map<number, NameClaim[]>();
  const ordinaryNames = new Map<number, Set<string>>();
  const pending: Array<readonly [SyntaxNode, number | undefined]> = [[root, undefined]];
  while (pending.length > 0) {
    const [node, parentScope] = pending.pop()!;
    const scope = scopeNodes.has(node.id) ? node.id : parentScope;
    const children = node.namedChildren;
    const component =
      node.type === 'variable_declaration' &&
      ['multi_variable_declaration', 'when_subject'].includes(node.parent?.type ?? '');
    const constructorParameter =
      node.type === 'class_parameter' &&
      !children.some((child) => child.type === 'binding_pattern_kind');
    const loopVariable =
      node.type === 'variable_declaration' && node.parent?.type === 'for_statement';
    const ordinaryBinding =
      (node.type === 'variable_declaration' && node.parent?.type === 'property_declaration') ||
      (loopVariable && typedLoopVariables.has(node.id)) ||
      (node.type === 'class_parameter' && !constructorParameter) ||
      node.type === 'parameter';
    if (scope !== undefined && ordinaryBinding) {
      const identifier = children.find((child) => child.type === 'simple_identifier');
      if (identifier !== undefined) {
        const names = ordinaryNames.get(scope) ?? new Set<string>();
        names.add(identifier.text.replace(/^`(.*)`$/s, '$1'));
        ordinaryNames.set(scope, names);
      }
    }
    if (
      scope !== undefined &&
      (component || constructorParameter || (loopVariable && !typedLoopVariables.has(node.id)))
    ) {
      const identifier = children.find((child) => child.type === 'simple_identifier');
      if (identifier !== undefined && identifier.text !== '_') {
        const name = identifier.text.replace(/^`(.*)`$/s, '$1');
        const values = claims.get(scope) ?? [];
        values.push({
          name,
          range: nodeToCapture('', node).range,
          kind: 'binding',
          purpose: 'value',
        });
        claims.set(scope, values);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child !== undefined) pending.push([child, scope]);
    }
  }
  // Partial claims must not filter out an ordinary binding in the same scope.
  // That binding already prevents interpreting the head as a package name.
  for (const [scope, values] of claims) {
    const names = ordinaryNames.get(scope);
    if (names !== undefined) {
      const remaining = values.filter((claim) => !names.has(claim.name));
      if (remaining.length === 0) claims.delete(scope);
      else claims.set(scope, remaining);
    }
  }
  return claims;
}
