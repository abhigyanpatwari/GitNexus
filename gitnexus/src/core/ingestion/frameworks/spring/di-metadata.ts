import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { DiInjectionMatch, DiProviderMatch } from '../../di-extractors/index.js';
import {
  parseSpringInjectionType,
  SPRING_DI_CAPTURED_FIELD_PROPERTY,
  SPRING_DI_INJECTION_SITES_PROPERTY,
  SPRING_DI_PROVIDER_PROPERTY,
} from '../../di-extractors/spring.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { createSpringAnnotationNameResolver } from './bean-candidates.js';
import { SPRING_BEAN_STEREOTYPES } from './bean-catalog.js';

export interface SpringDiAnnotationFact {
  readonly name: string;
  readonly text: string;
}

export interface SpringDiDependencyFact<Annotation extends SpringDiAnnotationFact> {
  readonly name: string;
  readonly rawType: string;
  readonly annotations: readonly Annotation[];
}

export interface SpringDiInjectionSiteFact<
  Annotation extends SpringDiAnnotationFact,
  SiteKind extends string,
> {
  readonly kind: SiteKind;
  readonly memberName: string;
  readonly implicitConstructor: boolean;
  readonly annotations: readonly Annotation[];
  readonly dependencies: readonly SpringDiDependencyFact<Annotation>[];
}

export interface SpringDiClassFact<
  Annotation extends SpringDiAnnotationFact,
  SiteKind extends string,
> {
  readonly classScopeId: ScopeId;
  readonly classAnnotations: readonly Annotation[];
  readonly injectionSites: readonly SpringDiInjectionSiteFact<Annotation, SiteKind>[];
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
  [...SPRING_BEAN_STEREOTYPES.keys()].map((name) => springAnnotationSimpleName(name)),
);

export function springAnnotationSimpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

export function hasSpringDiRelevantAnnotation(
  annotations: readonly SpringDiAnnotationFact[],
): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_ANNOTATIONS.has(springAnnotationSimpleName(annotation.name)),
  );
}

export function hasSpringStereotypeSyntax(annotations: readonly SpringDiAnnotationFact[]): boolean {
  return annotations.some((annotation) =>
    STEREOTYPE_SIMPLE_NAMES.has(springAnnotationSimpleName(annotation.name)),
  );
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

type ParsedSpringInjectionType = NonNullable<ReturnType<typeof parseSpringInjectionType>>;

export interface SpringDiMetadataAdapter<
  Annotation extends SpringDiAnnotationFact,
  SiteKind extends string,
> {
  getFacts(filePath: string): readonly SpringDiClassFact<Annotation, SiteKind>[];
  isPackageVisibilityIncomplete(filePath: string): boolean;
  parseInjectionType(rawType: string): ParsedSpringInjectionType | null;
  capturedMemberKind: SiteKind;
  isInjectionAnnotationApplicable?(
    annotation: Annotation,
    site: SpringDiInjectionSiteFact<Annotation, SiteKind>,
  ): boolean;
  isQualifierAnnotationApplicable?(
    annotation: Annotation,
    site: SpringDiInjectionSiteFact<Annotation, SiteKind>,
  ): boolean;
}

/**
 * Build the post-resolution Spring DI metadata hook shared by language adapters.
 * Language adapters retain syntax capture, type normalization, use-site rules,
 * and side-channel ownership; this function owns framework semantics only.
 */
export function createSpringDiMetadataAttacher<
  Annotation extends SpringDiAnnotationFact,
  SiteKind extends string,
>(adapter: SpringDiMetadataAdapter<Annotation, SiteKind>) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const resolveAnnotation = createSpringAnnotationNameResolver(indexes);

    for (const parsed of parsedFiles) {
      const incomplete = adapter.isPackageVisibilityIncomplete(parsed.filePath);
      for (const fact of adapter.getFacts(parsed.filePath)) {
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
          annotation: Annotation,
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
        const semanticallyOwnedMemberNames = new Set<string>();
        for (const site of fact.injectionSites) {
          let injectionAnnotation: Annotation | undefined;
          for (const annotation of site.annotations) {
            if (adapter.isInjectionAnnotationApplicable?.(annotation, site) === false) continue;
            const resolved = resolveFact(annotation, classScope.id);
            if (resolved !== undefined && INJECTION_ANNOTATIONS.has(resolved)) {
              injectionAnnotation = annotation;
              break;
            }
          }
          if (injectionAnnotation === undefined) {
            if (!site.implicitConstructor || frameworkAnnotations.length === 0) continue;
          } else if (site.kind === adapter.capturedMemberKind) {
            // Claim the member only after its injection annotation resolves to
            // a recognized FQN. Ambiguous wildcard imports stay unclaimed so
            // the legacy collection matcher can fall back. A dynamic qualifier
            // later fails closed, but this path still owns the member and must
            // suppress that legacy fallback.
            semanticallyOwnedMemberNames.add(site.memberName);
          }

          for (const dependency of site.dependencies) {
            const parsedType = adapter.parseInjectionType(dependency.rawType);
            if (parsedType === null) continue;
            let qualifierAnnotation: Annotation | undefined;
            for (const annotation of dependency.annotations) {
              if (adapter.isQualifierAnnotationApplicable?.(annotation, site) === false) continue;
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
            // A present-but-dynamic qualifier is not the same as no qualifier.
            // Without its value we cannot choose a provider honestly, so fail
            // closed instead of emitting the unqualified candidate set.
            if (qualifierAnnotation !== undefined && qualifier === undefined) continue;
            const trigger =
              injectionAnnotation === undefined
                ? 'constructor'
                : `@${springAnnotationSimpleName(injectionAnnotation.name)} ${site.kind}`;
            const location =
              site.kind === adapter.capturedMemberKind
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
        if (matches.length > 0) {
          classNode.properties[SPRING_DI_INJECTION_SITES_PROPERTY] = matches;
        }

        for (const memberName of semanticallyOwnedMemberNames) {
          for (const { def } of classScope.bindings.get(memberName) ?? []) {
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
  };
}
