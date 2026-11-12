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
 *     An awaitable return (`Future<T>` / `FutureOr<T>`) is carried WHOLE —
 *     see `awaitableReturnSpelling`.
 *
 * Reuses `dartMethodConfig.extractParameters/extractName/extractReturnType`,
 * which descend the `method_signature`/`declaration` wrapper internally.
 */

import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';

const AWAITABLE_BASES: ReadonlySet<string> = new Set(['Future', 'FutureOr']);

const INNER_SIGNATURE_TYPES: ReadonlySet<string> = new Set([
  'function_signature',
  'getter_signature',
  'operator_signature',
]);

/**
 * `Future<User>` as written. tree-sitter-dart splits a generic return into a
 * `type_identifier` and a SIBLING `type_arguments`, and `extractReturnType`
 * reads only the former, so every generic return arrived bare and
 * `interpretDartTypeBinding` suppressed it as a container name. Only an
 * awaitable return is re-joined: the fold's await step unwraps it to what the
 * await yields (DART-04), while `List<User>` and the other containers keep
 * today's bare spelling — unwrapping those to the element would let a container
 * and its element share a method name and mint a wrong edge, and the binding
 * is for the FUNCTION's name, which a caller reads with or without an await.
 */
function awaitableReturnSpelling(declNode: SyntaxNode, bare: string): string | undefined {
  if (!AWAITABLE_BASES.has(bare)) return undefined;
  let inner: SyntaxNode | null = INNER_SIGNATURE_TYPES.has(declNode.type) ? declNode : null;
  for (let i = 0; inner === null && i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child !== null && INNER_SIGNATURE_TYPES.has(child.type)) inner = child;
  }
  if (inner === null) return undefined;
  for (let i = 0; i < inner.namedChildCount; i++) {
    const child = inner.namedChild(i);
    if (child === null || child.type !== 'type_identifier' || child.text !== bare) continue;
    const args = child.nextNamedSibling;
    return args !== null && args.type === 'type_arguments' ? `${bare}${args.text}` : undefined;
  }
  return undefined;
}

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
    out.push(
      buildBindingMatch(
        declNode,
        '@type-binding.return',
        funcName,
        awaitableReturnSpelling(declNode, returnType) ?? returnType,
      ),
    );
  }

  return out;
}
