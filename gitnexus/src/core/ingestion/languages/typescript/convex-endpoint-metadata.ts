import type { ParsedImport } from 'gitnexus-shared';
import type { DefinitionPropertiesContext } from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const CONVEX_ENDPOINT_FACTORIES: ReadonlySet<string> = new Set([
  'query',
  'mutation',
  'action',
  'internalQuery',
  'internalMutation',
  'internalAction',
]);

const isConvexServerModule = (targetRaw: string): boolean => {
  const normalized = targetRaw.replace(/\\/g, '/').replace(/\.(?:[cm]?[jt]s)$/, '');
  return normalized === 'convex/server' || /^(?:\.\.?\/)+_generated\/server$/.test(normalized);
};

function importedConvexFactory(
  imports: readonly ParsedImport[],
  localName: string,
): string | undefined {
  for (const parsedImport of imports) {
    if (parsedImport.kind !== 'named' && parsedImport.kind !== 'alias') continue;
    if (parsedImport.localName !== localName || !isConvexServerModule(parsedImport.targetRaw)) {
      continue;
    }
    return CONVEX_ENDPOINT_FACTORIES.has(parsedImport.importedName)
      ? parsedImport.importedName
      : undefined;
  }
  return undefined;
}

function findDeclarator(node: SyntaxNode, nodeName: string): SyntaxNode | undefined {
  if (node.type === 'variable_declarator' && node.childForFieldName('name')?.text === nodeName) {
    return node;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = findDeclarator(child, nodeName);
    if (found) return found;
  }
  return undefined;
}

/**
 * Stamp Convex runtime-dispatch metadata only when both the declaration shape
 * and the factory import provenance are known. The MCP layer consumes the
 * resulting property without reparsing lossy FTS text.
 */
export function extractConvexEndpointProperties(
  context: DefinitionPropertiesContext,
): Readonly<Record<string, unknown>> | undefined {
  if (context.nodeLabel !== 'Const' || !context.isExported) return undefined;

  const declarator = findDeclarator(context.definitionNode, context.nodeName);
  const value = declarator?.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;

  const callee = value.childForFieldName('function');
  if (!callee || callee.type !== 'identifier') return undefined;
  const factory = importedConvexFactory(context.parsedImports, callee.text);
  if (factory === undefined) return undefined;

  const args = value.childForFieldName('arguments');
  if (!args || args.namedChild(0)?.type !== 'object') return undefined;
  return { convexEndpointFactory: factory };
}
