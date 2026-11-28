import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { javascriptFileAllowsLegacyNumericKeys } from './parse-context.js';

const require = createRequire(import.meta.url);
const validCommonJs = new WeakMap<SyntaxNode['tree'], boolean>();

/** Only reached for a leading-zero spelling outside the standard numeric grammar. */
export function legacyNumericPropertyValue(
  node: SyntaxNode,
  filePath: string,
  spelling: string,
): number | undefined {
  if (!javascriptFileAllowsLegacyNumericKeys(filePath, node.tree)) return undefined;
  let valid = validCommonJs.get(node.tree);
  if (valid === undefined) {
    try {
      const root = node.tree.rootNode;
      if (
        filePath.endsWith('.jsx') &&
        root.descendantsOfType(['jsx_element', 'jsx_self_closing_element']).length
      ) {
        // JSX needs its own grammar. The CommonJS goal still enforces strict directives and class bodies.
        const { parse } = require('@babel/parser') as typeof import('@babel/parser');
        parse(root.text, { sourceType: 'commonjs', plugins: ['jsx'] });
      } else {
        compileFunction(root.text, ['exports', 'require', 'module', '__filename', '__dirname']);
      }
      // Node 22 accepts legacy numerics in computed class keys and heritage.
      // ECMAScript makes the entire class declaration or expression strict.
      valid = !root
        .descendantsOfType('number')
        .some(
          (number) => /^0\d/u.test(number.text) && number.closest(['class_declaration', 'class']),
        );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      valid = false;
    }
    validCommonJs.set(node.tree, valid);
  }
  if (!valid) return undefined;
  const unsigned = spelling.replace(/^[+-]/u, '').replaceAll('_', '');
  const value = Number(/^0[0-7]+$/u.test(unsigned) ? '0o' + unsigned : unsigned);
  return spelling.startsWith('-') ? -value : value;
}
