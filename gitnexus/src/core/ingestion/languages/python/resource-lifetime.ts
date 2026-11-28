import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ResourceLifetime } from '../../resource-lifetime.js';

export interface PythonResourceLifetime extends ResourceLifetime {
  ownerName: string;
  ownerLine: number;
}

const statements = (node: SyntaxNode | null) =>
  node?.namedChildren.filter((child) => child.type !== 'comment') ?? [];

const site = (node: SyntaxNode) => ({
  startLine: node.startPosition.row,
  endLine: node.endPosition.row,
});

function yieldsBinding(block: SyntaxNode | null, name: string): boolean {
  const body = statements(block);
  const yielded = body[0]?.firstNamedChild;
  const value = yielded?.firstNamedChild;
  return (
    body.length === 1 &&
    yielded?.type === 'yield' &&
    yielded.firstChild?.type === 'yield' &&
    yielded.childCount === 2 &&
    value?.type === 'identifier' &&
    value.text === name
  );
}

function cleanupCall(statement: SyntaxNode | undefined, name: string): SyntaxNode | undefined {
  if (statement?.type !== 'expression_statement') return;
  const expression = statement.firstNamedChild;
  const awaited = expression?.type === 'await';
  const call = awaited ? expression.firstNamedChild : expression;
  if (call?.type !== 'call' || call.childForFieldName('arguments')?.namedChildCount !== 0) return;
  const method = call.childForFieldName('function');
  if (method?.type !== 'attribute') return;
  const object = method.childForFieldName('object');
  const attribute = method.childForFieldName('attribute')?.text;
  if (
    object?.type === 'identifier' &&
    object.text === name &&
    (attribute === 'close' || (attribute === 'aclose' && awaited))
  )
    return call;
}

/** Prove only straight-line generator patterns. A method name alone cannot prove ownership. */
export function pythonResourceLifetime(fn: SyntaxNode): PythonResourceLifetime | undefined {
  const body = statements(fn.childForFieldName('body'));
  const ownerName = fn.childForFieldName('name')?.text;
  if (!ownerName || fn.hasError) return;
  if (body[0]?.type === 'expression_statement' && body[0].firstNamedChild?.type === 'string')
    body.shift();
  const owner = { ownerName, ownerLine: fn.startPosition.row };

  if (body.length === 1 && body[0].type === 'with_statement') {
    const scope = body[0];
    const clause = scope.firstNamedChild;
    if (clause?.type !== 'with_clause' || clause.namedChildCount !== 1) return;
    const item = clause.firstNamedChild?.childForFieldName('value');
    if (item?.type !== 'as_pattern' || item.firstNamedChild?.type !== 'call') return;
    const binding = item.childForFieldName('alias')?.firstNamedChild;
    if (
      binding?.type !== 'identifier' ||
      !yieldsBinding(scope.childForFieldName('body'), binding.text)
    )
      return;
    const manager = item.firstNamedChild;
    const factory = manager.childForFieldName('function');
    const name = factory?.type === 'attribute' ? factory.childForFieldName('attribute') : factory;
    if (name?.type !== 'identifier') return;
    return {
      ...owner,
      name: name.text,
      acquisition: site(manager),
      cleanup: site(scope),
      cleanupKind: 'context-manager exit',
    };
  }

  if (
    body.length !== 2 ||
    body[0].type !== 'expression_statement' ||
    body[1].type !== 'try_statement'
  )
    return;
  const assignment = body[0].firstNamedChild;
  if (assignment?.type !== 'assignment' || assignment.childForFieldName('right')?.type !== 'call')
    return;
  const binding = assignment.childForFieldName('left');
  const guarded = statements(body[1]);
  if (
    binding?.type !== 'identifier' ||
    guarded.length !== 2 ||
    guarded[1].type !== 'finally_clause' ||
    !yieldsBinding(guarded[0], binding.text)
  )
    return;
  const teardown = statements(guarded[1].lastNamedChild);
  const close = teardown.length === 1 ? cleanupCall(teardown[0], binding.text) : undefined;
  if (close)
    return {
      ...owner,
      name: binding.text,
      acquisition: site(assignment),
      cleanup: site(close),
      cleanupKind: 'explicit close',
    };
}
