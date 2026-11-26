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

function isNumericLiteral(node) {
  if (node?.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-')) {
    node = node.argument;
  }
  return node?.type === 'Literal' && typeof node.value === 'number';
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
    function check(name, value) {
      if ((name === 'confidence' || name?.endsWith('CONFIDENCE')) && isNumericLiteral(value)) {
        context.report({ node: value, messageId: 'useEdgeConfidence', data: { name } });
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
        if (node.operator !== '=') return;
        const target = node.left;
        const name =
          target.type === 'MemberExpression'
            ? propertyName(target.property, target.computed)
            : propertyName(target);
        check(name, node.right);
      },
    };
  },
};
