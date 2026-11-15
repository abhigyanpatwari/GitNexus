import type { SyntaxNode } from '../../utils/ast-helpers.js';

const wildcardsByTree = new WeakMap<object, boolean>();
const defaultsByTree = new WeakMap<object, boolean>();

export function setDartDefaultLanguageVersion(node: SyntaxNode, version: string): void {
  const [major, minor] = version.split('.').map(Number);
  defaultsByTree.set(node.tree, major! > 3 || (major === 3 && minor! >= 7));
  wildcardsByTree.delete(node.tree);
}

/** The capture grammar targets Dart 3.7+. A leading language-version override
 * preserves older `_` parameter/local semantics. Patterns always remain wildcards.
 */
export function dartUsesWildcardVariables(node: SyntaxNode): boolean {
  const tree = node.tree;
  const cached = wildcardsByTree.get(tree);
  if (cached !== undefined) return cached;
  let enabled = defaultsByTree.get(tree) ?? true;
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'script_tag') continue;
    if (child.type !== 'comment' && child.type !== 'documentation_comment') break;
    const version = /^\/\/\s*@dart\s*=\s*(\d+)\.(\d+)\s*$/.exec(child.text);
    if (version !== null) {
      enabled = Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 7);
      break;
    }
  }
  wildcardsByTree.set(tree, enabled);
  return enabled;
}
