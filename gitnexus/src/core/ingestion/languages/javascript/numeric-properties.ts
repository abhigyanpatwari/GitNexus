import { compileFunction } from 'node:vm';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { javascriptFileAllowsLegacyNumericKeys } from './parse-context.js';

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
      // Parse once with Node's CommonJS parameters. V8 checks directive
      // prologues, class strictness and module-only syntax without running code.
      compileFunction(node.tree.rootNode.text, [
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
      ]);
      valid = true;
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
