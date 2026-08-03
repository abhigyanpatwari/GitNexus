import type { SyntaxNode } from '../../utils/ast-helpers.js';

export type ObjectiveCSourceRole =
  | 'declaration'
  | 'implementation'
  | 'category-host'
  | 'forward-declaration'
  | 'synthesized';

export interface ObjectiveCContainerIdentity {
  readonly owner: string;
  readonly category: string | null;
  readonly declarationScope: '<primary>' | string;
  readonly sourceRole: ObjectiveCSourceRole;
  readonly isCategory: boolean;
  readonly isClassExtension: boolean;
}

function normalized(value: string): string {
  return value.normalize('NFC');
}

/** Deterministic, delimiter-safe key used by Objective-C source-site metadata. */
export function objectiveCKeyV1(parts: readonly string[]): string {
  return `objc:v1:${JSON.stringify(parts.map(normalized))}`;
}

export function objectiveCSourceIdentity(input: {
  readonly label: string;
  readonly owner: string;
  readonly declarationScope: string;
  readonly sourceRole: ObjectiveCSourceRole;
  readonly member: string;
}): string {
  return objectiveCKeyV1([
    'source',
    input.label,
    input.owner,
    input.declarationScope,
    input.sourceRole,
    input.member,
  ]);
}

function directIdentifier(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === 'identifier');
}

/** Identify the logical Objective-C owner/category represented by a type container. */
export function objectiveCContainerIdentity(
  node: SyntaxNode,
): ObjectiveCContainerIdentity | null {
  if (
    node.type !== 'class_interface' &&
    node.type !== 'class_implementation' &&
    node.type !== 'protocol_declaration'
  ) {
    return null;
  }

  const owner = directIdentifier(node)?.text;
  if (owner === undefined) return null;
  const category = node.childForFieldName('category')?.text ?? null;
  const hasCategoryParens = node.children.some((child) => child.text === '(');
  const isCategory = category !== null;
  const isClassExtension = category === null && hasCategoryParens;
  const sourceRole: ObjectiveCSourceRole =
    node.type === 'class_implementation' ? 'implementation' : 'declaration';

  return {
    owner,
    category,
    declarationScope: isCategory ? category : '<primary>',
    sourceRole,
    isCategory,
    isClassExtension,
  };
}

export function objectiveCCategoryDisplayName(identity: ObjectiveCContainerIdentity): string {
  return `${identity.owner}(${identity.category ?? '<extension>'})`;
}

/** Physical source scope; class extensions stay logically primary but need distinct source ids. */
export function objectiveCSourceScope(identity: ObjectiveCContainerIdentity): string {
  return identity.isClassExtension ? '<extension>' : identity.declarationScope;
}

export function objectiveCBlockName(node: SyntaxNode): string {
  return `block@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
}
