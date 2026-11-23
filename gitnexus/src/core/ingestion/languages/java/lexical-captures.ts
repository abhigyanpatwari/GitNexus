import type Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { javaTrailingDimensions, javaTypeText } from './type-spelling.js';

type SyntaxNode = Parser.SyntaxNode;

/** A lambda is a lexical block, not an instance/class boundary. Its unknown
 * parameters still own their names and must hide same-named outer fields. */
export function synthesizeJavaLexicalCaptures(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const lambda of root.descendantsOfType('lambda_expression')) {
    const parameters = lambda.childForFieldName('parameters');
    if (parameters === null) continue;
    const names: SyntaxNode[] = [];
    const declarations = parameters.type === 'identifier' ? [parameters] : parameters.namedChildren;
    for (const parameter of declarations) {
      const name =
        parameter.type === 'identifier'
          ? parameter
          : (parameter.childForFieldName('name') ??
            parameter.namedChildren
              .find((child) => child.type === 'variable_declarator')
              ?.childForFieldName('name') ??
            null);
      if (name === null || name.isMissing || name.type !== 'identifier') continue;
      names.push(name);
      out.push(declarationCapture(name));
      const type =
        parameter.childForFieldName('type') ??
        (parameter.type === 'spread_parameter'
          ? (parameter.namedChildren.find(
              (child) => child.type !== 'modifiers' && child.type !== 'variable_declarator',
            ) ?? null)
          : null);
      if (type !== null && type.text !== 'var' && !type.hasError) {
        out.push(typeCapture(name, type, '@type-binding.parameter', parameter));
      }
    }
    out.push(lexicalScope(lambda, lambda, names));
  }

  for (const statement of root.descendantsOfType('try_with_resources_statement')) {
    const specification = statement.childForFieldName('resources');
    const body = statement.childForFieldName('body');
    if (specification === null || body === null) continue;
    for (const resource of specification.namedChildren) {
      if (resource.type !== 'resource') continue;
      const name = resource.childForFieldName('name');
      const type = resource.childForFieldName('type');
      // `try (existing)` is an expression use, not a declaration.
      if (name === null || type === null || name.isMissing || name.type !== 'identifier') continue;
      // A resource begins owning its name in its own initializer. One nested
      // tail scope per declaration additionally keeps later resource names out
      // of preceding initializers. Every scope ends before catch/finally.
      out.push(lexicalScope(resource, body, [name]), declarationCapture(name));
      if (type.text !== 'var' && !type.hasError) {
        out.push(typeCapture(name, type, '@type-binding.annotation', resource));
        continue;
      }
      let value = resource.childForFieldName('value');
      while (value?.type === 'parenthesized_expression') value = value.namedChildren[0] ?? null;
      if (value?.type === 'object_creation_expression') {
        const constructedType = value.childForFieldName('type');
        if (constructedType !== null && !constructedType.hasError) {
          out.push(typeCapture(name, constructedType, '@type-binding.constructor'));
        }
      } else if (value?.type === 'identifier' || value?.type === 'field_access') {
        out.push(typeCapture(name, value, '@type-binding.alias'));
      } else if (value?.type === 'method_invocation') {
        // Preserve the selected call identity, including receiver/overload;
        // a file-wide method-name return table cannot prove this assignment.
        out.push({
          '@call-result-assignment.call': nodeToCapture('@call-result-assignment.call', value),
          '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
        });
      }
    }
  }
  return out;
}

function declarationCapture(name: SyntaxNode): CaptureMatch {
  return {
    '@declaration.variable': nodeToCapture('@declaration.variable', name),
    '@declaration.name': nodeToCapture('@declaration.name', name),
  };
}

function lexicalScope(
  start: SyntaxNode,
  end: SyntaxNode,
  names: readonly SyntaxNode[],
): CaptureMatch {
  const scope: Capture = {
    ...nodeToCapture('@scope.block', start),
    range: {
      startLine: start.startPosition.row + 1,
      startCol: start.startPosition.column,
      endLine: end.endPosition.row + 1,
      endCol: end.endPosition.column,
    },
  };
  return {
    '@scope.block': scope,
    '@scope.lexical-names': {
      ...scope,
      name: '@scope.lexical-names',
      text: JSON.stringify(names.map((name) => name.text)),
    },
  };
}

function typeCapture(
  name: SyntaxNode,
  type: SyntaxNode,
  tag: string,
  declaration?: SyntaxNode,
): CaptureMatch {
  const spelling =
    javaTypeText(type) +
    javaTrailingDimensions(declaration) +
    (declaration?.type === 'spread_parameter' ? '[]' : '');
  return {
    // The name lies strictly inside the synthetic Block: it is not a return
    // binding whose equal-range anchor should hoist to the enclosing scope.
    [tag]: nodeToCapture(tag, name),
    '@type-binding.name': nodeToCapture('@type-binding.name', name),
    '@type-binding.type': { ...nodeToCapture('@type-binding.type', type), text: spelling },
  };
}
