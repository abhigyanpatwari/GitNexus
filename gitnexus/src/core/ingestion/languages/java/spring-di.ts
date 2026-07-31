import { makeScopeId } from 'gitnexus-shared';
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
import { parseSpringInjectionType } from '../../di-extractors/spring.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { getJavaSpringDiFacts } from './capture-side-channel.js';

export interface JavaAnnotationSyntaxFact extends SpringDiAnnotationFact {
  readonly line: number;
}

export type JavaSpringDependencyFact = SpringDiDependencyFact<JavaAnnotationSyntaxFact>;

type JavaSpringInjectionSiteKind = 'field' | 'constructor' | 'method';

export type JavaSpringInjectionSiteFact = SpringDiInjectionSiteFact<
  JavaAnnotationSyntaxFact,
  JavaSpringInjectionSiteKind
>;

export type JavaSpringDiClassFact = SpringDiClassFact<
  JavaAnnotationSyntaxFact,
  JavaSpringInjectionSiteKind
>;
type JavaSpringBeanFactoryMethodFact = SpringBeanFactoryMethodFact<JavaAnnotationSyntaxFact>;

export function javaSpringAnnotationFacts(node: SyntaxNode): JavaAnnotationSyntaxFact[] {
  const facts: JavaAnnotationSyntaxFact[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'modifiers') continue;
    for (const modifier of child.namedChildren) {
      if (modifier.type !== 'marker_annotation' && modifier.type !== 'annotation') continue;
      const nameNode = modifier.childForFieldName('name') ?? modifier.firstNamedChild;
      if (nameNode === null) continue;
      facts.push({
        name: nameNode.text.trim(),
        text: modifier.text.trim(),
        line: modifier.startPosition.row + 1,
      });
    }
  }
  return facts;
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
      annotations: javaSpringAnnotationFacts(parameter),
    });
  }
  return dependencies;
}

/**
 * Capture one class already surfaced by Java's scope query.
 *
 * `captures.ts` calls this from its existing query-match traversal, so Spring
 * DI does not perform a second recursive walk from the AST root.
 */
export function captureJavaSpringDiClassFact(
  classNode: SyntaxNode,
  filePath: string,
): JavaSpringDiClassFact | null {
  const body = classNode.childForFieldName('body');
  if (body === null) return null;
  const classAnnotations = javaSpringAnnotationFacts(classNode);
  const injectionSites: JavaSpringInjectionSiteFact[] = [];
  const beanFactoryMethods: JavaSpringBeanFactoryMethodFact[] = [];

  const constructors = body.namedChildren.filter(
    (child) => child.type === 'constructor_declaration',
  );
  for (const constructor of constructors) {
    const annotations = javaSpringAnnotationFacts(constructor);
    const implicitConstructor =
      constructors.length === 1 &&
      hasSpringStereotypeSyntax(classAnnotations) &&
      !hasSpringDiRelevantAnnotation(annotations);
    if (!implicitConstructor && !hasSpringDiRelevantAnnotation(annotations)) continue;
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
      const annotations = javaSpringAnnotationFacts(member);
      if (!hasSpringDiRelevantAnnotation(annotations)) continue;
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
      const annotations = javaSpringAnnotationFacts(member);
      const memberName = member.childForFieldName('name')?.text.trim() ?? '<method>';
      const beanFactory = hasSpringBeanFactorySyntax(annotations);
      if (beanFactory) {
        const callableCapture = nodeToCapture('@spring-bean.factory', member);
        const returnType = member.childForFieldName('type')?.text.trim();
        beanFactoryMethods.push({
          callableScopeId: makeScopeId({
            filePath,
            range: callableCapture.range,
            kind: 'Function',
          }),
          methodName: memberName,
          ...(returnType === undefined ? {} : { returnType }),
          annotations,
          dependencies: dependenciesOf(member),
        });
      }
      // @Bean parameters are already represented on the factory Method. Do not
      // also attach them to the owning configuration Class when the method has
      // an otherwise relevant annotation such as @Autowired or @Qualifier.
      if (beanFactory) continue;
      if (!hasSpringDiRelevantAnnotation(annotations)) continue;
      injectionSites.push({
        kind: 'method',
        memberName,
        implicitConstructor: false,
        annotations,
        dependencies: dependenciesOf(member),
      });
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

/** Attach resolved, framework-private DI metadata to Class nodes. */
export const attachJavaSpringDiMetadata = createSpringDiMetadataAttacher<
  JavaAnnotationSyntaxFact,
  JavaSpringInjectionSiteKind
>({
  getFacts: getJavaSpringDiFacts,
  isPackageVisibilityIncomplete: isJavaPackageSiblingVisibilityIncomplete,
  parseInjectionType: parseSpringInjectionType,
  capturedMemberKind: 'field',
});
