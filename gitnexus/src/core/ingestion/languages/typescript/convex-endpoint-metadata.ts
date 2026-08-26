import type { ParsedImport } from 'gitnexus-shared';
import type { DefinitionPropertiesContext } from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';

const GENERATED_ENDPOINT_FACTORIES: ReadonlySet<string> = new Set([
  'query',
  'mutation',
  'action',
  'internalQuery',
  'internalMutation',
  'internalAction',
  'httpAction',
]);

const GENERIC_ENDPOINT_FACTORIES: ReadonlyMap<string, string> = new Map(
  [...GENERATED_ENDPOINT_FACTORIES].map((factory) => [`${factory}Generic`, factory]),
);

const normalizeModuleTarget = (targetRaw: string): string =>
  targetRaw.replace(/\\/g, '/').replace(/\.(?:[cm]?[jt]s)$/, '');

const isGeneratedServerModule = (targetRaw: string): boolean =>
  /(?:^|\/)_generated\/server$/.test(normalizeModuleTarget(targetRaw));

function importedConvexFactory(
  imports: readonly ParsedImport[],
  localName: string,
): string | undefined {
  for (const parsedImport of imports) {
    if (parsedImport.kind !== 'named' && parsedImport.kind !== 'alias') continue;
    if (parsedImport.localName !== localName) continue;

    const target = normalizeModuleTarget(parsedImport.targetRaw);
    if (target === 'convex/server') {
      return GENERIC_ENDPOINT_FACTORIES.get(parsedImport.importedName);
    }
    if (isGeneratedServerModule(target)) {
      return GENERATED_ENDPOINT_FACTORIES.has(parsedImport.importedName)
        ? parsedImport.importedName
        : undefined;
    }
  }
  return undefined;
}

function matchingDeclarator(node: SyntaxNode, nodeName: string): SyntaxNode | undefined {
  if (node.type === 'variable_declarator' && node.childForFieldName('name')?.text === nodeName) {
    return node;
  }

  if (node.type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    return declaration ? matchingDeclarator(declaration, nodeName) : undefined;
  }
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
    return undefined;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child?.type === 'variable_declarator' &&
      child.childForFieldName('name')?.text === nodeName
    ) {
      return child;
    }
  }
  return undefined;
}

function findDeclarator(node: SyntaxNode, nodeName: string): SyntaxNode | undefined {
  let current: SyntaxNode | null = node;
  while (current) {
    const declarator = matchingDeclarator(current, nodeName);
    if (declarator) return declarator;
    if (current.type === 'program' || current.type === 'statement_block') break;
    current = current.parent;
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
  if ((context.nodeLabel !== 'Const' && context.nodeLabel !== 'Function') || !context.isExported) {
    return undefined;
  }

  const declarator = findDeclarator(context.definitionNode, context.nodeName);
  const value = declarator?.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;

  const callee = value.childForFieldName('function');
  if (!callee || callee.type !== 'identifier') return undefined;
  const factory = importedConvexFactory(context.parsedImports, callee.text);
  if (factory === undefined) return undefined;

  const args = value.childForFieldName('arguments');
  if (!args || args.namedChildCount !== 1) return undefined;
  const endpointDefinition = args.namedChild(0);
  if (
    !endpointDefinition ||
    !['object', 'arrow_function', 'function_expression'].includes(endpointDefinition.type)
  ) {
    return undefined;
  }
  return assertCloneable({ convexEndpointFactory: factory });
}
