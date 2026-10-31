import type { FieldExtractorContext, FieldInfo } from '../../field-types.js';
import type { LanguageProvider } from '../../language-provider.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { classifyPythonBoundReceiver } from './receiver-binding.js';

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
  const fields = new Map<string, FieldInfo>();
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

  const classNodes = [...body.namedChildren];
  while (classNodes.length > 0) {
    const method = classNodes.pop()!;
    if (method.type === 'class_definition' || method.type === 'lambda') continue;
    if (method.type !== 'function_definition') {
      classNodes.push(...method.namedChildren);
      continue;
    }
    if (method.childForFieldName('name')?.text !== '__init__') continue;
    const receiver = classifyPythonBoundReceiver(method);
    const methodBody = method.childForFieldName('body');
    if (receiver?.kind !== 'instance' || methodBody === null) continue;

    const candidates = new Map<string, FieldInfo>();
    let rebound = false;
    const rebindsReceiver = (target: SyntaxNode): boolean => {
      if (target.type === 'identifier') return target.text === receiver.name;
      if (target.type === 'attribute' || target.type === 'subscript') return false;
      return target.namedChildren.some(rebindsReceiver);
    };
    const visitTarget = (target: SyntaxNode, annotation?: SyntaxNode | null): void => {
      if (target.type === 'identifier') {
        if (target.text === receiver.name) rebound = true;
        return;
      }
      if (target.type === 'attribute') {
        const object = target.childForFieldName('object');
        const name = target.childForFieldName('attribute');
        if (object?.type !== 'identifier' || object.text !== receiver.name || name === null) return;
        if (declaredNames.has(name.text) || candidates.has(name.text)) return;
        candidates.set(name.text, {
          name: name.text,
          type: annotation ? (extractSimpleTypeName(annotation) ?? annotation.text) : null,
          ...(annotation ? { rawDeclaredType: annotation.text } : {}),
          visibility:
            name.text.startsWith('__') && !name.text.endsWith('__')
              ? 'private'
              : name.text.startsWith('_')
                ? 'protected'
                : 'public',
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
      if (node.type === 'assignment' && node.childForFieldName('right') !== null) {
        const left = node.childForFieldName('left');
        if (left !== null) visitTarget(left, node.childForFieldName('type'));
      }
      // Rebinding the injected parameter makes ownership uncertain. Decline
      // the constructor's candidates rather than assign another object's fields.
      if (
        node.type === 'named_expression' &&
        node.childForFieldName('name')?.text === receiver.name
      ) {
        rebound = true;
      }
      if (
        node.type === 'for_statement' ||
        node.type === 'delete_statement' ||
        node.type === 'augmented_assignment'
      ) {
        const target = node.childForFieldName('left') ?? node.firstNamedChild;
        if (target !== null && rebindsReceiver(target)) rebound = true;
      }
      if (node.type === 'as_pattern') {
        const alias = node.childForFieldName('alias');
        if (alias !== null && rebindsReceiver(alias)) rebound = true;
      }
      nodes.push(...[...node.namedChildren].reverse());
    }
    if (!rebound) {
      for (const [name, field] of candidates) {
        if (!fields.has(name)) fields.set(name, field);
      }
    }
  }
  return [...fields.values()];
}
