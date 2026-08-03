import type { NodeLabel } from 'gitnexus-shared';

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { extractObjectiveCMethodSignature } from './selector.js';
import {
  objectiveCBlockName,
  objectiveCContainerIdentity,
  objectiveCKeyV1,
  objectiveCSourceIdentity,
  objectiveCSourceScope,
  type ObjectiveCContainerIdentity,
  type ObjectiveCSourceRole,
} from './identity.js';

export interface ObjectiveCDefinitionMetadata {
  readonly sourceIdentity?: string;
  readonly isStatic?: boolean;
  readonly annotations?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

function enclosingContainer(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current !== null) {
    if (
      current.type === 'class_interface' ||
      current.type === 'class_implementation' ||
      current.type === 'protocol_declaration'
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function sourceIdentity(
  label: NodeLabel,
  owner: string,
  declarationScope: string,
  sourceRole: ObjectiveCSourceRole,
  member: string,
): string {
  return objectiveCSourceIdentity({
    label,
    owner,
    declarationScope,
    sourceRole,
    member,
  });
}

function containerAnnotations(
  identity: ObjectiveCContainerIdentity,
  sourceRole: ObjectiveCSourceRole = identity.sourceRole,
): string[] {
  return [
    `objc:site:${sourceRole}`,
    `objc:owner:${identity.owner}`,
    ...(identity.isCategory ? [`objc:category:${identity.category}`] : []),
    ...(identity.isClassExtension ? ['objc:class-extension'] : []),
  ];
}

function propertyAttributes(node: SyntaxNode): string[] {
  return node
    .descendantsOfType('property_attribute')
    .map((attribute) => attribute.text.trim())
    .filter(Boolean);
}

function protocolRequirementTag(node: SyntaxNode): string | undefined {
  const container = enclosingContainer(node);
  if (container?.type !== 'protocol_declaration') return undefined;
  let current: SyntaxNode | null = node.parent;
  while (current !== null && current.id !== container.id) {
    if (current.type === 'qualified_protocol_interface_declaration') {
      return current.text.trimStart().startsWith('@optional')
        ? 'objc:protocol:optional'
        : 'objc:protocol:required';
    }
    current = current.parent;
  }
  return 'objc:protocol:required';
}

function propertyName(node: SyntaxNode): string | null {
  return (
    node.descendantsOfType('struct_declarator')[0]?.descendantsOfType('identifier').at(-1)?.text ??
    null
  );
}

function propertyAccessors(
  name: string,
  attributes: readonly string[],
): {
  readonly getterSelector: string;
  readonly setterSelector?: string;
} {
  const sign = attributes.includes('class') ? '+' : '-';
  const getter = attributes.find((attribute) => attribute.startsWith('getter='));
  const setter = attributes.find((attribute) => attribute.startsWith('setter='));
  const [first = '', ...rest] = Array.from(name);
  return {
    getterSelector: `${sign}${getter?.slice('getter='.length) ?? name}`,
    ...(attributes.includes('readonly')
      ? {}
      : {
          setterSelector: `${sign}${setter?.slice('setter='.length) ?? `set${first.toLocaleUpperCase()}${rest.join('')}:`}`,
        }),
  };
}

function categorySourceSite(
  node: SyntaxNode,
  nodeName: string,
): ObjectiveCDefinitionMetadata | null {
  const container = enclosingContainer(node);
  const identity = container === null ? null : objectiveCContainerIdentity(container);
  if (identity === null || (!identity.isCategory && !identity.isClassExtension)) return null;
  const declarationKey = objectiveCKeyV1([
    'category',
    identity.owner,
    identity.category ?? '<extension>',
  ]);
  return {
    sourceIdentity: sourceIdentity(
      'CodeElement',
      identity.owner,
      objectiveCSourceScope(identity),
      identity.sourceRole,
      nodeName,
    ),
    annotations: containerAnnotations(identity),
    properties: {
      sourceRole: identity.sourceRole,
      declarationKey,
      hostClassName: identity.owner,
      categoryName: identity.category ?? '<extension>',
    },
  };
}

/** Parsing-side metadata kept in exact lockstep with scope captures. */
export function extractObjectiveCDefinitionMetadata(
  node: SyntaxNode,
  nodeName: string,
  nodeLabel: NodeLabel,
): ObjectiveCDefinitionMetadata {
  if (nodeLabel === 'CodeElement') return categorySourceSite(node, nodeName) ?? {};

  if (node.type === 'class_declaration' || node.type === 'protocol_forward_declaration') {
    const sourceRole = 'forward-declaration' as const;
    const label = node.type === 'protocol_forward_declaration' ? 'Interface' : 'Class';
    return {
      sourceIdentity: sourceIdentity(label, nodeName, '<primary>', sourceRole, nodeName),
      annotations: ['objc:site:forward-declaration', `objc:owner:${nodeName}`],
      properties: {
        sourceRole,
        declarationKey: objectiveCKeyV1([label === 'Interface' ? 'protocol' : 'type', nodeName]),
      },
    };
  }

  if (node.type === 'block_literal') {
    const member = objectiveCBlockName(node);
    const blockContainer = enclosingContainer(node);
    const owner =
      blockContainer === null
        ? '<file>'
        : (objectiveCContainerIdentity(blockContainer)?.owner ?? '<file>');
    return {
      sourceIdentity: sourceIdentity('Function', owner, '<block>', 'implementation', member),
      annotations: ['objc:block-literal'],
      properties: { sourceRole: 'implementation' },
    };
  }

  const containerNode = enclosingContainer(node);
  const identity = containerNode === null ? null : objectiveCContainerIdentity(containerNode);
  if (identity === null) return {};

  if (nodeLabel === 'Class' || nodeLabel === 'Interface') {
    const hostRole: ObjectiveCSourceRole =
      identity.isCategory || identity.isClassExtension ? 'category-host' : identity.sourceRole;
    const keyKind = nodeLabel === 'Interface' ? 'protocol' : 'type';
    return {
      sourceIdentity: sourceIdentity(
        nodeLabel,
        identity.owner,
        objectiveCSourceScope(identity),
        hostRole,
        identity.owner,
      ),
      annotations: containerAnnotations(identity, hostRole),
      properties: {
        sourceRole: hostRole,
        declarationKey: objectiveCKeyV1([keyKind, identity.owner]),
        ...(hostRole === 'category-host'
          ? {
              categoryName: identity.category ?? '<extension>',
              hostClassName: identity.owner,
            }
          : {}),
      },
    };
  }

  const method = extractObjectiveCMethodSignature(node);
  if (method !== null) {
    const declarationKey = objectiveCKeyV1([
      'method',
      identity.owner,
      identity.declarationScope,
      method.signedSelector,
    ]);
    return {
      sourceIdentity: sourceIdentity(
        'Method',
        identity.owner,
        objectiveCSourceScope(identity),
        identity.sourceRole,
        method.signedSelector,
      ),
      isStatic: method.kind === 'class',
      annotations: [
        ...containerAnnotations(identity),
        ...(protocolRequirementTag(node) === undefined ? [] : [protocolRequirementTag(node)!]),
        `objc:method-kind:${method.kind}`,
      ],
      properties: {
        selector: method.selector,
        sourceRole: identity.sourceRole,
        declarationKey,
        dispatchKey: objectiveCKeyV1(['dispatch', identity.owner, method.signedSelector]),
        ...(identity.isCategory
          ? { categoryName: identity.category, hostClassName: identity.owner }
          : identity.isClassExtension
            ? { categoryName: '<extension>', hostClassName: identity.owner }
            : {}),
      },
    };
  }

  if (node.type === 'property_declaration') {
    const name = propertyName(node) ?? nodeName;
    const attributes = propertyAttributes(node);
    const accessors = propertyAccessors(name, attributes);
    const protocolRequirement = protocolRequirementTag(node);
    return {
      sourceIdentity: sourceIdentity(
        'Property',
        identity.owner,
        objectiveCSourceScope(identity),
        identity.sourceRole,
        name,
      ),
      isStatic: attributes.includes('class'),
      annotations: [
        ...containerAnnotations(identity),
        ...(protocolRequirement === undefined ? [] : [protocolRequirement]),
        ...attributes.map((attribute) => `objc:property:${attribute}`),
      ],
      properties: {
        sourceRole: identity.sourceRole,
        declarationKey: objectiveCKeyV1([
          'property',
          identity.owner,
          identity.declarationScope,
          name,
        ]),
        ...accessors,
      },
    };
  }

  if (node.type === 'instance_variable') {
    return {
      sourceIdentity: sourceIdentity(
        'Variable',
        identity.owner,
        objectiveCSourceScope(identity),
        identity.sourceRole,
        nodeName,
      ),
      annotations: [...containerAnnotations(identity), 'objc:ivar'],
      properties: { sourceRole: identity.sourceRole, hostClassName: identity.owner },
    };
  }

  return {};
}
