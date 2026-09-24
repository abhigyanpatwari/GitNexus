import type { GraphRelationship, ScopeId } from 'gitnexus-shared';
import { parseSpringAnnotationArguments, parseStaticStringValues } from './annotation-arguments.js';
import type { SpringDiAnnotationFact, SpringDiDependencyFact } from './di-metadata.js';

export const SPRING_BEAN_ANNOTATION = 'org.springframework.context.annotation.Bean';
export const SPRING_BEAN_DECLARATION_ID_PREFIX = 'CodeElement:spring-bean:';
export const SPRING_BEAN_FACTORY_REASON_PREFIX = 'spring-bean-factory:';

export interface SpringBeanFactoryMethodFact<
  Annotation extends SpringDiAnnotationFact = SpringDiAnnotationFact,
> {
  readonly callableScopeId: ScopeId;
  readonly methodName: string;
  readonly returnType?: string;
  readonly annotations: readonly Annotation[];
  readonly dependencies: readonly SpringDiDependencyFact<Annotation>[];
}

export interface SpringBeanFactoryDeclaration {
  readonly names: readonly string[];
  readonly namesKnown: boolean;
  readonly providedType?: string;
}

export interface SpringBeanFactoryMetadata {
  readonly framework: 'spring';
  readonly role: 'factory-method';
  readonly annotation: typeof SPRING_BEAN_ANNOTATION;
  readonly names: readonly string[];
  readonly providedType?: string;
}

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

export function hasSpringBeanFactorySyntax(
  annotations: readonly Pick<SpringDiAnnotationFact, 'name'>[],
): boolean {
  return annotations.some((annotation) => simpleName(annotation.name) === 'Bean');
}

/** Resolve statically readable Bean names; dynamic constants remain explicitly unknown. */
export function springBeanNames(
  annotationText: string,
  defaultMethodName: string,
): { readonly names: readonly string[]; readonly namesKnown: boolean } {
  const argumentsList = parseSpringAnnotationArguments(annotationText);
  if (argumentsList === null) return { names: [], namesKnown: false };
  const nameArguments = argumentsList.filter(
    (argument) =>
      argument.name === undefined || argument.name === 'name' || argument.name === 'value',
  );
  if (nameArguments.length === 0) return { names: [defaultMethodName], namesKnown: true };

  const names = new Set<string>();
  for (const argument of nameArguments) {
    const values = parseStaticStringValues(argument.value);
    if (values === null) return { names: [], namesKnown: false };
    for (const value of values) {
      if (value.length > 0) names.add(value);
    }
  }
  return {
    names: names.size === 0 ? [defaultMethodName] : [...names],
    namesKnown: true,
  };
}

export function encodeSpringBeanFactoryReason(declaration: SpringBeanFactoryDeclaration): string {
  return `${SPRING_BEAN_FACTORY_REASON_PREFIX}${JSON.stringify(declaration)}`;
}

export function decodeSpringBeanFactoryReason(
  reason: unknown,
): SpringBeanFactoryMetadata | undefined {
  if (typeof reason !== 'string' || !reason.startsWith(SPRING_BEAN_FACTORY_REASON_PREFIX)) {
    return undefined;
  }
  try {
    const value = JSON.parse(
      reason.slice(SPRING_BEAN_FACTORY_REASON_PREFIX.length),
    ) as Partial<SpringBeanFactoryDeclaration>;
    if (
      !Array.isArray(value.names) ||
      !value.names.every((name) => typeof name === 'string') ||
      typeof value.namesKnown !== 'boolean' ||
      (value.providedType !== undefined && typeof value.providedType !== 'string')
    ) {
      return undefined;
    }
    return {
      framework: 'spring',
      role: 'factory-method',
      annotation: SPRING_BEAN_ANNOTATION,
      names: value.names,
      ...(value.providedType === undefined ? {} : { providedType: value.providedType }),
    };
  } catch {
    return undefined;
  }
}

export function isSpringBeanFactoryDeclaration(
  relationship: Pick<GraphRelationship, 'type' | 'reason'>,
): boolean {
  return (
    relationship.type === 'DECLARES' &&
    relationship.reason.startsWith(SPRING_BEAN_FACTORY_REASON_PREFIX)
  );
}
