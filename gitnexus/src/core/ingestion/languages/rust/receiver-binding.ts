import type { CaptureMatch } from 'gitnexus-shared';
import { syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Given a function_item node that is inside an impl_item, synthesize a
 * self-type-binding capture if the function has a `self_parameter`.
 *
 * The impl_item structure:
 *   impl [TraitName for] TypeName { fn method(&self) { ... } }
 */
export function synthesizeRustReceiverBinding(
  fnNode: SyntaxNode,
  implNode: SyntaxNode | null,
): CaptureMatch | null {
  if (fnNode.type !== 'function_item') return null;
  if (implNode === null) return null;

  const params = fnNode.childForFieldName('parameters');
  if (params === null) return null;

  let hasSelf = false;
  for (let i = 0; i < params.namedChildCount; i++) {
    if (params.namedChild(i)?.type === 'self_parameter') {
      hasSelf = true;
      break;
    }
  }
  if (!hasSelf) return null;

  const implType = getImplTargetType(implNode);
  if (implType === null) return null;

  return {
    '@type-binding.self': syntheticCapture('@type-binding.self', fnNode, 'self'),
    '@type-binding.name': syntheticCapture('@type-binding.name', fnNode, 'self'),
    '@type-binding.type': syntheticCapture('@type-binding.type', fnNode, implType),
  };
}

/**
 * Extract the target type from an impl_item.
 * `impl TypeName { ... }` → "TypeName"
 * `impl TraitName for TypeName { ... }` → "TypeName"
 */
export function getImplTargetType(implNode: SyntaxNode): string | null {
  if (implNode.type !== 'impl_item') return null;

  // Look for `for` keyword — if present, impl is `impl Trait for Type`
  let hasFor = false;
  let typeAfterFor: SyntaxNode | null = null;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (child === null) continue;
    if (child.type === 'for') {
      hasFor = true;
      continue;
    }
    if (hasFor && child.type === 'type_identifier') {
      typeAfterFor = child;
      break;
    }
    if (hasFor && child.type === 'scoped_type_identifier') {
      typeAfterFor = child;
      break;
    }
    if (hasFor && child.type === 'generic_type') {
      typeAfterFor = child;
      break;
    }
  }
  if (hasFor && typeAfterFor !== null) {
    return normalizeRustTypeName(typeAfterFor.text);
  }

  // No `for` keyword: impl TypeName { ... }
  const typeField = implNode.childForFieldName('type');
  if (typeField !== null) {
    return normalizeRustTypeName(typeField.text);
  }

  // Fallback: find first type_identifier after `impl`
  let afterImpl = false;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (child === null) continue;
    if (child.type === 'impl') {
      afterImpl = true;
      continue;
    }
    if (afterImpl && (child.type === 'type_identifier' || child.type === 'generic_type')) {
      return normalizeRustTypeName(child.text);
    }
  }
  return null;
}

/**
 * Extract the trait name from an impl_item when it's `impl Trait for Type`.
 */
export function getImplTraitName(implNode: SyntaxNode): string | null {
  if (implNode.type !== 'impl_item') return null;

  let afterImpl = false;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (child === null) continue;
    if (child.type === 'impl') {
      afterImpl = true;
      continue;
    }
    if (child.type === 'for') {
      break;
    }
    if (
      afterImpl &&
      (child.type === 'type_identifier' || child.type === 'scoped_type_identifier')
    ) {
      for (let j = i + 1; j < implNode.childCount; j++) {
        const next = implNode.child(j);
        if (next === null) continue;
        if (next.type === 'for') {
          return normalizeRustTypeName(child.text);
        }
        break;
      }
    }
  }
  return null;
}

// NOTE: this strips reference/pointer sigils and generic arguments but NOT a
// path qualifier, so `crate::traits::Drawable` stays qualified here — whereas
// the inheritance synth (rust/captures.ts `bareTypeIdentifier`) resolves scoped
// bases by their trailing simple name (`Drawable`). The two intentionally
// diverge for scoped paths. This is inert today (`getImplTraitName` has no
// ingestion consumer and Rust's `isSuperReceiver` is false, so nothing keys an
// edge on this name); the synth is the single source of truth for the
// inheritance edge. A future change that wires `getImplTraitName` into
// resolution must reconcile this with the synth's tail-only normalization.
function normalizeRustTypeName(text: string): string {
  let t = text.trim();
  while (t.startsWith('&')) t = t.replace(/^&\s*(mut\s+)?/, '');
  while (t.startsWith('*')) t = t.slice(1).trim();
  const bracket = t.indexOf('<');
  if (bracket !== -1) t = t.slice(0, bracket);
  return t.trim();
}
