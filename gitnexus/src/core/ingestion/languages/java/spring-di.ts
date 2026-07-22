import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { makeScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { createSpringAnnotationNameResolver } from '../../frameworks/spring/bean-candidates.js';
import { SPRING_BEAN_STEREOTYPES } from '../../frameworks/spring/bean-catalog.js';
import {
  parseSpringInjectionType,
  SPRING_DI_CAPTURED_FIELD_PROPERTY,
  SPRING_DI_INJECTION_SITES_PROPERTY,
  SPRING_DI_PROVIDER_PROPERTY,
} from '../../di-extractors/spring.js';
import type { DiInjectionMatch, DiProviderMatch } from '../../di-extractors/index.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { getJavaSpringDiFacts } from './capture-side-channel.js';

export interface JavaAnnotationSyntaxFact {
  readonly name: string;
  readonly text: string;
}

export interface JavaSpringDependencyFact {
  readonly name: string;
  readonly rawType: string;
  readonly annotations: readonly JavaAnnotationSyntaxFact[];
}

export interface JavaSpringInjectionSiteFact {
  readonly kind: 'field' | 'constructor' | 'method';
  readonly memberName: string;
  readonly implicitConstructor: boolean;
  readonly annotations: readonly JavaAnnotationSyntaxFact[];
  readonly dependencies: readonly JavaSpringDependencyFact[];
}

export interface JavaSpringDiClassFact {
  readonly classScopeId: ScopeId;
  readonly classAnnotations: readonly JavaAnnotationSyntaxFact[];
  readonly injectionSites: readonly JavaSpringInjectionSiteFact[];
}

const INJECTION_ANNOTATIONS = new Map([
  ['org.springframework.beans.factory.annotation.Autowired', true],
  ['jakarta.inject.Inject', true],
  ['javax.inject.Inject', true],
]);

const QUALIFIER_ANNOTATIONS = new Map([
  ['org.springframework.beans.factory.annotation.Qualifier', true],
  ['jakarta.inject.Named', true],
  ['javax.inject.Named', true],
]);

const PRIMARY_ANNOTATIONS = new Map([['org.springframework.context.annotation.Primary', true]]);

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
  [...SPRING_BEAN_STEREOTYPES.keys()].map((name) => name.slice(name.lastIndexOf('.') + 1)),
);

function annotationSimpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

function annotationFacts(node: SyntaxNode): JavaAnnotationSyntaxFact[] {
  const facts: JavaAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'modifiers') continue;
    for (const modifier of child.namedChildren) {
      if (modifier.type !== 'marker_annotation' && modifier.type !== 'annotation') continue;
      const nameNode = modifier.childForFieldName('name') ?? modifier.firstNamedChild;
      if (nameNode === null) continue;
      facts.push({ name: nameNode.text.trim(), text: modifier.text.trim() });
    }
  }
  return facts;
}

function hasRelevantAnnotation(annotations: readonly JavaAnnotationSyntaxFact[]): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_ANNOTATIONS.has(annotationSimpleName(annotation.name)),
  );
}

function hasStereotypeSyntax(annotations: readonly JavaAnnotationSyntaxFact[]): boolean {
  return annotations.some((annotation) =>
    STEREOTYPE_SIMPLE_NAMES.has(annotationSimpleName(annotation.name)),
  );
}

function dependenciesOf(callable: SyntaxNode): JavaSpringDependencyFact[] {
  const parameters = callable.childForFieldName('parameters');
  if (parameters === null) return [];
  const dependencies: JavaSpringDependencyFact[] = [];
  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== 'formal_parameter' && parameter.type !== 'spread_parameter') continue;
    const nameNode = parameter.childForFieldName('name');
    const typeNode = parameter.childForFieldName('type');
    if (nameNode === null || typeNode === null) continue;
    dependencies.push({
      name: nameNode.text.trim(),
      rawType: typeNode.text.trim(),
      annotations: annotationFacts(parameter),
    });
  }
  return dependencies;
}

/** Capture Spring-relevant Java syntax while the worker already owns the AST. */
export function captureJavaSpringDiFacts(
  root: SyntaxNode,
  filePath: string,
): readonly JavaSpringDiClassFact[] {
  const facts: JavaSpringDiClassFact[] = [];
  for (const classNode of root.descendantsOfType('class_declaration')) {
    const body = classNode.childForFieldName('body');
    if (body === null) continue;
    const classAnnotations = annotationFacts(classNode);
    const injectionSites: JavaSpringInjectionSiteFact[] = [];

    const constructors = body.namedChildren.filter(
      (child) => child.type === 'constructor_declaration',
    );
    for (const constructor of constructors) {
      const annotations = annotationFacts(constructor);
      const implicitConstructor =
        constructors.length === 1 &&
        hasStereotypeSyntax(classAnnotations) &&
        !hasRelevantAnnotation(annotations);
      if (!implicitConstructor && !hasRelevantAnnotation(annotations)) continue;
      injectionSites.push({
        kind: 'constructor',
        memberName: constructor.childForFieldName('name')?.text.trim() ?? '<constructor>',
        implicitConstructor,
        annotations,
        dependencies: dependenciesOf(constructor),
      });
    }

    for (const member of body.namedChildren) {
      if (member.type === 'field_declaration') {
        const annotations = annotationFacts(member);
        if (!hasRelevantAnnotation(annotations)) continue;
        const typeNode = member.childForFieldName('type');
        if (typeNode === null) continue;
        for (const declarator of member.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const nameNode = declarator.childForFieldName('name');
          if (nameNode === null) continue;
          injectionSites.push({
            kind: 'field',
            memberName: nameNode.text.trim(),
            implicitConstructor: false,
            annotations,
            dependencies: [
              {
                name: nameNode.text.trim(),
                rawType: typeNode.text.trim(),
                annotations,
              },
            ],
          });
        }
      } else if (member.type === 'method_declaration') {
        const annotations = annotationFacts(member);
        if (!hasRelevantAnnotation(annotations)) continue;
        injectionSites.push({
          kind: 'method',
          memberName: member.childForFieldName('name')?.text.trim() ?? '<method>',
          implicitConstructor: false,
          annotations,
          dependencies: dependenciesOf(member),
        });
      }
    }

    if (injectionSites.length === 0 && !hasRelevantAnnotation(classAnnotations)) continue;
    const classCapture = nodeToCapture('@spring-di.class', classNode);
    facts.push({
      classScopeId: makeScopeId({ filePath, range: classCapture.range, kind: 'Class' }),
      classAnnotations,
      injectionSites,
    });
  }
  return facts;
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
  if (className.length < 2 || className[1] !== className[1].toUpperCase()) {
    return className[0].toLowerCase() + className.slice(1);
  }
  return className;
}

/** Attach resolved, framework-private DI metadata to Class nodes. */
export function attachJavaSpringDiMetadata(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): void {
  const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
  const propertiesByOwner = new Map<string, string[]>();
  for (const relationship of graph.iterRelationshipsByType('HAS_PROPERTY')) {
    const propertyIds = propertiesByOwner.get(relationship.sourceId) ?? [];
    propertyIds.push(relationship.targetId);
    propertiesByOwner.set(relationship.sourceId, propertyIds);
  }

  for (const parsed of parsedFiles) {
    const incomplete = isJavaPackageSiblingVisibilityIncomplete(parsed.filePath);
    for (const fact of getJavaSpringDiFacts(parsed.filePath)) {
      const classScope = indexes.scopeTree.getScope(fact.classScopeId);
      if (classScope === undefined || classScope.kind !== 'Class') continue;
      const classDef = classScope.ownedDefs.find((definition) => definition.type === 'Class');
      if (classDef === undefined) continue;
      const graphId = resolveDefGraphId(parsed.filePath, classDef, nodeLookup);
      if (graphId === undefined) continue;
      const classNode = graph.getNode(graphId);
      if (classNode === undefined || classNode.label !== 'Class') continue;

      const capturedFieldNames = new Set(
        fact.injectionSites.filter((site) => site.kind === 'field').map((site) => site.memberName),
      );
      for (const propertyId of propertiesByOwner.get(classNode.id) ?? []) {
        const property = graph.getNode(propertyId);
        if (property !== undefined && capturedFieldNames.has(property.properties.name)) {
          property.properties[SPRING_DI_CAPTURED_FIELD_PROPERTY] = true;
        }
      }

      const resolveFact = (
        annotation: JavaAnnotationSyntaxFact,
        recognized: { readonly has: (value: string) => boolean },
        enclosingScope: ScopeId | null = classScope.parent,
      ): string | undefined =>
        resolveAnnotation(annotation.name, parsed, enclosingScope, recognized, incomplete);

      const frameworkAnnotations = Array.isArray(classNode.properties.frameworkAnnotations)
        ? classNode.properties.frameworkAnnotations.filter(
            (annotation): annotation is string => typeof annotation === 'string',
          )
        : [];
      if (frameworkAnnotations.length > 0) {
        const names = new Set<string>();
        let explicitBeanName: string | undefined;
        let hasDynamicBeanName = false;
        for (const annotation of fact.classAnnotations) {
          if (resolveFact(annotation, SPRING_BEAN_STEREOTYPES) !== undefined) {
            if (annotation.text.includes('(')) {
              const staticName = staticStringArgument(annotation.text);
              if (staticName === undefined) hasDynamicBeanName = true;
              else explicitBeanName = staticName;
            }
          }
          if (resolveFact(annotation, QUALIFIER_ANNOTATIONS) !== undefined) {
            const qualifier = staticStringArgument(annotation.text);
            if (qualifier !== undefined) names.add(qualifier);
          }
        }
        if (explicitBeanName !== undefined) names.add(explicitBeanName);
        else if (!hasDynamicBeanName) names.add(defaultBeanName(classNode.properties.name));
        const provider: DiProviderMatch = {
          isBean: true,
          names: [...names],
          primary: fact.classAnnotations.some(
            (annotation) => resolveFact(annotation, PRIMARY_ANNOTATIONS) !== undefined,
          ),
        };
        classNode.properties[SPRING_DI_PROVIDER_PROPERTY] = provider;
      }

      const matches: DiInjectionMatch[] = [];
      for (const site of fact.injectionSites) {
        const injectionAnnotation = site.annotations.find(
          (annotation) =>
            resolveFact(annotation, INJECTION_ANNOTATIONS, classScope.id) !== undefined,
        );
        if (injectionAnnotation === undefined) {
          if (!site.implicitConstructor || frameworkAnnotations.length === 0) continue;
        }

        for (const dependency of site.dependencies) {
          const parsedType = parseSpringInjectionType(dependency.rawType);
          if (parsedType === null) continue;
          const qualifierAnnotation = dependency.annotations.find(
            (annotation) =>
              resolveFact(annotation, QUALIFIER_ANNOTATIONS, classScope.id) !== undefined,
          );
          const qualifier =
            qualifierAnnotation === undefined
              ? undefined
              : staticStringArgument(qualifierAnnotation.text);
          // A present-but-dynamic qualifier is not the same as no qualifier.
          // Without its value we cannot choose a provider honestly, so fail
          // closed instead of emitting the unqualified candidate set.
          if (qualifierAnnotation !== undefined && qualifier === undefined) continue;
          const trigger =
            injectionAnnotation === undefined
              ? 'constructor'
              : `@${annotationSimpleName(injectionAnnotation.name)} ${site.kind}`;
          const location =
            site.kind === 'field'
              ? site.memberName
              : `${site.memberName} parameter ${dependency.name}`;
          matches.push({
            targetTypeName: parsedType.targetTypeName,
            cardinality: parsedType.cardinality,
            ...(qualifier === undefined ? {} : { qualifier }),
            reason: `Spring DI: ${trigger} ${location}: ${parsedType.displayType}`,
          });
        }
      }
      if (matches.length > 0) classNode.properties[SPRING_DI_INJECTION_SITES_PROPERTY] = matches;
    }
  }
}
