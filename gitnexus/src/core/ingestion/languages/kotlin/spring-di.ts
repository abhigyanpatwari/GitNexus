import { makeScopeId } from 'gitnexus-shared';
import { parseSpringInjectionType } from '../../di-extractors/spring.js';
import type { SpringArgumentFact } from '../../frameworks/spring/argument-facts.js';
import {
  createSpringDiMetadataAttacher,
  hasSpringDiRelevantAnnotation,
  hasSpringStereotypeSyntax,
  type SpringDiAnnotationFact,
  type SpringDiClassFact,
  type SpringDiDependencyFact,
  type SpringDiInjectionSiteFact,
} from '../../frameworks/spring/di-metadata.js';
import {
  hasSpringBeanFactorySyntax,
  type SpringBeanFactoryMethodFact,
} from '../../frameworks/spring/bean-factories.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getKotlinSpringDiFacts } from './capture-side-channel.js';
import { isKotlinPackageSiblingVisibilityIncomplete } from './package-siblings.js';

export interface KotlinAnnotationSyntaxFact extends SpringDiAnnotationFact {
  readonly useSiteTarget?: string;
  readonly line: number;
  /** Present only for callers that opt in via `kotlinSpringAnnotationFacts`. */
  readonly args?: readonly SpringArgumentFact[];
}

/**
 * Options for `kotlinSpringAnnotationFacts`.
 *
 * Arguments are opt-in because DI captures every annotated constructor
 * parameter, property, and function in the repository; carrying their
 * arguments would grow the worker to main-thread side-channel payload for
 * facts that never read them.
 */
export interface KotlinSpringAnnotationFactOptions {
  readonly includeArguments?: boolean;
}

export type KotlinSpringDependencyFact = SpringDiDependencyFact<KotlinAnnotationSyntaxFact>;

type KotlinSpringInjectionSiteKind = 'property' | 'constructor' | 'method';

export type KotlinSpringInjectionSiteFact = SpringDiInjectionSiteFact<
  KotlinAnnotationSyntaxFact,
  KotlinSpringInjectionSiteKind
>;

export type KotlinSpringDiClassFact = SpringDiClassFact<
  KotlinAnnotationSyntaxFact,
  KotlinSpringInjectionSiteKind
>;
type KotlinSpringBeanFactoryMethodFact = SpringBeanFactoryMethodFact<KotlinAnnotationSyntaxFact>;

const KOTLIN_TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type']);

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

const KOTLIN_COMMENT_NODE_TYPES = new Set(['line_comment', 'multiline_comment']);

/**
 * Kotlin writes annotation arguments and call arguments with the same
 * `value_arguments` node, so one reader serves `@KafkaListener(topics = [...])`
 * and `kafkaTemplate.send(topic, payload)`.
 *
 * A named argument keeps its key; everything else — positional values, spreads,
 * collection literals, and interpolated strings — is kept as raw text, because
 * evaluating it would be resolution.
 */
export function kotlinValueArgumentFacts(valueArguments: SyntaxNode): SpringArgumentFact[] {
  const args: SpringArgumentFact[] = [];
  for (const argument of valueArguments.namedChildren) {
    if (argument.type !== 'value_argument') continue;
    const parts = argument.namedChildren.filter(
      (child) => !KOTLIN_COMMENT_NODE_TYPES.has(child.type),
    );
    const named = argument.children.some((child) => child.type === '=');
    const name = parts[0];
    const value = parts[1];
    if (named && parts.length === 2 && name !== undefined && value !== undefined) {
      args.push({ name: name.text.trim(), text: value.text.trim() });
      continue;
    }
    args.push({ text: argument.text.trim() });
  }
  return args;
}

/**
 * Arguments of one annotation, or `undefined` when it was written without an
 * argument list (`@Scheduled`); `@Scheduled()` yields `[]` instead.
 *
 * Only the annotation's FIRST `user_type` / `constructor_invocation` child is
 * read, which is the same element `annotationFact` names. That matters for the
 * multi-annotation form `@field:[Alpha Beta("x")]`, where naively taking the
 * first constructor invocation would hand Beta's arguments to Alpha.
 */
function kotlinAnnotationArgumentFacts(annotation: SyntaxNode): SpringArgumentFact[] | undefined {
  const named = annotation.namedChildren.find(
    (child) => child.type === 'user_type' || child.type === 'constructor_invocation',
  );
  if (named === undefined || named.type !== 'constructor_invocation') return undefined;
  const valueArguments = named.namedChildren.find((child) => child.type === 'value_arguments');
  if (valueArguments === undefined) return undefined;
  return kotlinValueArgumentFacts(valueArguments);
}

function annotationFact(
  annotation: SyntaxNode,
  options: KotlinSpringAnnotationFactOptions,
): KotlinAnnotationSyntaxFact | null {
  const nameNode = firstDescendantOfType(annotation, 'user_type');
  if (nameNode === undefined) return null;
  const useSiteTarget = annotation.namedChildren
    .find((child) => child.type === 'use_site_target')
    ?.text.replace(/:\s*$/, '')
    .trim();
  const args =
    options.includeArguments === true ? kotlinAnnotationArgumentFacts(annotation) : undefined;
  return {
    name: nameNode.text.trim(),
    text: annotation.text.trim(),
    line: annotation.startPosition.row + 1,
    ...(useSiteTarget === undefined || useSiteTarget.length === 0 ? {} : { useSiteTarget }),
    ...(args === undefined ? {} : { args }),
  };
}

function annotationsFromModifierContainer(
  node: SyntaxNode,
  options: KotlinSpringAnnotationFactOptions = {},
): KotlinAnnotationSyntaxFact[] {
  const facts: KotlinAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'annotation') continue;
    const fact = annotationFact(child, options);
    if (fact !== null) facts.push(fact);
  }
  return facts;
}

export function kotlinSpringAnnotationFacts(
  node: SyntaxNode,
  options: KotlinSpringAnnotationFactOptions = {},
): KotlinAnnotationSyntaxFact[] {
  const facts: KotlinAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'modifiers' && child.type !== 'parameter_modifiers') continue;
    facts.push(...annotationsFromModifierContainer(child, options));
  }
  return facts;
}

function directTypeNode(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => KOTLIN_TYPE_NODES.has(child.type));
}

function kotlinBeanFactoryReturnType(functionNode: SyntaxNode): string | undefined {
  const parametersIndex = functionNode.namedChildren.findIndex(
    (child) => child.type === 'function_value_parameters',
  );
  if (parametersIndex === -1) return undefined;
  const afterParameters = functionNode.namedChildren.slice(parametersIndex + 1);
  const explicit = afterParameters.find((child) => KOTLIN_TYPE_NODES.has(child.type));
  if (explicit !== undefined) return explicit.text.trim();

  const body = afterParameters.find((child) => !KOTLIN_TYPE_NODES.has(child.type));
  if (body === undefined) return undefined;
  const call =
    body.type === 'call_expression' ? body : firstDescendantOfType(body, 'call_expression');
  const callee = call?.namedChildren.find((child) => child.type === 'simple_identifier');
  const inferred = callee?.text.trim();
  return inferred !== undefined && /^[A-Z_$]/.test(inferred) ? inferred : undefined;
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
    annotations: [...precedingAnnotations, ...kotlinSpringAnnotationFacts(parameter)],
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
  const annotations = kotlinSpringAnnotationFacts(property);
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
  const classAnnotations = kotlinSpringAnnotationFacts(classNode);
  const injectionSites: KotlinSpringInjectionSiteFact[] = [];
  const beanFactoryMethods: KotlinSpringBeanFactoryMethodFact[] = [];
  const body = classNode.namedChildren.find((child) => child.type === 'class_body');
  const primaryConstructor = classNode.namedChildren.find(
    (child) => child.type === 'primary_constructor',
  );
  const secondaryConstructors =
    body?.namedChildren.filter((child) => child.type === 'secondary_constructor') ?? [];
  const constructorCount =
    (primaryConstructor === undefined ? 0 : 1) + secondaryConstructors.length;

  if (primaryConstructor !== undefined) {
    const annotations = kotlinSpringAnnotationFacts(primaryConstructor);
    const implicitConstructor =
      constructorCount === 1 &&
      hasSpringStereotypeSyntax(classAnnotations) &&
      !hasSpringDiRelevantAnnotation(annotations);
    if (implicitConstructor || hasSpringDiRelevantAnnotation(annotations)) {
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
    const annotations = kotlinSpringAnnotationFacts(constructor);
    const implicitConstructor =
      constructorCount === 1 &&
      hasSpringStereotypeSyntax(classAnnotations) &&
      !hasSpringDiRelevantAnnotation(annotations);
    if (!implicitConstructor && !hasSpringDiRelevantAnnotation(annotations)) continue;
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
        const annotations = kotlinSpringAnnotationFacts(member);
        if (!hasSpringDiRelevantAnnotation(annotations)) continue;
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
        const annotations = kotlinSpringAnnotationFacts(member);
        const name =
          member.namedChildren.find((child) => child.type === 'simple_identifier')?.text.trim() ??
          '<method>';
        const factoryAnnotations = annotations.filter(
          (annotation) => annotation.useSiteTarget === undefined,
        );
        const beanFactory = hasSpringBeanFactorySyntax(factoryAnnotations);
        if (beanFactory) {
          const callableCapture = nodeToCapture('@spring-bean.factory', member);
          const returnType = kotlinBeanFactoryReturnType(member);
          beanFactoryMethods.push({
            callableScopeId: makeScopeId({
              filePath,
              range: callableCapture.range,
              kind: 'Function',
            }),
            methodName: name,
            ...(returnType === undefined ? {} : { returnType }),
            annotations: factoryAnnotations,
            dependencies: functionDependencies(member),
          });
        }
        // @Bean parameters are already represented on the factory Method. Do not
        // also attach them to the owning configuration Class when the method has
        // an otherwise relevant annotation such as @Autowired or @Qualifier.
        if (beanFactory) continue;
        if (!hasSpringDiRelevantAnnotation(annotations)) continue;
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

  if (
    injectionSites.length === 0 &&
    beanFactoryMethods.length === 0 &&
    !hasSpringDiRelevantAnnotation(classAnnotations)
  ) {
    return null;
  }
  const classCapture = nodeToCapture('@spring-di.class', classNode);
  return {
    classScopeId: makeScopeId({ filePath, range: classCapture.range, kind: 'Class' }),
    classAnnotations,
    injectionSites,
    ...(beanFactoryMethods.length === 0 ? {} : { beanFactoryMethods }),
  };
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

function isApplicableFactoryQualifierAnnotation(annotation: KotlinAnnotationSyntaxFact): boolean {
  return annotation.useSiteTarget === undefined || annotation.useSiteTarget === 'param';
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
export const attachKotlinSpringDiMetadata = createSpringDiMetadataAttacher<
  KotlinAnnotationSyntaxFact,
  KotlinSpringInjectionSiteKind
>({
  getFacts: getKotlinSpringDiFacts,
  isPackageVisibilityIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
  parseInjectionType: parseKotlinSpringInjectionType,
  capturedMemberKind: 'property',
  isInjectionAnnotationApplicable: isApplicableInjectionAnnotation,
  isQualifierAnnotationApplicable: isApplicableQualifierAnnotation,
  isFactoryQualifierAnnotationApplicable: isApplicableFactoryQualifierAnnotation,
});
