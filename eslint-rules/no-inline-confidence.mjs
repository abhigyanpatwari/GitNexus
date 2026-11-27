function propertyName(node, computed = false) {
  if (!computed && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

const comparisonOperators = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

const positionalConfidence = new Map([
  ['tryEmitEdge', 7],
  ['tryEmitEdgeWithExplicitTargetId', 7],
  ['emitInterfaceDispatchFor', 4],
]);

function* inlineConfidenceLiterals(node, visitorKeys) {
  if (!node) return;
  if (node.type === 'Literal' && typeof node.value === 'number') {
    yield node;
    return;
  }

  if (node.type === 'BinaryExpression' && comparisonOperators.has(node.operator)) return;

  for (const key of visitorKeys[node.type] ?? []) {
    if (node.type === 'ConditionalExpression' && key === 'test') continue;
    if (node.type === 'MemberExpression' && node.computed && key === 'property') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const entry of child) yield* inlineConfidenceLiterals(entry, visitorKeys);
    } else {
      yield* inlineConfidenceLiterals(child, visitorKeys);
    }
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require shared EdgeConfidence values instead of inline confidence numbers',
    },
    schema: [],
    messages: {
      useEdgeConfidence: 'Use a named EdgeConfidence value for {{name}}.',
    },
  },
  create(context) {
    const { visitorKeys } = context.sourceCode;

    function check(name, value) {
      if (name !== 'confidence' && !name?.endsWith('CONFIDENCE')) return;
      for (const node of inlineConfidenceLiterals(value, visitorKeys)) {
        context.report({ node, messageId: 'useEdgeConfidence', data: { name } });
      }
    }

    return {
      'Property, PropertyDefinition'(node) {
        check(propertyName(node.key, node.computed), node.value);
      },
      AssignmentPattern(node) {
        check(propertyName(node.left), node.right);
      },
      VariableDeclarator(node) {
        check(propertyName(node.id), node.init);
      },
      AssignmentExpression(node) {
        const target = node.left;
        const name =
          target.type === 'MemberExpression'
            ? propertyName(target.property, target.computed)
            : propertyName(target);
        check(name, node.right);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        const index = positionalConfidence.get(node.callee.name);
        if (index !== undefined) check('confidence', node.arguments[index]);
      },
    };
  },
};
