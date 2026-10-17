/**
 * What makes an R binary expression a definition: the assignment operators `<-`, `<<-`
 * and `=`. The grammar gives every infix operator the same `binary_operator` node, so
 * `x <- R6Class(...)` and `x + R6Class(...)` differ only in the `operator` field. The scope
 * and definition queries carry the same constraint as `operator: ["<-" "<<-" "="]`.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const LEFT_ASSIGN_OPERATORS: ReadonlySet<string> = new Set(['<-', '<<-', '=']);

/** Whether `node` is `target <- value`, `target <<- value` or `target = value`. */
export const isRLeftAssignment = (node: SyntaxNode): boolean =>
  node.type === 'binary_operator' &&
  LEFT_ASSIGN_OPERATORS.has(node.childForFieldName('operator')?.text ?? '');
