import type { Capture, CaptureMatch } from 'gitnexus-shared';

import { processCFamilyScopeMatches } from '../c/captures.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import {
  extractObjectiveCMessageSend,
  extractObjectiveCMethodSignature,
  extractObjectiveCSubscriptSend,
} from './selector.js';
import {
  objectiveCBlockName,
  objectiveCCategoryDisplayName,
  objectiveCContainerIdentity,
  objectiveCSourceIdentity,
  objectiveCSourceScope,
} from './identity.js';
import {
  getObjectiveCCFamilyScopeQuery,
  getObjectiveCParser,
  getObjectiveCScopeQuery,
} from './query.js';
import {
  objectiveCMacroAnnotation,
  preprocessObjectiveCMacroWrappers,
} from './macro-semantics.js';

function enclosingTypeName(node: SyntaxNode): string | null {
  let current = node.parent;
  while (current !== null) {
    if (
      current.type === 'class_interface' ||
      current.type === 'class_implementation' ||
      current.type === 'protocol_declaration'
    ) {
      return current.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}

function enclosingTypeNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
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

function declarationMetadata(
  anchor: SyntaxNode,
  input: {
    readonly label: string;
    readonly owner: string;
    readonly declarationScope: string;
    readonly sourceRole:
      | 'declaration'
      | 'implementation'
      | 'category-host'
      | 'forward-declaration'
      | 'synthesized';
    readonly member: string;
    readonly annotations: readonly string[];
  },
): Pick<CaptureMatch, '@declaration.annotations' | '@declaration.source-identity'> {
  return {
    '@declaration.annotations': syntheticCapture(
      '@declaration.annotations',
      anchor,
      JSON.stringify(input.annotations),
    ),
    '@declaration.source-identity': syntheticCapture(
      '@declaration.source-identity',
      anchor,
      objectiveCSourceIdentity(input),
    ),
  };
}

function containerTags(node: SyntaxNode): readonly string[] {
  const identity = objectiveCContainerIdentity(node);
  if (identity === null) return [];
  const tags = [`objc:site:${identity.sourceRole}`, `objc:owner:${identity.owner}`];
  for (const availability of node.descendantsOfType('availability_attribute_specifier')) {
    const text = availability.text.trim();
    if (text.length > 0) tags.push(`objc:availability:${text}`);
  }
  if (identity.isCategory) tags.push(`objc:category:${identity.category}`);
  if (identity.isClassExtension) tags.push('objc:class-extension');
  return tags;
}

function nullabilityTags(node: SyntaxNode): readonly string[] {
  return node
    .descendantsOfType('type_qualifier')
    .map((qualifier) => qualifier.text.trim())
    .filter((qualifier) => /^_(?:Nullable|Nonnull|Null_unspecified)$/.test(qualifier))
    .map((qualifier) => `objc:nullability:${qualifier}`);
}

function protocolRequirementTag(node: SyntaxNode): string | undefined {
  if (enclosingTypeNode(node)?.type !== 'protocol_declaration') return undefined;
  let current: SyntaxNode | null = node.parent;
  while (current !== null && current.type !== 'protocol_declaration') {
    if (current.type === 'qualified_protocol_interface_declaration') {
      return current.text.trimStart().startsWith('@optional')
        ? 'objc:protocol:optional'
        : 'objc:protocol:required';
    }
    current = current.parent;
  }
  return 'objc:protocol:required';
}

function propertyAttributes(node: SyntaxNode): string[] {
  return node
    .descendantsOfType('property_attribute')
    .map((attribute) => attribute.text.trim())
    .filter((attribute) => attribute.length > 0);
}

function declarationTypeAndName(
  declaration: SyntaxNode,
): { readonly nameNode: SyntaxNode; readonly declaredType: string } | null {
  const declarator = declaration.namedChildren.find((child) => child.type === 'struct_declarator');
  if (declarator === undefined) return null;
  const nameNode = declarator.descendantsOfType('identifier').at(-1);
  if (nameNode === undefined) return null;
  const baseType = declaration.namedChildren
    .filter((child) => child.id !== declarator.id)
    .map((child) => child.text.trim())
    .filter(Boolean)
    .join(' ');
  const declaratorPrefix = declarator.text.replace(nameNode.text, '').trim();
  return {
    nameNode,
    declaredType: `${baseType}${declaratorPrefix ? ` ${declaratorPrefix}` : ''}`.trim(),
  };
}

function setterSelectorFor(propertyName: string): string {
  const [first = '', ...rest] = Array.from(propertyName);
  return `set${first.toLocaleUpperCase()}${rest.join('')}:`;
}

function propertyAccessorCaptures(property: SyntaxNode, ownerNode: SyntaxNode): CaptureMatch[] {
  const declaration = property.descendantsOfType('struct_declaration')[0];
  if (declaration === undefined) return [];
  const propertyInfo = declarationTypeAndName(declaration);
  const ownerIdentity = objectiveCContainerIdentity(ownerNode);
  if (propertyInfo === null || ownerIdentity === null) return [];

  const attributes = propertyAttributes(property);
  const isClassProperty = attributes.includes('class');
  const sign = isClassProperty ? '+' : '-';
  const customGetter = attributes.find((attribute) => attribute.startsWith('getter='));
  const customSetter = attributes.find((attribute) => attribute.startsWith('setter='));
  const getter = `${sign}${customGetter?.slice('getter='.length) ?? propertyInfo.nameNode.text}`;
  const setterName =
    customSetter?.slice('setter='.length) ?? setterSelectorFor(propertyInfo.nameNode.text);
  const protocolRequirement = protocolRequirementTag(property);
  const commonAnnotations = [
    'objc:site:declaration',
    `objc:method-kind:${isClassProperty ? 'class' : 'instance'}`,
    `objc:owner:${ownerIdentity.owner}`,
    ...(ownerIdentity.isCategory ? [`objc:category:${ownerIdentity.category}`] : []),
    ...(ownerIdentity.isClassExtension ? ['objc:class-extension'] : []),
    ...(protocolRequirement === undefined ? [] : [protocolRequirement]),
    ...nullabilityTags(property),
    'objc:property-accessor',
    `objc:property-name:${propertyInfo.nameNode.text}`,
  ];

  const makeAccessor = (
    signedSelector: string,
    parameterTypes: readonly string[],
    returnType: string,
  ): CaptureMatch => ({
    '@declaration.method': nodeToCapture('@declaration.method', property),
    '@declaration.name': syntheticCapture('@declaration.name', property, signedSelector),
    '@declaration.parameter-count': syntheticCapture(
      '@declaration.parameter-count',
      property,
      String(parameterTypes.length),
    ),
    '@declaration.required-parameter-count': syntheticCapture(
      '@declaration.required-parameter-count',
      property,
      String(parameterTypes.length),
    ),
    '@declaration.parameter-types': syntheticCapture(
      '@declaration.parameter-types',
      property,
      JSON.stringify(parameterTypes),
    ),
    '@declaration.return-type': syntheticCapture('@declaration.return-type', property, returnType),
    '@declaration.is-static': syntheticCapture(
      '@declaration.is-static',
      property,
      String(isClassProperty),
    ),
    ...declarationMetadata(property, {
      label: 'Method',
      owner: ownerIdentity.owner,
      declarationScope: objectiveCSourceScope(ownerIdentity),
      sourceRole: 'declaration',
      member: signedSelector,
      annotations: commonAnnotations,
    }),
  });

  const out = [makeAccessor(getter, [], propertyInfo.declaredType)];
  if (!attributes.includes('readonly')) {
    out.push(makeAccessor(`${sign}${setterName}`, [propertyInfo.declaredType], 'void'));
  }
  return out;
}

function advancedDeclarationCaptures(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  for (const node of [
    ...root.descendantsOfType('class_interface'),
    ...root.descendantsOfType('class_implementation'),
  ]) {
    const identity = objectiveCContainerIdentity(node);
    if (identity === null || (!identity.isCategory && !identity.isClassExtension)) continue;
    const name = objectiveCCategoryDisplayName(identity);
    const annotations = containerTags(node);
    out.push({
      '@declaration.code-element': nodeToCapture('@declaration.code-element', node),
      '@declaration.name': syntheticCapture('@declaration.name', node, name),
      ...declarationMetadata(node, {
        label: 'CodeElement',
        owner: identity.owner,
        declarationScope: objectiveCSourceScope(identity),
        sourceRole: identity.sourceRole,
        member: name,
        annotations,
      }),
    });
  }

  for (const selectorExpression of root.descendantsOfType('selector_expression')) {
    const match = selectorExpression.text.trim().match(/^@selector\((.*)\)$/s);
    const selector = match?.[1]?.trim();
    if (selector === undefined || selector.length === 0) continue;
    const container = enclosingTypeNode(selectorExpression);
    const identity = container === null ? null : objectiveCContainerIdentity(container);
    const owner = identity?.owner ?? '<file>';
    const sourceRole = identity?.sourceRole ?? 'implementation';
    const name = `@selector(${selector})`;
    out.push({
      '@declaration.code-element': nodeToCapture('@declaration.code-element', selectorExpression),
      '@declaration.name': syntheticCapture('@declaration.name', selectorExpression, name),
      ...declarationMetadata(selectorExpression, {
        label: 'CodeElement',
        owner,
        declarationScope: '<selector>',
        sourceRole,
        member: name,
        annotations: ['objc:selector-reference', `objc:selector:${selector}`],
      }),
    });
  }

  for (const enumSpecifier of root.descendantsOfType('enum_specifier')) {
    const annotation = objectiveCMacroAnnotation(enumSpecifier.text);
    const name = enumSpecifier.namedChildren.find((child) => child.type === 'type_identifier')?.text;
    if (annotation === null || name === undefined || name.length === 0) continue;
    out.push({
      '@declaration.code-element': nodeToCapture('@declaration.code-element', enumSpecifier),
      '@declaration.name': syntheticCapture('@declaration.name', enumSpecifier, name),
      ...declarationMetadata(enumSpecifier, {
        label: 'CodeElement',
        owner: name,
        declarationScope: '<primary>',
        sourceRole: 'declaration',
        member: name,
        annotations: [annotation, `objc:owner:${name}`],
      }),
    });
  }

  for (const declaration of root.descendantsOfType('class_declaration')) {
    for (const nameNode of declaration.namedChildren.filter(
      (child) => child.type === 'identifier',
    )) {
      out.push({
        '@declaration.class': nodeToCapture('@declaration.class', declaration),
        '@declaration.name': nodeToCapture('@declaration.name', nameNode),
        ...declarationMetadata(declaration, {
          label: 'Class',
          owner: nameNode.text,
          declarationScope: '<primary>',
          sourceRole: 'forward-declaration',
          member: nameNode.text,
          annotations: ['objc:site:forward-declaration', `objc:owner:${nameNode.text}`],
        }),
      });
    }
  }

  for (const declaration of root.descendantsOfType('protocol_forward_declaration')) {
    for (const nameNode of declaration.namedChildren.filter(
      (child) => child.type === 'identifier',
    )) {
      out.push({
        '@declaration.interface': nodeToCapture('@declaration.interface', declaration),
        '@declaration.name': nodeToCapture('@declaration.name', nameNode),
        ...declarationMetadata(declaration, {
          label: 'Interface',
          owner: nameNode.text,
          declarationScope: '<primary>',
          sourceRole: 'forward-declaration',
          member: nameNode.text,
          annotations: ['objc:site:forward-declaration', `objc:owner:${nameNode.text}`],
        }),
      });
    }
  }

  for (const moduleImport of root.descendantsOfType('module_import')) {
    const path = moduleImport.childForFieldName('path');
    if (path === null || path.text.trim().length === 0) continue;
    out.push({
      '@import.module': nodeToCapture('@import.module', moduleImport),
      '@import.statement': nodeToCapture('@import.statement', moduleImport),
      '@import.source': syntheticCapture('@import.source', path, path.text.trim()),
    });
  }

  for (const instanceVariable of root.descendantsOfType('instance_variable')) {
    const declaration = instanceVariable.namedChildren.find(
      (child) => child.type === 'struct_declaration',
    );
    const info = declaration === undefined ? null : declarationTypeAndName(declaration);
    const ownerNode = enclosingTypeNode(instanceVariable);
    const owner = ownerNode === null ? null : objectiveCContainerIdentity(ownerNode);
    if (info === null || owner === null) continue;
    out.push({
      '@declaration.variable': nodeToCapture('@declaration.variable', instanceVariable),
      '@declaration.name': nodeToCapture('@declaration.name', info.nameNode),
      '@declaration.field-type': syntheticCapture(
        '@declaration.field-type',
        declaration!,
        info.declaredType,
      ),
      ...declarationMetadata(instanceVariable, {
        label: 'Variable',
        owner: owner.owner,
        declarationScope: objectiveCSourceScope(owner),
        sourceRole: owner.sourceRole,
        member: info.nameNode.text,
        annotations: [`objc:site:${owner.sourceRole}`, `objc:owner:${owner.owner}`, 'objc:ivar'],
      }),
    });
  }

  for (const implementation of root.descendantsOfType('property_implementation')) {
    const ownerNode = enclosingTypeNode(implementation);
    const owner = ownerNode === null ? null : objectiveCContainerIdentity(ownerNode);
    if (owner === null || owner.sourceRole !== 'implementation') continue;
    const trimmed = implementation.text.trim();
    const kind = trimmed.startsWith('@dynamic') ? 'dynamic' : 'synthesize';
    const body = trimmed.replace(/^@(dynamic|synthesize)\s+/, '').replace(/;\s*$/, '');
    for (const rawPart of body.split(',')) {
      const [rawName, rawBacking] = rawPart.split('=', 2);
      const name = rawName?.trim() ?? '';
      if (name.length === 0) continue;
      const backing = rawBacking?.trim() || `_${name}`;
      const annotations = [
        'objc:site:implementation',
        `objc:owner:${owner.owner}`,
        `objc:property-implementation:${kind}`,
        ...(kind === 'synthesize' ? [`objc:backing-ivar:${backing}`] : []),
      ];
      out.push({
        '@declaration.property': nodeToCapture('@declaration.property', implementation),
        '@declaration.name': syntheticCapture('@declaration.name', implementation, name),
        ...declarationMetadata(implementation, {
          label: 'Property',
          owner: owner.owner,
          declarationScope: '<primary>',
          sourceRole: 'implementation',
          member: `@${kind}:${name}`,
          annotations,
        }),
      });
    }
  }

  for (const typedef of root.descendantsOfType('type_definition')) {
    const blockPointer = typedef.descendantsOfType('block_pointer_declarator')[0];
    const nameNode = blockPointer?.descendantsOfType('type_identifier').at(-1);
    if (blockPointer === undefined || nameNode === undefined) continue;
    out.push({
      '@declaration.typedef': nodeToCapture('@declaration.typedef', typedef),
      '@declaration.name': nodeToCapture('@declaration.name', nameNode),
      '@declaration.annotations': syntheticCapture(
        '@declaration.annotations',
        typedef,
        JSON.stringify(['objc:block-typedef']),
      ),
    });
  }

  for (const block of root.descendantsOfType('block_literal')) {
    const blockName = objectiveCBlockName(block);
    const parameters = block
      .descendantsOfType('parameter_declaration')
      .filter((parameter) => parameter.parent?.type === 'parameter_list');
    const parameterTypes = parameters.map(
      (parameter) => parameter.childForFieldName('type')?.text.trim() ?? 'unknown',
    );
    out.push({
      '@scope.function': nodeToCapture('@scope.function', block),
      '@declaration.function': nodeToCapture('@declaration.function', block),
      '@declaration.name': syntheticCapture('@declaration.name', block, blockName),
      '@declaration.parameter-count': syntheticCapture(
        '@declaration.parameter-count',
        block,
        String(parameterTypes.length),
      ),
      '@declaration.required-parameter-count': syntheticCapture(
        '@declaration.required-parameter-count',
        block,
        String(parameterTypes.length),
      ),
      '@declaration.parameter-types': syntheticCapture(
        '@declaration.parameter-types',
        block,
        JSON.stringify(parameterTypes),
      ),
      ...declarationMetadata(block, {
        label: 'Function',
        owner: enclosingTypeName(block) ?? '<file>',
        declarationScope: '<block>',
        sourceRole: 'implementation',
        member: blockName,
        annotations: ['objc:block-literal'],
      }),
    });

    const initializer = block.parent?.type === 'init_declarator' ? block.parent : null;
    const declarator = initializer?.childForFieldName('declarator');
    const destination = declarator?.descendantsOfType('identifier').at(-1);
    if (initializer === null || destination === undefined) continue;
    out.push({
      '@callable-flow.seed': nodeToCapture('@callable-flow.seed', initializer),
      '@callable-flow.destination': nodeToCapture('@callable-flow.destination', destination),
      '@callable-flow.destination-kind': syntheticCapture(
        '@callable-flow.destination-kind',
        destination,
        'binding',
      ),
      '@callable-flow.target': syntheticCapture('@callable-flow.target', block, blockName),
      '@callable-flow.target-name': syntheticCapture(
        '@callable-flow.target-name',
        block,
        blockName,
      ),
      '@callable-flow.expected-arity': syntheticCapture(
        '@callable-flow.expected-arity',
        block,
        String(parameterTypes.length),
      ),
      '@callable-flow.expected-types': syntheticCapture(
        '@callable-flow.expected-types',
        block,
        JSON.stringify(parameterTypes),
      ),
    });

    for (const call of root.descendantsOfType('call_expression')) {
      const callee = call.childForFieldName('function');
      if (callee?.type !== 'identifier' || callee.text !== destination.text) continue;
      const argumentsNode = call.childForFieldName('arguments');
      const arity = argumentsNode?.namedChildCount ?? 0;
      out.push({
        '@callable-flow.invoke': nodeToCapture('@callable-flow.invoke', call),
        '@callable-flow.callee': nodeToCapture('@callable-flow.callee', callee),
        '@callable-flow.callee-kind': syntheticCapture(
          '@callable-flow.callee-kind',
          callee,
          'binding',
        ),
        '@callable-flow.invocation-kind': syntheticCapture(
          '@callable-flow.invocation-kind',
          call,
          'indirect',
        ),
        '@callable-flow.arity': syntheticCapture('@callable-flow.arity', call, String(arity)),
      });
    }
  }

  return out;
}

function synthesizeMethodBindings(node: SyntaxNode, owner: string): CaptureMatch[] {
  const out: CaptureMatch[] = [
    {
      '@type-binding.self': nodeToCapture('@type-binding.self', node),
      '@type-binding.name': syntheticCapture('@type-binding.name', node, 'self'),
      '@type-binding.type': syntheticCapture('@type-binding.type', node, owner),
    },
  ];

  for (const parameter of node.namedChildren.filter((child) => child.type === 'method_parameter')) {
    const typeNode = parameter.namedChildren.find((child) => child.type === 'method_type');
    const nameNode = [...parameter.namedChildren]
      .reverse()
      .find((child) => child.type === 'identifier');
    if (typeNode === undefined || nameNode === undefined) continue;
    const rawType = typeNode.text
      .trim()
      .replace(/^\(|\)$/g, '')
      .trim();
    out.push({
      '@type-binding.parameter': nodeToCapture('@type-binding.parameter', parameter),
      '@type-binding.name': nodeToCapture('@type-binding.name', nameNode),
      '@type-binding.type': syntheticCapture('@type-binding.type', typeNode, rawType),
    });
  }
  return out;
}

function inheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const node of [
    ...root.descendantsOfType('class_interface'),
    ...root.descendantsOfType('protocol_declaration'),
  ]) {
    const bases: SyntaxNode[] = [];
    const superclass = node.childForFieldName('superclass');
    if (superclass !== null) bases.push(superclass);
    for (const list of node.namedChildren.filter(
      (child) =>
        child.type === 'parameterized_arguments' || child.type === 'protocol_reference_list',
    )) {
      bases.push(
        ...list
          .descendantsOfType(['identifier', 'type_identifier'])
          .filter((base) => base.text.length > 0),
      );
    }
    for (const base of bases) {
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', base),
        '@reference.name': nodeToCapture('@reference.name', base),
      });
    }
  }
  return out;
}

export function emitObjectiveCScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  const parseText =
    cachedTree === undefined ? preprocessObjectiveCMacroWrappers(sourceText, _filePath) : sourceText;
  const tree =
    (cachedTree as ReturnType<ReturnType<typeof getObjectiveCParser>['parse']> | undefined) ??
    parseSourceSafe(getObjectiveCParser(), parseText, undefined, {
      bufferSize: getTreeSitterBufferSize(parseText),
    });
  const out: CaptureMatch[] = [
    ...processCFamilyScopeMatches(
      getObjectiveCCFamilyScopeQuery().matches(tree.rootNode),
      tree.rootNode,
      _filePath,
    ),
  ];

  for (const raw of getObjectiveCScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    const nodes: Record<string, SyntaxNode> = {};
    for (const capture of raw.captures) {
      const tag = `@${capture.name}`;
      grouped[tag] = nodeToCapture(tag, capture.node);
      nodes[tag] = capture.node;
    }

    const methodNode = nodes['@declaration.method'];
    if (methodNode !== undefined) {
      const signature = extractObjectiveCMethodSignature(methodNode);
      if (signature === null) continue;
      grouped['@declaration.name'] = syntheticCapture(
        '@declaration.name',
        methodNode,
        signature.signedSelector,
      );
      grouped['@declaration.parameter-count'] = syntheticCapture(
        '@declaration.parameter-count',
        methodNode,
        String(signature.arity),
      );
      grouped['@declaration.required-parameter-count'] = syntheticCapture(
        '@declaration.required-parameter-count',
        methodNode,
        String(signature.arity),
      );
      grouped['@declaration.parameter-types'] = syntheticCapture(
        '@declaration.parameter-types',
        methodNode,
        JSON.stringify(signature.parameters.map((parameter) => parameter.type)),
      );
      if (signature.returnType !== null) {
        grouped['@declaration.return-type'] = syntheticCapture(
          '@declaration.return-type',
          methodNode,
          signature.returnType,
        );
      }
      const ownerNode = enclosingTypeNode(methodNode);
      const identity = ownerNode === null ? null : objectiveCContainerIdentity(ownerNode);
      if (identity !== null) {
        grouped['@declaration.is-static'] = syntheticCapture(
          '@declaration.is-static',
          methodNode,
          String(signature.kind === 'class'),
        );
        Object.assign(
          grouped,
          declarationMetadata(methodNode, {
            label: 'Method',
            owner: identity.owner,
            declarationScope: objectiveCSourceScope(identity),
            sourceRole: identity.sourceRole,
            member: signature.signedSelector,
            annotations: [
              ...containerTags(ownerNode!),
              ...(protocolRequirementTag(methodNode) === undefined
                ? []
                : [protocolRequirementTag(methodNode)!]),
              ...nullabilityTags(methodNode),
              `objc:method-kind:${signature.kind}`,
            ],
          }),
        );
      }
      out.push(grouped);
      const owner = enclosingTypeName(methodNode);
      if (owner !== null) out.push(...synthesizeMethodBindings(methodNode, owner));
      continue;
    }

    const typeNode = nodes['@declaration.class'] ?? nodes['@declaration.interface'];
    if (typeNode !== undefined) {
      const nameNode = typeNode.namedChildren.find((child) => child.type === 'identifier');
      if (nameNode === undefined) continue;
      grouped['@declaration.name'] = nodeToCapture('@declaration.name', nameNode);
      const identity = objectiveCContainerIdentity(typeNode);
      if (identity !== null) {
        const sourceRole =
          identity.isCategory || identity.isClassExtension
            ? ('category-host' as const)
            : identity.sourceRole;
        Object.assign(
          grouped,
          declarationMetadata(typeNode, {
            label: typeNode.type === 'protocol_declaration' ? 'Interface' : 'Class',
            owner: identity.owner,
            declarationScope: objectiveCSourceScope(identity),
            sourceRole,
            member: identity.owner,
            annotations: [
              `objc:site:${sourceRole}`,
              `objc:owner:${identity.owner}`,
              ...(identity.isCategory ? [`objc:category:${identity.category}`] : []),
              ...(identity.isClassExtension ? ['objc:class-extension'] : []),
              ...containerTags(typeNode).filter((tag) => tag.startsWith('objc:availability:')),
            ],
          }),
        );
      }
    }

    const propertyNode = nodes['@declaration.property'];
    if (propertyNode !== undefined) {
      const ownerNode = enclosingTypeNode(propertyNode);
      const identity = ownerNode === null ? null : objectiveCContainerIdentity(ownerNode);
      const declaration = propertyNode.descendantsOfType('struct_declaration')[0];
      const info = declaration === undefined ? null : declarationTypeAndName(declaration);
      if (identity !== null && info !== null) {
        const attributes = propertyAttributes(propertyNode);
        const protocolRequirement = protocolRequirementTag(propertyNode);
        grouped['@declaration.field-type'] = syntheticCapture(
          '@declaration.field-type',
          declaration!,
          info.declaredType,
        );
        grouped['@declaration.is-static'] = syntheticCapture(
          '@declaration.is-static',
          propertyNode,
          String(attributes.includes('class')),
        );
        Object.assign(
          grouped,
          declarationMetadata(propertyNode, {
            label: 'Property',
            owner: identity.owner,
            declarationScope: objectiveCSourceScope(identity),
            sourceRole: identity.sourceRole,
            member: info.nameNode.text,
            annotations: [
              ...containerTags(ownerNode!),
              ...(protocolRequirement === undefined ? [] : [protocolRequirement]),
              ...attributes.map((attribute) => `objc:property:${attribute}`),
              ...nullabilityTags(propertyNode),
            ],
          }),
        );
        out.push(...propertyAccessorCaptures(propertyNode, ownerNode!));
      }
    }

    const callNode = nodes['@reference.call.member'];
    if (callNode !== undefined) {
      const message = extractObjectiveCMessageSend(callNode);
      const subscript = extractObjectiveCSubscriptSend(callNode);
      const call = message ?? subscript;
      if (call === null) continue;
      grouped['@reference.name'] = syntheticCapture(
        '@reference.name',
        callNode,
        message?.signedSelector ?? subscript!.referenceName,
      );
      grouped['@reference.receiver'] = syntheticCapture(
        '@reference.receiver',
        callNode,
        call.receiver,
      );
      grouped['@reference.arity'] = syntheticCapture(
        '@reference.arity',
        callNode,
        String(call.arity),
      );
      const candidateNames = message?.candidateNames ?? subscript?.candidateNames;
      if (candidateNames !== undefined) {
        grouped['@reference.candidate-names'] = syntheticCapture(
          '@reference.candidate-names',
          callNode,
          JSON.stringify(candidateNames),
        );
      }
    }

    if (Object.keys(grouped).length > 0) out.push(grouped);
  }

  out.push(...advancedDeclarationCaptures(tree.rootNode));
  out.push(...inheritanceReferences(tree.rootNode));
  return out;
}
