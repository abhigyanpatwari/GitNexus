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
import { parseSpringInjectionType } from '../../di-extractors/spring.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { getJavaSpringDiFacts } from './capture-side-channel.js';

export type JavaAnnotationSyntaxFact = SpringDiAnnotationFact;

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
  const classAnnotations = annotationFacts(classNode);
  const injectionSites: JavaSpringInjectionSiteFact[] = [];

  const constructors = body.namedChildren.filter(
    (child) => child.type === 'constructor_declaration',
  );
  for (const constructor of constructors) {
    const annotations = annotationFacts(constructor);
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
      const annotations = annotationFacts(member);
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
      const annotations = annotationFacts(member);
      if (!hasSpringDiRelevantAnnotation(annotations)) continue;
      injectionSites.push({
        kind: 'method',
        memberName: member.childForFieldName('name')?.text.trim() ?? '<method>',
        implicitConstructor: false,
        annotations,
        dependencies: dependenciesOf(member),
      });
    }
  }

  if (injectionSites.length === 0 && !hasSpringDiRelevantAnnotation(classAnnotations)) return null;
  const classCapture = nodeToCapture('@spring-di.class', classNode);
  return {
    classScopeId: makeScopeId({ filePath, range: classCapture.range, kind: 'Class' }),
    classAnnotations,
    injectionSites,
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
