import type Parser from 'tree-sitter';

/**
 * Known response-returning method names.
 * Matches: NextResponse.json({...}), Response.json({...}), res.json({...})
 */
const JSON_METHOD_NAMES = new Set(['json']);

/**
 * Extract top-level keys from response object literals in a syntax tree node.
 * Looks for .json({key1, key2: value}) patterns and returns the key names.
 *
 * Returns null if no response pattern found, or string[] of top-level keys.
 */
export function extractResponseKeys(node: Parser.SyntaxNode): string[] | null {
  const keys: string[] = [];

  // Walk the tree looking for call expressions like .json({...})
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      const args = n.childForFieldName('arguments');

      // Check for member expression: *.json(...)
      if (fn?.type === 'member_expression') {
        const property = fn.childForFieldName('property');
        if (property && JSON_METHOD_NAMES.has(property.text)) {
          // Get first argument
          if (args && args.namedChildCount > 0) {
            const firstArg = args.namedChildren[0];
            if (firstArg?.type === 'object') {
              for (const child of firstArg.namedChildren) {
                if (child.type === 'pair') {
                  const key = child.childForFieldName('key');
                  if (key) keys.push(key.text);
                } else if (child.type === 'shorthand_property_identifier') {
                  keys.push(child.text);
                }
              }
            }
          }
        }
      }
    }

    for (const child of n.namedChildren) {
      walk(child);
    }
  };

  walk(node);
  return keys.length > 0 ? [...new Set(keys)] : null;
}
