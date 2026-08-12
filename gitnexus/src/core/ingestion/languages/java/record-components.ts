import { SupportedLanguages, type CaptureMatch } from 'gitnexus-shared';
import type { CaptureMap } from '../../language-provider.js';
import { createMethodExtractor } from '../../method-extractors/generic.js';
import { javaMethodConfig } from '../../method-extractors/configs/jvm.js';
import type {
  ExtractedMethods,
  MethodExtractor,
  MethodExtractorContext,
  MethodInfo,
} from '../../method-types.js';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const javaExplicitMethodExtractor = createMethodExtractor(javaMethodConfig);

function recordComponents(recordNode: SyntaxNode): SyntaxNode[] {
  const parameters = recordNode.childForFieldName('parameters');
  if (parameters === null) return [];
  return parameters.namedChildren.filter(
    (node): node is SyntaxNode =>
      node !== null && (node.type === 'formal_parameter' || node.type === 'spread_parameter'),
  );
}

function recordComponentNameNode(component: SyntaxNode): SyntaxNode | null {
  if (component.type === 'formal_parameter') return component.childForFieldName('name');
  const declarator = component.namedChildren.find((node) => node?.type === 'variable_declarator');
  return declarator?.childForFieldName('name') ?? null;
}

function explicitZeroArgAccessorNames(recordNode: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const body = recordNode.childForFieldName('body');
  if (body === null) return names;

  for (const node of body.namedChildren) {
    if (node === null || node.type !== 'method_declaration') continue;
    const name = node.childForFieldName('name')?.text;
    const parameters = node.childForFieldName('parameters');
    const parameterCount =
      parameters?.namedChildren.filter(
        (parameter) =>
          parameter !== null &&
          (parameter.type === 'formal_parameter' ||
            parameter.type === 'spread_parameter' ||
            parameter.type === 'receiver_parameter'),
      ).length ?? 0;
    if (name !== undefined && parameterCount === 0) names.add(name);
  }
  return names;
}

function recordComponentReturnType(component: SyntaxNode): string | null {
  const typeNode =
    component.childForFieldName('type') ??
    (component.type === 'spread_parameter'
      ? component.namedChildren.find(
          (node) => node?.type !== 'modifiers' && node?.type !== 'variable_declarator',
        )
      : undefined);
  const type = typeNode?.text;
  if (type === undefined) return null;
  return component.type === 'spread_parameter' ? `${type}[]` : type;
}

function implicitAccessorInfo(
  component: SyntaxNode,
  context: MethodExtractorContext,
): MethodInfo | null {
  const name = recordComponentNameNode(component)?.text;
  if (name === undefined) return null;

  return {
    name,
    receiverType: null,
    returnType: recordComponentReturnType(component),
    parameters: [],
    visibility: 'public',
    isStatic: false,
    isAbstract: false,
    isFinal: false,
    annotations: [],
    sourceFile: context.filePath,
    line: component.startPosition.row + 1,
  };
}

/** Java records synthesize one public, zero-argument accessor per component. */
export const javaRecordMethodExtractor: MethodExtractor = {
  ...javaExplicitMethodExtractor,
  language: SupportedLanguages.Java,
  extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
    const extracted = javaExplicitMethodExtractor.extract(node, context);
    if (extracted === null || node.type !== 'record_declaration') return extracted;

    const explicitAccessors = explicitZeroArgAccessorNames(node);
    const implicitAccessors = recordComponents(node)
      .filter((component) => {
        const name = recordComponentNameNode(component)?.text;
        return name !== undefined && !explicitAccessors.has(name);
      })
      .map((component) => implicitAccessorInfo(component, context))
      .filter((method): method is MethodInfo => method !== null);

    return { ...extracted, methods: [...extracted.methods, ...implicitAccessors] };
  },
};

/** Scope declarations matching the structure-phase synthetic accessor nodes. */
export function synthesizeJavaRecordComponentAccessorCaptures(
  rootNode: SyntaxNode,
): CaptureMatch[] {
  const captures: CaptureMatch[] = [];
  for (const recordNode of rootNode.descendantsOfType('record_declaration')) {
    const explicitAccessors = explicitZeroArgAccessorNames(recordNode);
    for (const component of recordComponents(recordNode)) {
      const nameNode = recordComponentNameNode(component);
      const returnType = recordComponentReturnType(component);
      if (nameNode === null || returnType === null || explicitAccessors.has(nameNode.text))
        continue;

      captures.push({
        '@scope.function': nodeToCapture('@scope.function', component),
      });
      captures.push({
        '@declaration.method': nodeToCapture('@declaration.method', component),
        '@declaration.name': nodeToCapture('@declaration.name', nameNode),
        '@declaration.parameter-count': syntheticCapture(
          '@declaration.parameter-count',
          component,
          '0',
        ),
        '@declaration.required-parameter-count': syntheticCapture(
          '@declaration.required-parameter-count',
          component,
          '0',
        ),
        '@declaration.return-type': syntheticCapture(
          '@declaration.return-type',
          component,
          returnType,
        ),
      });
    }
  }
  return captures;
}

/**
 * The structure query sees every record component. Suppress that synthetic
 * definition when the record body provides the canonical zero-argument
 * accessor explicitly, leaving the explicit method as the single authority.
 */
export function shouldSkipJavaRecordComponentDefinition(captureMap: CaptureMap): boolean {
  const component = captureMap['definition.method'];
  if (component?.type !== 'formal_parameter' && component?.type !== 'spread_parameter') {
    return false;
  }

  const parameters = component.parent;
  const recordNode = parameters?.parent;
  const name = captureMap['name']?.text;
  return (
    parameters?.type === 'formal_parameters' &&
    recordNode?.type === 'record_declaration' &&
    name !== undefined &&
    explicitZeroArgAccessorNames(recordNode).has(name)
  );
}
