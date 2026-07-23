import { makeScopeId, type ParsedFile, type ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { DiInjectionMatch, DiProviderMatch } from '../../di-extractors/index.js';
import {
  parseSpringInjectionType,
  SPRING_DI_CAPTURED_FIELD_PROPERTY,
  SPRING_DI_INJECTION_SITES_PROPERTY,
  SPRING_DI_PROVIDER_PROPERTY,
} from '../../di-extractors/spring.js';
import { createSpringAnnotationNameResolver } from '../../frameworks/spring/bean-candidates.js';
import { SPRING_BEAN_STEREOTYPES } from '../../frameworks/spring/bean-catalog.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getKotlinSpringDiFacts } from './capture-side-channel.js';
import { isKotlinPackageSiblingVisibilityIncomplete } from './package-siblings.js';

export interface KotlinAnnotationSyntaxFact {
  readonly name: string;
  readonly text: string;
  readonly useSiteTarget?: string;
}

export interface KotlinSpringDependencyFact {
  readonly name: string;
  readonly rawType: string;
  readonly annotations: readonly KotlinAnnotationSyntaxFact[];
}

export interface KotlinSpringInjectionSiteFact {
  readonly kind: 'property' | 'constructor' | 'method';
  readonly memberName: string;
  readonly implicitConstructor: boolean;
  readonly annotations: readonly KotlinAnnotationSyntaxFact[];
  readonly dependencies: readonly KotlinSpringDependencyFact[];
}

export interface KotlinSpringDiClassFact {
  readonly classScopeId: ScopeId;
  readonly classAnnotations: readonly KotlinAnnotationSyntaxFact[];
  readonly injectionSites: readonly KotlinSpringInjectionSiteFact[];
}

const INJECTION_ANNOTATIONS = new Set([
  'org.springframework.beans.factory.annotation.Autowired',
  'jakarta.inject.Inject',
  'javax.inject.Inject',
]);

const QUALIFIER_ANNOTATIONS = new Set([
  'org.springframework.beans.factory.annotation.Qualifier',
  'jakarta.inject.Named',
  'javax.inject.Named',
]);

const PRIMARY_ANNOTATIONS = new Set(['org.springframework.context.annotation.Primary']);

const RESOLVABLE_DI_ANNOTATIONS = new Set([
  ...SPRING_BEAN_STEREOTYPES.keys(),
  ...INJECTION_ANNOTATIONS,
  ...QUALIFIER_ANNOTATIONS,
  ...PRIMARY_ANNOTATIONS,
]);

const CAPTURE_RELEVANT_ANNOTATIONS = new Set([
  'Autowired',
  'Inject',
  'Qualifier',
  'Named',
  'Primary',
  'Component',
  'Service',
  'Repository',
  'Controller',
  'RestController',
  'Configuration',
]);

const STEREOTYPE_SIMPLE_NAMES = new Set(
  [...SPRING_BEAN_STEREOTYPES.keys()].map((name) => annotationSimpleName(name)),
);

const KOTLIN_TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type']);

function annotationSimpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

function firstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  const stack = [...node.namedChildren].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.type === type) return current;
    for (let index = current.namedChildren.length - 1; index >= 0; index--) {
      const child = current.namedChildren[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return undefined;
}

function annotationFact(annotation: SyntaxNode): KotlinAnnotationSyntaxFact | null {
  const nameNode = firstDescendantOfType(annotation, 'user_type');
  if (nameNode === undefined) return null;
  const useSiteTarget = annotation.namedChildren
    .find((child) => child.type === 'use_site_target')
    ?.text.replace(/:\s*$/, '')
    .trim();
  return {
    name: nameNode.text.trim(),
    text: annotation.text.trim(),
    ...(useSiteTarget === undefined || useSiteTarget.length === 0 ? {} : { useSiteTarget }),
  };
}

function annotationsFromModifierContainer(node: SyntaxNode): KotlinAnnotationSyntaxFact[] {
  const facts: KotlinAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'annotation') continue;
    const fact = annotationFact(child);
    if (fact !== null) facts.push(fact);
  }
  return facts;
}

function annotationFacts(node: SyntaxNode): KotlinAnnotationSyntaxFact[] {
  const facts: KotlinAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'modifiers' && child.type !== 'parameter_modifiers') continue;
    facts.push(...annotationsFromModifierContainer(child));
  }
  return facts;
}

function hasRelevantAnnotation(annotations: readonly KotlinAnnotationSyntaxFact[]): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_ANNOTATIONS.has(annotationSimpleName(annotation.name)),
  );
}

function hasStereotypeSyntax(annotations: readonly KotlinAnnotationSyntaxFact[]): boolean {
  return annotations.some((annotation) =>
    STEREOTYPE_SIMPLE_NAMES.has(annotationSimpleName(annotation.name)),
  );
}

function directTypeNode(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => KOTLIN_TYPE_NODES.has(child.type));
}

function parameterDependency(
  parameter: SyntaxNode,
  precedingAnnotations: readonly KotlinAnnotationSyntaxFact[] = [],
): KotlinSpringDependencyFact | null {
  const nameNode = parameter.namedChildren.find((child) => child.type === 'simple_identifier');
  const typeNode = directTypeNode(parameter);
  if (nameNode === undefined || typeNode === undefined) return null;
  return {
    name: nameNode.text.trim(),
    rawType: typeNode.text.trim(),
    annotations: [...precedingAnnotations, ...annotationFacts(parameter)],
  };
}

function functionDependencies(callable: SyntaxNode): KotlinSpringDependencyFact[] {
  const parameters = callable.namedChildren.find(
    (child) => child.type === 'function_value_parameters',
  );
  if (parameters === undefined) return [];
  const dependencies: KotlinSpringDependencyFact[] = [];
  let pendingAnnotations: KotlinAnnotationSyntaxFact[] = [];
  for (const child of parameters.namedChildren) {
    if (child.type === 'parameter_modifiers') {
      pendingAnnotations = annotationsFromModifierContainer(child);
      continue;
    }
    if (child.type !== 'parameter') continue;
    const dependency = parameterDependency(child, pendingAnnotations);
    pendingAnnotations = [];
    if (dependency !== null) dependencies.push(dependency);
  }
  return dependencies;
}

function primaryConstructorDependencies(constructor: SyntaxNode): KotlinSpringDependencyFact[] {
  const dependencies: KotlinSpringDependencyFact[] = [];
  for (const parameter of constructor.namedChildren) {
    if (parameter.type !== 'class_parameter') continue;
    const dependency = parameterDependency(parameter);
    if (dependency !== null) dependencies.push(dependency);
  }
  return dependencies;
}

function propertyDependency(property: SyntaxNode): KotlinSpringDependencyFact | null {
  const variable = property.namedChildren.find((child) => child.type === 'variable_declaration');
  if (variable === undefined) return null;
  const nameNode = variable.namedChildren.find((child) => child.type === 'simple_identifier');
  const typeNode = directTypeNode(variable);
  if (nameNode === undefined || typeNode === undefined) return null;
  const annotations = annotationFacts(property);
  return {
    name: nameNode.text.trim(),
    rawType: typeNode.text.trim(),
    annotations,
  };
}

function isKotlinBeanCandidateClass(classNode: SyntaxNode): boolean {
  if (classNode.children.some((child) => child.type === 'interface' || child.type === 'enum')) {
    return false;
  }
  const modifiers = classNode.namedChildren.find((child) => child.type === 'modifiers');
  return !modifiers?.namedChildren.some(
    (child) => child.type === 'class_modifier' && child.text.trim() === 'annotation',
  );
}

/**
 * Capture one class already surfaced by Kotlin's scope query. Kotlin-specific
 * syntax is normalized here while import/FQN semantics remain deferred until
 * post-resolution.
 */
export function captureKotlinSpringDiClassFact(
  classNode: SyntaxNode,
  filePath: string,
): KotlinSpringDiClassFact | null {
  if (!isKotlinBeanCandidateClass(classNode)) return null;
  const classAnnotations = annotationFacts(classNode);
  const injectionSites: KotlinSpringInjectionSiteFact[] = [];
  const body = classNode.namedChildren.find((child) => child.type === 'class_body');
  const primaryConstructor = classNode.namedChildren.find(
    (child) => child.type === 'primary_constructor',
  );
  const secondaryConstructors =
    body?.namedChildren.filter((child) => child.type === 'secondary_constructor') ?? [];
  const constructorCount =
    (primaryConstructor === undefined ? 0 : 1) + secondaryConstructors.length;

  if (primaryConstructor !== undefined) {
    const annotations = annotationFacts(primaryConstructor);
    const implicitConstructor =
      constructorCount === 1 &&
      hasStereotypeSyntax(classAnnotations) &&
      !hasRelevantAnnotation(annotations);
    if (implicitConstructor || hasRelevantAnnotation(annotations)) {
      injectionSites.push({
        kind: 'constructor',
        memberName: '<primary-constructor>',
        implicitConstructor,
        annotations,
        dependencies: primaryConstructorDependencies(primaryConstructor),
      });
    }
  }

  for (const constructor of secondaryConstructors) {
    const annotations = annotationFacts(constructor);
    const implicitConstructor =
      constructorCount === 1 &&
      hasStereotypeSyntax(classAnnotations) &&
      !hasRelevantAnnotation(annotations);
    if (!implicitConstructor && !hasRelevantAnnotation(annotations)) continue;
    injectionSites.push({
      kind: 'constructor',
      memberName: '<secondary-constructor>',
      implicitConstructor,
      annotations,
      dependencies: functionDependencies(constructor),
    });
  }

  if (body !== undefined) {
    for (const member of body.namedChildren) {
      if (member.type === 'property_declaration') {
        const annotations = annotationFacts(member);
        if (!hasRelevantAnnotation(annotations)) continue;
        const dependency = propertyDependency(member);
        if (dependency === null) continue;
        injectionSites.push({
          kind: 'property',
          memberName: dependency.name,
          implicitConstructor: false,
          annotations,
          dependencies: [dependency],
        });
      } else if (member.type === 'function_declaration') {
        const annotations = annotationFacts(member);
        if (!hasRelevantAnnotation(annotations)) continue;
        const name =
          member.namedChildren.find((child) => child.type === 'simple_identifier')?.text.trim() ??
          '<method>';
        injectionSites.push({
          kind: 'method',
          memberName: name,
          implicitConstructor: false,
          annotations,
          dependencies: functionDependencies(member),
        });
      }
    }
  }

  if (injectionSites.length === 0 && !hasRelevantAnnotation(classAnnotations)) return null;
  const classCapture = nodeToCapture('@spring-di.class', classNode);
  return {
    classScopeId: makeScopeId({ filePath, range: classCapture.range, kind: 'Class' }),
    classAnnotations,
    injectionSites,
  };
}

function staticStringArgument(annotationText: string): string | undefined {
  const args = annotationText.match(/\((.*)\)$/s)?.[1]?.trim();
  if (args === undefined) return undefined;
  const value = args.replace(/^value\s*=\s*/, '').trim();
  const literal = value.match(/^"((?:\\.|[^"\\])*)"$/s);
  if (literal === null) return undefined;
  try {
    return JSON.parse(`"${literal[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function defaultBeanName(className: string): string {
  if (className.length === 0) return className;
  if (
    className.length > 1 &&
    className[0] !== className[0].toLowerCase() &&
    className[1] !== className[1].toLowerCase()
  ) {
    return className;
  }
  return className[0].toLowerCase() + className.slice(1);
}

function isApplicableInjectionAnnotation(
  annotation: KotlinAnnotationSyntaxFact,
  site: KotlinSpringInjectionSiteFact,
): boolean {
  if (annotation.useSiteTarget === undefined) return true;
  if (site.kind === 'constructor') return annotation.useSiteTarget === 'constructor';
  if (site.kind === 'property') {
    return annotation.useSiteTarget === 'field' || annotation.useSiteTarget === 'set';
  }
  return false;
}

function isApplicableQualifierAnnotation(
  annotation: KotlinAnnotationSyntaxFact,
  site: KotlinSpringInjectionSiteFact,
): boolean {
  if (annotation.useSiteTarget === undefined) return true;
  if (site.kind === 'property') {
    return (
      annotation.useSiteTarget === 'field' ||
      annotation.useSiteTarget === 'param' ||
      annotation.useSiteTarget === 'setparam'
    );
  }
  return annotation.useSiteTarget === 'param';
}

function parseKotlinSpringInjectionType(rawType: string) {
  // Kotlin nullable suffixes, type projections, and mutable collection aliases
  // do not change the JVM bean type selected by Spring. Normalize only those
  // surface forms; stars, function types, arrays, and nested generic elements
  // still fail closed in the shared parser.
  const normalized = rawType
    .replace(/\bMutable(List|Set|Collection|Map)(?=\s*<)/g, '$1')
    .replace(/([<,])\s*(?:out|in)\s+/g, '$1')
    .replace(/\?(?=\s*(?:[>,]|$))/g, '');
  return parseSpringInjectionType(normalized);
}

/** Attach resolved, framework-private DI metadata to Kotlin Class nodes. */
export function attachKotlinSpringDiMetadata(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): void {
  const resolveAnnotation = createSpringAnnotationNameResolver(indexes);

  for (const parsed of parsedFiles) {
    const incomplete = isKotlinPackageSiblingVisibilityIncomplete(parsed.filePath);
    for (const fact of getKotlinSpringDiFacts(parsed.filePath)) {
      const classScope = indexes.scopeTree.getScope(fact.classScopeId);
      if (classScope === undefined || classScope.kind !== 'Class') continue;
      const classDef = classScope.ownedDefs.find((definition) => definition.type === 'Class');
      if (classDef === undefined) continue;
      const graphId = resolveDefGraphId(parsed.filePath, classDef, nodeLookup);
      if (graphId === undefined) continue;
      const classNode = graph.getNode(graphId);
      if (classNode === undefined || classNode.label !== 'Class') continue;

      const resolvedAnnotations = new Map<string, string | undefined>();
      const resolveFact = (
        annotation: KotlinAnnotationSyntaxFact,
        enclosingScope: ScopeId | null = classScope.parent,
      ): string | undefined => {
        const cacheKey = `${enclosingScope ?? '<root>'}\0${annotation.name}`;
        if (resolvedAnnotations.has(cacheKey)) return resolvedAnnotations.get(cacheKey);
        const resolved = resolveAnnotation(
          annotation.name,
          parsed,
          enclosingScope,
          RESOLVABLE_DI_ANNOTATIONS,
          incomplete,
        );
        resolvedAnnotations.set(cacheKey, resolved);
        return resolved;
      };

      const frameworkAnnotations = Array.isArray(classNode.properties.frameworkAnnotations)
        ? classNode.properties.frameworkAnnotations.filter(
            (annotation): annotation is string => typeof annotation === 'string',
          )
        : [];
      if (frameworkAnnotations.length > 0) {
        const names = new Set<string>();
        let explicitBeanName: string | undefined;
        let hasDynamicBeanName = false;
        let primary = false;
        for (const annotation of fact.classAnnotations) {
          const resolved = resolveFact(annotation);
          if (resolved === undefined) continue;
          if (SPRING_BEAN_STEREOTYPES.has(resolved)) {
            const argumentText = annotation.text.match(/\((.*)\)$/s)?.[1]?.trim();
            if (argumentText !== undefined && argumentText.length > 0) {
              const staticName = staticStringArgument(annotation.text);
              if (staticName === undefined) hasDynamicBeanName = true;
              else if (staticName.length > 0) explicitBeanName = staticName;
            }
          }
          if (QUALIFIER_ANNOTATIONS.has(resolved)) {
            const qualifier = staticStringArgument(annotation.text);
            if (qualifier !== undefined) names.add(qualifier);
          }
          if (PRIMARY_ANNOTATIONS.has(resolved)) primary = true;
        }
        if (explicitBeanName !== undefined) names.add(explicitBeanName);
        else if (!hasDynamicBeanName) names.add(defaultBeanName(classNode.properties.name));
        const provider: DiProviderMatch = {
          names: [...names],
          ...(primary ? { preferenceReason: 'selected @Primary' } : {}),
        };
        classNode.properties[SPRING_DI_PROVIDER_PROPERTY] = provider;
      }

      const matches: DiInjectionMatch[] = [];
      const semanticallyOwnedPropertyNames = new Set<string>();
      for (const site of fact.injectionSites) {
        let injectionAnnotation: KotlinAnnotationSyntaxFact | undefined;
        for (const annotation of site.annotations) {
          if (!isApplicableInjectionAnnotation(annotation, site)) continue;
          const resolved = resolveFact(annotation, classScope.id);
          if (resolved !== undefined && INJECTION_ANNOTATIONS.has(resolved)) {
            injectionAnnotation = annotation;
            break;
          }
        }
        if (injectionAnnotation === undefined) {
          if (!site.implicitConstructor || frameworkAnnotations.length === 0) continue;
        } else if (site.kind === 'property') {
          semanticallyOwnedPropertyNames.add(site.memberName);
        }

        for (const dependency of site.dependencies) {
          const parsedType = parseKotlinSpringInjectionType(dependency.rawType);
          if (parsedType === null) continue;
          let qualifierAnnotation: KotlinAnnotationSyntaxFact | undefined;
          for (const annotation of dependency.annotations) {
            if (!isApplicableQualifierAnnotation(annotation, site)) continue;
            const resolved = resolveFact(annotation, classScope.id);
            if (resolved !== undefined && QUALIFIER_ANNOTATIONS.has(resolved)) {
              qualifierAnnotation = annotation;
              break;
            }
          }
          const qualifier =
            qualifierAnnotation === undefined
              ? undefined
              : staticStringArgument(qualifierAnnotation.text);
          if (qualifierAnnotation !== undefined && qualifier === undefined) continue;
          const trigger =
            injectionAnnotation === undefined
              ? 'constructor'
              : `@${annotationSimpleName(injectionAnnotation.name)} ${site.kind}`;
          const location =
            site.kind === 'property'
              ? site.memberName
              : `${site.memberName} parameter ${dependency.name}`;
          matches.push({
            targetTypeName: parsedType.targetTypeName,
            cardinality: parsedType.cardinality,
            ...(qualifier === undefined
              ? {}
              : {
                  namedSelection: {
                    name: qualifier,
                    reason: `qualifier "${qualifier}"`,
                  },
                }),
            reason: `Spring DI: ${trigger} ${location}: ${parsedType.displayType}`,
          });
        }
      }
      if (matches.length > 0) classNode.properties[SPRING_DI_INJECTION_SITES_PROPERTY] = matches;

      for (const propertyName of semanticallyOwnedPropertyNames) {
        for (const { def } of classScope.bindings.get(propertyName) ?? []) {
          if (def.ownerId !== classDef.nodeId) continue;
          const propertyId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
          if (propertyId === undefined) continue;
          const property = graph.getNode(propertyId);
          if (property?.label === 'Property') {
            property.properties[SPRING_DI_CAPTURED_FIELD_PROPERTY] = true;
          }
        }
      }
    }
  }
}
