import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { objectiveCAssumeNonnullRanges, type ObjectiveCSourceRange } from './macro-semantics.js';

const assumeNonnullRangesByTree = new WeakMap<object, readonly ObjectiveCSourceRange[]>();

const NULLABILITY_ANNOTATION_BY_SPELLING = new Map<string, string>([
  ['nullable', 'objc:nullability:_Nullable'],
  ['_Nullable', 'objc:nullability:_Nullable'],
  ['__nullable', 'objc:nullability:_Nullable'],
  ['nonnull', 'objc:nullability:_Nonnull'],
  ['_Nonnull', 'objc:nullability:_Nonnull'],
  ['__nonnull', 'objc:nullability:_Nonnull'],
  ['null_unspecified', 'objc:nullability:_Null_unspecified'],
  ['_Null_unspecified', 'objc:nullability:_Null_unspecified'],
  ['__null_unspecified', 'objc:nullability:_Null_unspecified'],
  ['null_resettable', 'objc:nullability:null_resettable'],
]);

const IDENTIFIER_PATTERN = /[_\p{ID_Start}][_\p{ID_Continue}\u200C\u200D]*/gu;

function explicitNullabilityAnnotations(node: SyntaxNode): readonly string[] {
  const semanticNodes =
    node.type === 'property_declaration'
      ? [
          ...node.descendantsOfType('type_qualifier'),
          ...node.descendantsOfType('property_attribute'),
        ].sort((left, right) => left.startIndex - right.startIndex)
      : node.descendantsOfType('method_type');
  const annotations = new Set<string>();
  for (const semanticNode of semanticNodes) {
    for (const spelling of semanticNode.text.match(IDENTIFIER_PATTERN) ?? []) {
      const annotation = NULLABILITY_ANNOTATION_BY_SPELLING.get(spelling);
      if (annotation !== undefined) annotations.add(annotation);
    }
  }
  return [...annotations];
}

export function objectiveCAvailabilityAnnotations(node: SyntaxNode): readonly string[] {
  return node.namedChildren
    .filter((child) => child.type === 'availability_attribute_specifier')
    .map((availability) => availability.text.trim())
    .filter(Boolean)
    .map((availability) => `objc:availability:${availability}`);
}

export function objectiveCAssumeNonnullRangeContains(
  ranges: readonly ObjectiveCSourceRange[],
  start: number,
  end: number,
): boolean {
  // objectiveCAssumeNonnullRanges emits disjoint outermost regions in source order.
  let lower = 0;
  let upper = ranges.length - 1;
  let candidate: ObjectiveCSourceRange | undefined;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (range.start <= start) {
      candidate = range;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return candidate !== undefined && end <= candidate.end;
}

export function objectiveCNullabilityAnnotations(node: SyntaxNode): readonly string[] {
  const explicitAnnotations = explicitNullabilityAnnotations(node);
  if (explicitAnnotations.length > 0) return explicitAnnotations;

  let assumeNonnullRanges = assumeNonnullRangesByTree.get(node.tree);
  if (assumeNonnullRanges === undefined) {
    assumeNonnullRanges = objectiveCAssumeNonnullRanges(node.tree.rootNode.text);
    assumeNonnullRangesByTree.set(node.tree, assumeNonnullRanges);
  }
  return objectiveCAssumeNonnullRangeContains(assumeNonnullRanges, node.startIndex, node.endIndex)
    ? ['objc:nullability:assumed-nonnull']
    : [];
}
