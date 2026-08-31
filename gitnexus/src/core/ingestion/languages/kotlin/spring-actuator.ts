import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import type {
  DefinitionPropertiesContext,
  RuntimeCallableIdentity,
  RuntimeSymbolStrategy,
} from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const RUNTIME_OWNER_ALIASES = 'runtimeOwnerAliases';
const RUNTIME_CALLABLE_ALIASES = 'runtimeCallableAliases';
const KOTLIN_SUSPEND = 'kotlinSuspend';

function rootNode(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function packageName(root: SyntaxNode): string {
  const header = root.namedChildren.find((child) => child.type === 'package_header');
  return header?.text.replace(/^package\s+/, '').trim() ?? '';
}

function qualify(packageNameValue: string, simpleName: string): string {
  return packageNameValue.length === 0 ? simpleName : `${packageNameValue}.${simpleName}`;
}

function standardFacadeName(filePath: string): string {
  const stem = path.basename(filePath).replace(/\.(?:kt|kts)$/i, '');
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}Kt`;
}

function annotationJvmName(source: string, target = ''): string | undefined {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = target.length === 0 ? '' : `${escapedTarget}:`;
  return new RegExp(`@${prefix}JvmName\\s*\\(\\s*["']([^"']+)["']\\s*\\)`).exec(source)?.[1];
}

function hasEnclosingType(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'object_declaration' ||
      current.type === 'companion_object'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** Transient graph metadata used only by the same analysis run's runtime import. */
export function extractKotlinRuntimeSymbolProperties(
  context: DefinitionPropertiesContext,
): Readonly<Record<string, unknown>> | undefined {
  const properties: Record<string, unknown> = {};
  const source = context.definitionNode.text;

  if (
    (context.nodeLabel === 'Function' || context.nodeLabel === 'Method') &&
    context.definitionNode.type === 'function_declaration'
  ) {
    if (/\bsuspend\b/.test(source.slice(0, source.indexOf('fun') + 3))) {
      properties[KOTLIN_SUSPEND] = true;
    }
    const callableJvmName = annotationJvmName(source);
    if (callableJvmName !== undefined) {
      properties[RUNTIME_CALLABLE_ALIASES] = [callableJvmName];
    }
    if (!hasEnclosingType(context.definitionNode)) {
      const root = rootNode(context.definitionNode);
      const pkg = packageName(root);
      const customFacade = annotationJvmName(root.text, 'file');
      properties[RUNTIME_OWNER_ALIASES] = [
        qualify(pkg, customFacade ?? standardFacadeName(context.filePath)),
      ];
    }
  } else if (context.nodeLabel === 'Property') {
    const getterJvmName = annotationJvmName(source, 'get');
    if (getterJvmName !== undefined) {
      properties[RUNTIME_CALLABLE_ALIASES] = [getterJvmName];
    }
  }

  return Object.keys(properties).length === 0 ? undefined : properties;
}

function stringArrayProperty(node: GraphNode, property: string): readonly string[] {
  const value = node.properties[property];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function callableNames(node: GraphNode): readonly string[] {
  return [String(node.properties.name), ...stringArrayProperty(node, RUNTIME_CALLABLE_ALIASES)];
}

function propertyGetterNames(node: GraphNode): readonly string[] {
  const name = String(node.properties.name);
  const capitalized = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return [
    name.startsWith('is') && name.length > 2 && /[A-Z]/.test(name.charAt(2))
      ? name
      : `get${capitalized}`,
    ...stringArrayProperty(node, RUNTIME_CALLABLE_ALIASES),
  ];
}

function sourceCallableName(runtimeName: string): string {
  return runtimeName.endsWith('$default') ? runtimeName.slice(0, -'$default'.length) : runtimeName;
}

function matchesKotlinCallable(node: GraphNode, runtime: RuntimeCallableIdentity): boolean {
  const runtimeName = sourceCallableName(runtime.name);
  if (node.label === 'Property') {
    const names = propertyGetterNames(node);
    if (!names.includes(runtime.name) && !names.includes(runtimeName)) return false;
  } else if (!callableNames(node).includes(runtimeName)) {
    return false;
  }

  const parameterCount = node.properties.parameterCount;
  const descriptorTypes = runtime.descriptorParameterTypes;
  if (
    typeof parameterCount !== 'number' ||
    descriptorTypes === undefined ||
    runtime.name.endsWith('$default')
  ) {
    return true;
  }
  if (parameterCount === descriptorTypes.length) return true;
  return (
    node.properties[KOTLIN_SUSPEND] === true &&
    parameterCount + 1 === descriptorTypes.length &&
    descriptorTypes.at(-1) === 'kotlin/coroutines/Continuation'
  );
}

export const kotlinRuntimeSymbolStrategy: RuntimeSymbolStrategy = {
  callableOwnerAliases(node, owner) {
    const aliases = [...stringArrayProperty(node, RUNTIME_OWNER_ALIASES)];
    const ownerName = owner?.properties.qualifiedName;
    if (typeof ownerName === 'string') {
      aliases.push(ownerName);
      if (node.properties.isStatic === true && !ownerName.endsWith('.Companion')) {
        aliases.push(`${ownerName}.Companion`);
      }
    }
    return aliases;
  },

  matchesCallable: matchesKotlinCallable,
};
