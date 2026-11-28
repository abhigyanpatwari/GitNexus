/**
 * Symfony dependency-injection resolver for the generic `di` phase (#1857).
 *
 * Symfony (and most modern PHP apps) autowire constructor parameters by type.
 * When a consumer is type-hinted against an interface while the container
 * injects a concrete implementation — via an explicit `services.yaml` alias
 * or implicit autowiring — static CALLS/IMPLEMENTS edges alone leave the
 * concrete service looking orphaned to `impact()` / `context()`.
 *
 * This resolver:
 * - Treats PHP `__construct` Method nodes as injection sites (parameter type
 *   hints become `INJECTS` targets via the shared `di` phase).
 * - Treats concrete PHP Class nodes as providers.
 * - Honours `symfonyDiProvider` metadata stamped by `symfony-config` (explicit
 *   `Interface: '@Impl'` aliases → `preferenceReason` so multi-implementer
 *   cases resolve to the configured bean).
 *
 * Compiled-container XML resolution (full `bin/console debug:container`) is
 * intentionally out of scope for this first slice — YAML aliases + constructor
 * autowiring cover the issue's primary reproduction and match Spring's
 * graph-property approach.
 */

import type { GraphNode } from 'gitnexus-shared';
import type { DiInjectionMatch, DiProviderMatch, DiResolver } from './types.js';

export const SYMFONY_DI_PROVIDER_PROPERTY = 'symfonyDiProvider';
export const SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY = 'symfonyDiConstructorEnabled';

/** PHP scalar / special types that are never container-injected services. */
const PHP_NON_SERVICE_TYPES: ReadonlySet<string> = new Set([
  'string',
  'int',
  'integer',
  'float',
  'double',
  'bool',
  'boolean',
  'array',
  'iterable',
  'object',
  'mixed',
  'void',
  'null',
  'callable',
  'true',
  'false',
  'self',
  'static',
  'parent',
  'never',
]);

function isProviderMatch(value: unknown): value is DiProviderMatch {
  if (value === null || typeof value !== 'object') return false;
  const provider = value as Partial<DiProviderMatch>;
  return (
    Array.isArray(provider.names) &&
    provider.names.every((name) => typeof name === 'string') &&
    (provider.providedTypeName === undefined || typeof provider.providedTypeName === 'string') &&
    (provider.declaredByNodeId === undefined || typeof provider.declaredByNodeId === 'string') &&
    (provider.preferenceReason === undefined || typeof provider.preferenceReason === 'string') &&
    (provider.preferenceByType === undefined ||
      (typeof provider.preferenceByType === 'object' &&
        provider.preferenceByType !== null &&
        !Array.isArray(provider.preferenceByType) &&
        Object.values(provider.preferenceByType).every((reason) => typeof reason === 'string')))
  );
}

/**
 * Normalize a PHP parameter type into a DI target name.
 * Strips nullability (`?Foo`), leading `\`, and rejects scalars / unions.
 */
export function normalizeSymfonyInjectionType(raw: string): string | null {
  let type = raw.replace(/\s+/g, '').trim();
  if (type.length === 0) return null;
  // Unions / intersections are not a single injectible service type.
  if (type.includes('|') || type.includes('&')) return null;
  if (type.startsWith('?')) type = type.slice(1);
  if (type.startsWith('\\')) type = type.slice(1);
  if (type.length === 0) return null;
  const simple = type.includes('\\') ? type.slice(type.lastIndexOf('\\') + 1) : type;
  if (PHP_NON_SERVICE_TYPES.has(simple.toLowerCase())) return null;
  // Require a plausible class/interface name (allows FQCN with backslashes).
  if (!/^[A-Za-z_][A-Za-z0-9_\\]*$/.test(type)) return null;
  return type;
}

/**
 * Build injection matches from a PHP `__construct` Method node's parameterTypes.
 */
export function matchSymfonyConstructorInjections(node: GraphNode): readonly DiInjectionMatch[] {
  if (node.label !== 'Method') return [];
  if (node.properties.name.toLowerCase() !== '__construct') return [];
  const parameterTypes = node.properties.parameterTypes;
  if (!Array.isArray(parameterTypes) || parameterTypes.length === 0) return [];

  const matches: DiInjectionMatch[] = [];
  for (const raw of parameterTypes) {
    if (typeof raw !== 'string') continue;
    const targetTypeName = normalizeSymfonyInjectionType(raw);
    if (targetTypeName === null) continue;
    matches.push({
      targetTypeName,
      cardinality: 'single',
      edgeSource: 'owner-class',
      reason: `Symfony DI: constructor autowire ${targetTypeName}`,
    });
  }
  return matches;
}

/** Default provider metadata for a concrete PHP class. */
export function defaultSymfonyProvider(node: GraphNode): DiProviderMatch | null {
  if (node.label !== 'Class') return null;
  if (node.properties.isAbstract === true) return null;
  const name = node.properties.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const names = [name];
  const qualifiedName = node.properties.qualifiedName;
  if (typeof qualifiedName === 'string' && qualifiedName.length > 0) {
    names.push(qualifiedName);
  }
  return {
    names,
    providedTypeName: typeof qualifiedName === 'string' ? qualifiedName : name,
    declaredByNodeId: node.id,
  };
}

export const symfonyDiResolver: DiResolver = {
  matchInjectionSites(node): readonly DiInjectionMatch[] {
    if (node.properties[SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY] !== true) return [];
    return matchSymfonyConstructorInjections(node);
  },

  matchProvider(node): DiProviderMatch | null {
    const attached = node.properties[SYMFONY_DI_PROVIDER_PROPERTY];
    return isProviderMatch(attached) ? attached : null;
  },
};
