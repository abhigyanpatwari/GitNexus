import type { CaptureMatch } from 'gitnexus-shared';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

export function synthesizeGoTypeBindings(rootNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  for (const node of rootNode.descendantsOfType('short_var_declaration')) {
    const right = node.childForFieldName('right');
    if (right === null) continue;
    const lhs = node.childForFieldName('left');
    if (lhs === null) continue;

    // Multi-assignment: pair LHS identifiers positionally with RHS
    // expressions. The tree-sitter query produces all LHS/RHS
    // combinations; emit only the positions whose RHS carries an
    // inferable type.
    const lhsIds = lhs.namedChildren.filter((c) => c.type === 'identifier');
    const rhsExprs = right.namedChildren;
    if (lhsIds.length >= 2 && rhsExprs.length >= 2) {
      for (let i = 0; i < Math.min(lhsIds.length, rhsExprs.length); i++) {
        const lhsId = lhsIds[i]!;
        const rhsExpr = rhsExprs[i]!;
        const typeNode = extractTypeNode(rhsExpr);
        if (typeNode === null) continue;
        const typeName = extractSimpleTypeNameText(typeNode);
        out.push({
          '@type-binding.multi-assign': syntheticCapture(
            '@type-binding.multi-assign',
            node,
            lhsId.text,
          ),
          '@type-binding.name': syntheticCapture('@type-binding.name', lhsId, lhsId.text),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            typeNode ?? rhsExpr,
            typeName,
          ),
        });
      }
      continue; // synthesized matches replace tree-sitter combinations
    }

    // Walk the expression_list for call_expression function == "new" or "make"
    for (let i = 0; i < right.namedChildCount; i++) {
      const expr = right.namedChild(i);
      if (expr?.type === 'call_expression') {
        const fn = expr.childForFieldName('function');
        const args = expr.childForFieldName('arguments');
        if (fn?.type === 'identifier' && fn.text === 'new' && args !== null) {
          const typeArg = args.namedChildren.find((c) =>
            ['type_identifier', 'qualified_type'].includes(c.type),
          );
          if (typeArg !== null) {
            const typeName = extractSimpleTypeNameText(typeArg);
            const nameNodes = lhs.namedChildren.filter((c) => c.type === 'identifier');
            if (nameNodes.length > 0) {
              out.push({
                '@type-binding.new': syntheticCapture('@type-binding.new', node, 'new'),
                '@type-binding.name': syntheticCapture(
                  '@type-binding.name',
                  nameNodes[0],
                  nameNodes[0].text,
                ),
                '@type-binding.type': syntheticCapture('@type-binding.type', typeArg, typeName),
              });
            }
          }
        }
        if (fn?.type === 'identifier' && fn.text === 'make' && args !== null) {
          const sliceOrMap = args.namedChildren.find((c) =>
            // V1: channel_type not handled — make(chan T) produces no typeBinding.
            ['slice_type', 'map_type'].includes(c.type),
          );
          if (sliceOrMap !== null) {
            let typeName = '';
            if (sliceOrMap.type === 'slice_type') {
              const elem = sliceOrMap.namedChildren.find((c) =>
                ['type_identifier', 'qualified_type'].includes(c.type),
              );
              if (elem !== null) typeName = extractSimpleTypeNameText(elem);
            } else if (sliceOrMap.type === 'map_type') {
              const typeChildren = sliceOrMap.namedChildren.filter((c) =>
                ['type_identifier', 'qualified_type'].includes(c.type),
              );
              const valueType = typeChildren[1] ?? typeChildren[0];
              if (valueType !== undefined) typeName = extractSimpleTypeNameText(valueType);
            }
            if (typeName !== '') {
              const nameNodes = lhs.namedChildren.filter((c) => c.type === 'identifier');
              if (nameNodes.length > 0) {
                out.push({
                  '@type-binding.make': syntheticCapture('@type-binding.make', node, 'make'),
                  '@type-binding.name': syntheticCapture(
                    '@type-binding.name',
                    nameNodes[0],
                    nameNodes[0].text,
                  ),
                  '@type-binding.type': syntheticCapture(
                    '@type-binding.type',
                    sliceOrMap,
                    typeName,
                  ),
                });
              }
            }
          }
        }
      }
    }
  }

  // Synthesize typeBindings for for-range loop variables and index
  // expressions (sl[0], m["key"]) so member calls on them resolve.
  synthesizeElementAccessBindings(rootNode, out);

  return out;
}

function synthesizeElementAccessBindings(rootNode: SyntaxNode, out: CaptureMatch[]): void {
  // Build a map of variable → element type from make/new/range.
  const varElementType = new Map<string, string>();

  for (const node of rootNode.descendantsOfType('short_var_declaration')) {
    const right = node.childForFieldName('right');
    const lhs = node.childForFieldName('left');
    if (right === null || lhs === null) continue;
    const lhsIds = lhs.namedChildren.filter((c) => c.type === 'identifier');
    if (lhsIds.length === 0) continue;

    for (const expr of right.namedChildren) {
      let typeName: string | undefined;
      if (expr.type === 'call_expression') {
        const fn = expr.childForFieldName('function');
        if (fn?.type === 'identifier' && (fn.text === 'make' || fn.text === 'new')) {
          const args = expr.childForFieldName('arguments');
          const typeNode = args?.namedChildren.find((c) =>
            ['type_identifier', 'qualified_type', 'slice_type', 'map_type'].includes(c.type),
          );
          if (typeNode) {
            if (typeNode.type === 'slice_type') {
              const elem = typeNode.namedChildren.find((c) =>
                ['type_identifier', 'qualified_type'].includes(c.type),
              );
              if (elem) typeName = extractSimpleTypeNameText(elem);
            } else if (typeNode.type === 'map_type') {
              const tc = typeNode.namedChildren.filter((c) =>
                ['type_identifier', 'qualified_type'].includes(c.type),
              );
              typeName = tc[1]
                ? extractSimpleTypeNameText(tc[1])
                : tc[0]
                  ? extractSimpleTypeNameText(tc[0])
                  : undefined;
            } else {
              typeName = extractSimpleTypeNameText(typeNode);
            }
          }
        }
      }
      if (typeName !== undefined && lhsIds.length > 0) {
        varElementType.set(lhsIds[0]!.text, typeName);
      }
    }
  }

  // Handle for-range: for _, user := range GetUsers() / range slice / range map
  for (const rangeClause of rootNode.descendantsOfType('range_clause')) {
    const right = rangeClause.childForFieldName('right');
    if (right === null || right.namedChildren.length === 0) continue;
    const left = rangeClause.childForFieldName('left');
    if (left === null) continue;

    // The right side IS the range expression (call_expression, identifier, etc.)
    const rangeExpr = right;

    let elemType: string | undefined;
    // Call expression: range GetUsers()
    if (rangeExpr.type === 'call_expression') {
      const fn = rangeExpr.childForFieldName('function');
      if (fn !== null) {
        elemType = fn.text;
      }
    }
    // Identifier: range userMap / range users
    if (rangeExpr.type === 'identifier' || rangeExpr.type === 'selector_expression') {
      const existing = varElementType.get(rangeExpr.text);
      if (existing !== undefined) elemType = existing;
    }

    if (elemType === undefined) continue;

    // Capture the loop variable (skip blank_identifier like _)
    for (const child of left.namedChildren) {
      if (child.type === 'identifier') {
        // Create a typeBinding: loopVar → elemType
        out.push({
          '@type-binding.range': syntheticCapture('@type-binding.range', rangeClause, child.text),
          '@type-binding.name': syntheticCapture('@type-binding.name', child, child.text),
          '@type-binding.type': syntheticCapture('@type-binding.type', rangeExpr, elemType),
        });
      }
    }
  }

  // Handle index expressions: sl[0], m["key"]
  for (const node of rootNode.descendantsOfType('call_expression')) {
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'selector_expression') continue;
    const operand = fn.childForFieldName('operand');
    if (operand === null) continue;

    if (operand.type === 'index_expression') {
      const base = operand.childForFieldName('operand');
      if (base?.type === 'identifier' && varElementType.has(base.text)) {
        const elemType = varElementType.get(base.text)!;
        out.push({
          '@type-binding.index': syntheticCapture('@type-binding.index', node, operand.text),
          '@type-binding.name': syntheticCapture('@type-binding.name', operand, operand.text),
          '@type-binding.type': syntheticCapture('@type-binding.type', operand, elemType),
        });
      }
    }
  }
}

function extractSimpleTypeNameText(node: SyntaxNode): string {
  if (node.type === 'qualified_type') {
    const parts = node.text.split('.');
    return parts[parts.length - 1] ?? node.text;
  }
  return node.text;
}

/** Extract the type/signature node from a RHS expression. */
function extractTypeNode(expr: SyntaxNode): SyntaxNode | null {
  if (expr.type === 'composite_literal') {
    return (
      expr.childForFieldName('type') ??
      expr.namedChildren.find((c) => ['type_identifier', 'qualified_type'].includes(c.type)) ??
      null
    );
  }
  if (expr.type === 'unary_expression') {
    const operand = expr.childForFieldName('operand');
    return operand === null ? null : extractTypeNode(operand);
  }
  if (expr.type === 'call_expression') {
    const fn = expr.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'new') {
      const args = expr.childForFieldName('arguments');
      return (
        args?.namedChildren.find((c) =>
          ['type_identifier', 'qualified_type', 'pointer_type'].includes(c.type),
        ) ?? null
      );
    }
    if (fn?.type === 'identifier' && fn.text === 'make') {
      const args = expr.childForFieldName('arguments');
      const container = args?.namedChildren.find((c) =>
        ['slice_type', 'map_type'].includes(c.type),
      );
      if (container?.type === 'slice_type') {
        return (
          container.namedChildren.find((c) =>
            ['type_identifier', 'qualified_type'].includes(c.type),
          ) ?? null
        );
      }
      if (container?.type === 'map_type') {
        const typeChildren = container.namedChildren.filter((c) =>
          ['type_identifier', 'qualified_type'].includes(c.type),
        );
        return typeChildren[1] ?? typeChildren[0] ?? null;
      }
    }
    if (fn?.type === 'identifier') return fn;
    if (fn?.type === 'selector_expression') {
      return fn.childForFieldName('field') ?? fn;
    }
  }
  if (expr.type === 'type_assertion_expression') {
    return expr.childForFieldName('type');
  }
  return null;
}
