import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import type { TypeImportAttribution } from '../../language-provider.js';
import { createParserForLanguage } from '../../../tree-sitter/parser-loader.js';
import { parseSourceSafe, ParseTimeoutError } from '../../../tree-sitter/safe-parse.js';
import { splitImportStatement } from './import-decomposer.js';
import { interpretPythonImport } from './interpret.js';
import { resolvePythonImportTarget, isPythonImportedModule } from './import-target.js';
import { pythonLiteralAll } from './module-accessors.js';
import { walkNamedNodes } from '../rename-tree-sitter.js';

async function importsClass(
  root: Parser.SyntaxNode,
  fromFile: string,
  importedPaths: ReadonlySet<string>,
  owner: string,
  className: string,
  wildcardExport: () => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  if (root.hasError) return undefined;
  const context = { fromFile, allFilePaths: importedPaths };
  const moduleAliases = new Map<string, Set<number>>();
  const receivers = new Map<string, Parser.SyntaxNode[]>();
  const otherBindings = new Set<string>();
  const importScope = (node: Parser.SyntaxNode): Parser.SyntaxNode => {
    while (
      node.parent &&
      !['function_definition', 'class_definition', 'lambda'].includes(node.type)
    )
      node = node.parent;
    return node;
  };
  let endOfImport = -1;
  let wildcard = false;
  for (const node of walkNamedNodes(root)) {
    // Visiting imports in syntax order lets us skip their child identifiers:
    // their bindings are accounted for by the provider's import decomposer.
    if (node.startIndex < endOfImport) continue;
    if (
      node.type === 'identifier' &&
      node.parent?.type !== 'attribute' &&
      node.parent?.type !== 'dotted_name' &&
      node.parent?.type !== 'keyword_argument'
    )
      otherBindings.add(node.text);
    if (node.type === 'attribute' && node.childForFieldName('attribute')?.text === className) {
      const receiver = node.childForFieldName('object')?.text;
      if (receiver) {
        const uses = receivers.get(receiver);
        if (uses) uses.push(node);
        else receivers.set(receiver, [node]);
      }
    }
    if (node.type !== 'import_statement' && node.type !== 'import_from_statement') continue;
    endOfImport = node.endIndex;
    for (const match of splitImportStatement(node)) {
      const imp = interpretPythonImport(match);
      if (!imp) continue;
      let alias: string | undefined;
      if (imp.kind === 'named' || imp.kind === 'alias') {
        if (
          imp.importedName === className &&
          resolvePythonImportTarget({ ...imp, targetIncludesImportedName: true }, context) === owner
        )
          return true;
        if (
          resolvePythonImportTarget(imp, context) === owner &&
          isPythonImportedModule(imp, owner, fromFile)
        )
          alias = imp.localName;
      } else if (imp.kind === 'namespace' && resolvePythonImportTarget(imp, context) === owner) {
        alias = imp.explicitAlias ? imp.localName : imp.targetRaw;
      } else if (imp.kind === 'wildcard' && resolvePythonImportTarget(imp, context) === owner) {
        wildcard = true;
      }
      if (alias) {
        const scopes = moduleAliases.get(alias);
        const scopeId = importScope(node).id;
        if (scopes) scopes.add(scopeId);
        else moduleAliases.set(alias, new Set([scopeId]));
      } else if ('localName' in imp) {
        otherBindings.add(imp.localName);
      }
    }
  }
  let uncertain = false;
  for (const [alias, scopes] of moduleAliases) {
    const uses = receivers.get(alias);
    if (!uses) continue;
    // Only admit a qualified use with a visible import and an unambiguous
    // receiver. Other bare uses may be bindings (a parameter, assignment, etc.).
    if (
      !otherBindings.has(alias.split('.')[0]) &&
      (scopes.has(root.id) || uses.some((use) => scopes.has(importScope(use).id)))
    )
      return true;
    uncertain = true;
  }
  if (wildcard) {
    const exported = await wildcardExport();
    if (exported !== false) return exported;
  }
  return uncertain ? undefined : false;
}

export const createPythonTypeImportClassifier: TypeImportAttribution['createClassifier'] = async ({
  ownerPath,
  name: className,
  readOwner,
}) => {
  const parser = await createParserForLanguage(SupportedLanguages.Python);
  const parseRoot = (source: string) => {
    try {
      return parseSourceSafe(parser, source).rootNode;
    } catch (error) {
      if (error instanceof ParseTimeoutError) return undefined;
      throw error;
    }
  };
  let wildcard: Promise<boolean | undefined> | undefined;
  const wildcardExport = async () => {
    const source = await readOwner();
    if (!source) return undefined;
    if (!source.includes('__all__')) return !className.startsWith('_');
    const root = parseRoot(source);
    if (!root || root.hasError) return undefined;
    const names = pythonLiteralAll(root);
    if (names !== undefined) return names.includes(className);
    // A mention in prose does not bind the export list. An identifier or
    // reflective key can refer to a list whose contents we cannot establish.
    const skipDocstring = (node: Parser.SyntaxNode) => {
      if (node.type !== 'expression_statement') return false;
      const value = node.firstNamedChild;
      return (
        value?.type === 'string' &&
        !value.namedChildren.some((child) => child.type === 'interpolation')
      );
    };
    for (const node of walkNamedNodes(root, skipDocstring)) {
      if (
        (node.type === 'identifier' || node.type === 'string_content') &&
        node.endIndex - node.startIndex === 7 &&
        node.text === '__all__'
      )
        return undefined;
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (
          fn?.type === 'identifier' &&
          fn.endIndex - fn.startIndex === 4 &&
          (fn.text === 'exec' || fn.text === 'eval')
        )
          return undefined;
      }
    }
    return !className.startsWith('_');
  };
  return (filePath, source, resolvedImports) => {
    const root = parseRoot(source);
    return root
      ? importsClass(
          root,
          filePath,
          resolvedImports,
          ownerPath,
          className,
          () => (wildcard ??= wildcardExport()),
        )
      : undefined;
  };
};
