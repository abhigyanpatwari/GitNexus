import type { FieldExtractorContext, FieldInfo } from '../../field-types.js';
import type { LanguageProvider } from '../../language-provider.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { classifyPythonBoundReceiver } from './receiver-binding.js';
import { pythonFieldVisibility, pythonReceiverField } from './field-helpers.js';
import { pythonValueBindingsInScope } from './builtin-descriptors.js';

export const synthesizePythonInstanceFields: NonNullable<
  LanguageProvider['synthesizeStructureMembers']
> = (tree, filePath, classOwnersByNodeId) => {
  const nodes = [];
  const symbols = [];
  const relationships = [];
  const pending = [tree.rootNode];
  while (pending.length > 0) {
    const owner = pending.pop()!;
    pending.push(...owner.namedChildren);
    const ownerId = classOwnersByNodeId.get(owner.id);
    if (owner.type !== 'class_definition' || ownerId === undefined) continue;
    const ownerName = ownerId.slice(`Class:${filePath}:`.length);
    for (const field of extractPythonInstanceFields(owner, { filePath })) {
      const id = `Property:${filePath}:${ownerName}.${field.name}`;
      nodes.push({
        id,
        label: 'Property',
        properties: {
          name: field.name,
          filePath,
          language: 'python',
          startLine: field.line - 1,
          endLine: field.line - 1,
          isExported: field.visibility === 'public',
          visibility: field.visibility,
          isStatic: false,
          isReadonly: false,
          ...(field.type ? { declaredType: field.type } : {}),
          ...(field.rawDeclaredType ? { rawDeclaredType: field.rawDeclaredType } : {}),
        },
      });
      symbols.push({
        filePath,
        name: field.name,
        nodeId: id,
        type: 'Property',
        ownerId,
        visibility: field.visibility,
        isStatic: false,
        ...(field.type ? { declaredType: field.type } : {}),
      });
      relationships.push({
        id: `HAS_PROPERTY:${ownerId}->${id}`,
        sourceId: ownerId,
        targetId: id,
        type: 'HAS_PROPERTY',
        confidence: 1,
        reason: '',
      });
    }
  }
  return { nodes, symbols, relationships };
};

export function synthesizePythonInstanceFieldCaptures(
  owner: SyntaxNode,
  filePath: string,
): CaptureMatch[] {
  const className = owner.childForFieldName('name');
  if (className === null) return [];
  return extractPythonInstanceFields(owner, { filePath }).map((field) => {
    const position = {
      ...syntheticCapture('@declaration.name', className, field.name),
      range: {
        startLine: field.line,
        endLine: field.line,
        startCol: field.column,
        endCol: field.column + field.name.length,
      },
    };
    return {
      // Anchor within the class header so ownership and lookup use class scope;
      // graph-position and name retain the constructor assignment's location.
      '@declaration.property': syntheticCapture('@declaration.property', className, field.name),
      '@declaration.name': position,
      '@declaration.graph-position': { ...position, name: '@declaration.graph-position' },
      '@declaration.qualified_name': syntheticCapture(
        '@declaration.qualified_name',
        className,
        `${className.text}.${field.name}`,
      ),
      ...(field.type
        ? {
            '@declaration.field-type': syntheticCapture(
              '@declaration.field-type',
              className,
              field.type,
            ),
          }
        : {}),
    };
  });
}

/** Extract declarations from assignments on a proven __init__ receiver.
 * Field existence does not require a type annotation on the assigned value. */
export function extractPythonInstanceFields(
  owner: SyntaxNode,
  context: Pick<FieldExtractorContext, 'filePath'>,
): FieldInfo[] {
  const body = owner.childForFieldName('body');
  if (body === null) return [];
  const declaredNames = new Set<string>();
  for (const statement of body.namedChildren) {
    const declaration =
      statement.type === 'decorated_definition'
        ? statement.childForFieldName('definition')
        : statement;
    if (declaration?.type === 'function_definition') {
      const name = declaration.childForFieldName('name');
      if (name !== null) declaredNames.add(name.text);
    }
    const assignment = statement.firstNamedChild;
    const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
    if (left?.type === 'identifier') declaredNames.add(left.text);
  }

  // Only a final, unconditional method definition proves which constructor runs.
  const method = pythonValueBindingsInScope(owner, '__init__').at(-1)?.parent;
  if (method?.type !== 'function_definition') return [];
  const declaration = method.parent?.type === 'decorated_definition' ? method.parent : method;
  if (declaration.parent?.id !== body.id) return [];
  const receiver = classifyPythonBoundReceiver(method);
  const methodBody = method.childForFieldName('body');
  if (receiver?.kind !== 'instance' || methodBody === null) return [];
  // Any local rebinding makes ownership uncertain. Nested definitions bind
  // their names here, while bindings inside their bodies belong to that scope.
  if (
    pythonValueBindingsInScope(method, receiver.name).some(
      (binding) => binding.startIndex >= methodBody.startIndex,
    )
  )
    return [];

  const candidates = new Map<string, FieldInfo>();
  const visitTarget = (target: SyntaxNode, annotation?: SyntaxNode | null): void => {
    if (target.type === 'attribute') {
      const name = pythonReceiverField(target, receiver.name);
      if (name === null) return;
      if (declaredNames.has(name.text) || candidates.has(name.text)) return;
      candidates.set(name.text, {
        name: name.text,
        type: annotation ? (extractSimpleTypeName(annotation) ?? annotation.text) : null,
        ...(annotation ? { rawDeclaredType: annotation.text } : {}),
        visibility: pythonFieldVisibility(name.text),
        isStatic: false,
        isReadonly: false,
        sourceFile: context.filePath,
        line: name.startPosition.row + 1,
        column: name.startPosition.column,
      });
      return;
    }
    if (target.type === 'subscript') return;
    for (const child of target.namedChildren) visitTarget(child, annotation);
  };

  const nodes = [...methodBody.namedChildren].reverse();
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (['function_definition', 'class_definition', 'lambda'].includes(node.type)) continue;
    if (
      (node.type === 'assignment' && node.childForFieldName('right') !== null) ||
      node.type === 'for_statement'
    ) {
      const left = node.childForFieldName('left');
      if (left !== null) visitTarget(left, node.childForFieldName('type'));
    }
    if (node.type === 'as_pattern') {
      const alias = node.childForFieldName('alias');
      if (alias !== null) visitTarget(alias);
    }
    nodes.push(...[...node.namedChildren].reverse());
  }
  return [...candidates.values()];
}
