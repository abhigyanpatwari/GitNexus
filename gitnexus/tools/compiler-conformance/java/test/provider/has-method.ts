import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { findEnclosingClassId } from '../../../../../src/core/ingestion/utils/ast-helpers.js';

function parseCode(language: any, code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(code);
}

/** Find the first descendant node matching a predicate (BFS). */
function findNode(
  root: Parser.SyntaxNode,
  predicate: (n: Parser.SyntaxNode) => boolean,
): Parser.SyntaxNode | null {
  const queue: Parser.SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (predicate(node)) return node;
    for (let i = 0; i < node.childCount; i++) {
      queue.push(node.child(i)!);
    }
  }
  return null;
}

describe('findEnclosingClassId', () => {
  describe('Java', () => {
    it('finds enclosing class for a method', () => {
      const tree = parseCode(
        Java,
        `
class UserService {
  public void save(User user) {}
}
`,
      );
      const methodNode = findNode(tree.rootNode, (n) => n.type === 'method_declaration');
      assert.notEqual(methodNode, null);

      const nameNode = findNode(methodNode!, (n) => n.type === 'identifier' && n.text === 'save');
      assert.notEqual(nameNode, null);

      const result = findEnclosingClassId(nameNode!, 'test/UserService.java');
      assert.equal(result, 'Class:test/UserService.java:UserService');
    });

    it('finds enclosing interface for a method', () => {
      const tree = parseCode(
        Java,
        `
interface Repository {
  void findById(int id);
}
`,
      );
      const methodNode = findNode(tree.rootNode, (n) => n.type === 'method_declaration');
      assert.notEqual(methodNode, null);

      const nameNode = findNode(
        methodNode!,
        (n) => n.type === 'identifier' && n.text === 'findById',
      );
      assert.notEqual(nameNode, null);

      const result = findEnclosingClassId(nameNode!, 'test/Repository.java');
      assert.equal(result, 'Interface:test/Repository.java:Repository');
    });
  });
});
