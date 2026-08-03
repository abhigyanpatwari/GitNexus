import { SupportedLanguages } from 'gitnexus-shared';
import { createCallExtractor } from '../../call-extractors/generic.js';
import { createClassExtractor } from '../../class-extractors/generic.js';
import type { FieldExtractor } from '../../field-extractor.js';
import type { FieldInfo } from '../../field-types.js';
import type {
  ExtractedMethods,
  MethodExtractor,
  MethodExtractorContext,
  MethodInfo,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type {
  VariableExtractor,
  VariableExtractorContext,
  VariableInfo,
} from '../../variable-types.js';
import {
  extractObjectiveCMessageSend,
  extractObjectiveCMethodSignature,
} from './selector.js';
import {
  objectiveCBlockName,
  objectiveCCategoryDisplayName,
  objectiveCContainerIdentity,
} from './identity.js';

const TYPE_DECLARATIONS = new Set([
  'class_interface',
  'class_implementation',
  'protocol_declaration',
]);

function directIdentifier(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === 'identifier');
}

export const objectiveCClassExtractor = createClassExtractor({
  language: SupportedLanguages.ObjectiveC,
  typeDeclarationNodes: [...TYPE_DECLARATIONS],
  ancestorScopeNodeTypes: [...TYPE_DECLARATIONS],
  extractName: (node) => directIdentifier(node)?.text,
  extractType: (node) => (node.type === 'protocol_declaration' ? 'Interface' : 'Class'),
});

function buildMethodInfo(node: SyntaxNode, context: MethodExtractorContext): MethodInfo | null {
  if (node.type === 'block_literal') {
    const parameters = node
      .descendantsOfType('parameter_declaration')
      .filter((parameter) => parameter.parent?.type === 'parameter_list')
      .map((parameter) => {
        const nameNode = parameter.descendantsOfType('identifier').at(-1);
        const type = parameter.childForFieldName('type')?.text.trim() ?? '';
        return {
          name: nameNode?.text ?? '',
          type: type || null,
          rawType: type || null,
          isOptional: false,
          isVariadic: false,
        };
      });
    return {
      name: objectiveCBlockName(node),
      receiverType: null,
      returnType: null,
      parameters,
      visibility: 'private',
      isStatic: false,
      isAbstract: false,
      isFinal: false,
      annotations: ['objc:block-literal'],
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }
  const signature = extractObjectiveCMethodSignature(node);
  if (signature === null) return null;
  return {
    name: signature.signedSelector,
    receiverType: null,
    returnType: signature.returnType,
    parameters: signature.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type || null,
      rawType: parameter.type || null,
      isOptional: false,
      isVariadic: false,
    })),
    visibility: 'public',
    isStatic: signature.kind === 'class',
    isAbstract: node.type === 'method_declaration',
    isFinal: false,
    annotations: [],
    sourceFile: context.filePath,
    line: node.startPosition.row + 1,
  };
}

export const objectiveCMethodExtractor: MethodExtractor = {
  language: SupportedLanguages.ObjectiveC,

  isTypeDeclaration(node): boolean {
    return TYPE_DECLARATIONS.has(node.type);
  },

  extract(node, context): ExtractedMethods | null {
    if (!TYPE_DECLARATIONS.has(node.type)) return null;
    const ownerName = directIdentifier(node)?.text;
    if (ownerName === undefined) return null;
    const methods = [
      ...node.descendantsOfType('method_declaration'),
      ...node.descendantsOfType('method_definition'),
    ]
      .sort((left, right) => left.startIndex - right.startIndex)
      .map((method) => buildMethodInfo(method, context))
      .filter((method): method is MethodInfo => method !== null);
    return { ownerName, methods };
  },

  extractFromNode(node, context): MethodInfo | null {
    return buildMethodInfo(node, context);
  },

  extractFunctionName(node) {
    if (node.type === 'block_literal') {
      return { funcName: objectiveCBlockName(node), label: 'Function' };
    }
    if (node.type === 'identifier') {
      const container = node.parent;
      const identity = container === null ? null : objectiveCContainerIdentity(container);
      if (identity !== null && (identity.isCategory || identity.isClassExtension)) {
        return {
          funcName: objectiveCCategoryDisplayName(identity),
          label: 'CodeElement',
        };
      }
    }
    const signature = extractObjectiveCMethodSignature(node);
    return signature === null ? null : { funcName: signature.signedSelector, label: 'Method' };
  },
};

function propertyName(node: SyntaxNode): string | null {
  const declarator = node.descendantsOfType('struct_declarator')[0];
  if (declarator === undefined) return null;
  const identifiers = declarator.descendantsOfType('identifier');
  return identifiers.at(-1)?.text ?? null;
}

function propertyType(node: SyntaxNode): string | null {
  const declaration = node.descendantsOfType('struct_declaration')[0];
  if (declaration === undefined) return null;
  const typeNode = declaration.namedChildren.find((child) => child.type !== 'struct_declarator');
  return typeNode?.text.trim() || null;
}

function propertyAttributes(node: SyntaxNode): Set<string> {
  const attributes = node.descendantsOfType('property_attribute');
  return new Set(attributes.map((attribute) => attribute.text.trim()));
}

export const objectiveCFieldExtractor: FieldExtractor = {
  language: SupportedLanguages.ObjectiveC,

  isTypeDeclaration(node): boolean {
    return TYPE_DECLARATIONS.has(node.type);
  },

  extract(node, context) {
    if (!TYPE_DECLARATIONS.has(node.type)) return null;
    const ownerFqn = directIdentifier(node)?.text;
    if (ownerFqn === undefined) return null;
    const fields: FieldInfo[] = [];
    for (const property of node.descendantsOfType('property_declaration')) {
      const name = propertyName(property);
      if (name === null) continue;
      const attributes = propertyAttributes(property);
      const type = propertyType(property);
      fields.push({
        name,
        type,
        ...(type !== null ? { rawDeclaredType: type } : {}),
        visibility: 'public',
        isStatic: attributes.has('class'),
        isReadonly: attributes.has('readonly'),
        annotations: [...attributes].map((attribute) => `objc:property:${attribute}`),
        sourceFile: context.filePath,
        line: property.startPosition.row + 1,
      });
    }
    return { ownerFqn, fields, nestedTypes: [] };
  },
};

function variableNameAndType(
  node: SyntaxNode,
): { readonly name: string; readonly type: string | null } | null {
  const declaration =
    node.type === 'instance_variable'
      ? node.namedChildren.find((child) => child.type === 'struct_declaration')
      : node;
  if (declaration === undefined) return null;
  const blockPointer = declaration.descendantsOfType('block_pointer_declarator')[0];
  const nameNode =
    blockPointer?.descendantsOfType('identifier').at(-1) ??
    declaration.descendantsOfType('identifier').at(-1);
  if (nameNode === undefined) return null;

  if (declaration.type === 'struct_declaration') {
    const declarator = declaration.namedChildren.find(
      (child) => child.type === 'struct_declarator',
    );
    const base = declaration.namedChildren
      .filter((child) => child.id !== declarator?.id)
      .map((child) => child.text.trim())
      .filter(Boolean)
      .join(' ');
    const suffix = declarator?.text.replace(nameNode.text, '').trim() ?? '';
    return { name: nameNode.text, type: `${base}${suffix ? ` ${suffix}` : ''}`.trim() || null };
  }

  const typeNode = declaration.childForFieldName('type');
  const declarator = declaration.childForFieldName('declarator');
  const callableShape = declarator?.text.replace(nameNode.text, '').trim() ?? '';
  const type = `${typeNode?.text.trim() ?? ''}${callableShape ? ` ${callableShape}` : ''}`.trim();
  return { name: nameNode.text, type: type || null };
}

export const objectiveCVariableExtractor: VariableExtractor = {
  language: SupportedLanguages.ObjectiveC,

  isVariableDeclaration(node): boolean {
    return node.type === 'instance_variable' || node.type === 'declaration';
  },

  extract(node, context): VariableInfo | null {
    return this.extractAll(node, context)[0] ?? null;
  },

  extractAll(node: SyntaxNode, context: VariableExtractorContext): VariableInfo[] {
    if (!this.isVariableDeclaration(node)) return [];
    const extracted = variableNameAndType(node);
    if (extracted === null) return [];
    return [{
      name: extracted.name,
      type: extracted.type,
      visibility: node.type === 'instance_variable' ? 'private' : 'public',
      isConst: false,
      isStatic: false,
      isMutable: true,
      scope: node.type === 'instance_variable' ? 'file' : 'block',
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    }];
  },
};

export const objectiveCCallExtractor = createCallExtractor({
  language: SupportedLanguages.ObjectiveC,
  typeAsReceiverHeuristic: true,
  extractLanguageCallSite: (node) => {
    const message = extractObjectiveCMessageSend(node);
    if (message === null) return null;
    return {
      calledName: message.signedSelector,
      callForm: 'member',
      receiverName: message.receiver,
      argCount: message.arity,
    };
  },
});
